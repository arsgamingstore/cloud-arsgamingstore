// functions/lib/gateway.js
// Core logic for cloud-arsgamingstore: a Workers-native AI gateway.
// No dependencies, no Workers-only imports: runs on Workers AND Node 24
// (Request/Response/fetch/crypto.subtle are globals in both).
//
// Security rules baked in:
// - Provider API keys live ONLY in env (Pages Secrets). Never logged,
//   never returned to clients, never committed.
// - Gateway keys are stored as SHA-256 hashes in KV; the raw key is
//   shown exactly once at creation.
// - Without a KV binding the gateway refuses to serve (fail closed),
//   it never falls back to "allow all".

const KEY_PREFIX = "gwkey:";
const KEY_INDEX_PREFIX = "gwkeyid:";

// Hybrid keys (bot-sold packages): per-key upstream, never env providers.
const BOT_UPSTREAM_ALLOWLIST = ["https://arxpay.my.id", "https://rest-api.arsgaming.ai.id"];
const ARXPAYS_DEFAULT_MODELS = ["deepseek-v4.1-flash-uncensored", "glm-5.3-flash-uncensored"];
const HYBRID_OWNED_BY = "ArsRouter Proxy";

export function getProviders(env) {
  const byIndex = new Map();
  for (const [k, v] of Object.entries(env)) {
    const m = /^PROVIDER_(\d+)_(NAME|BASE_URL|API_KEY|MODELS)$/.exec(k);
    if (!m || typeof v !== "string") continue;
    const idx = Number(m[1]);
    if (!byIndex.has(idx)) byIndex.set(idx, {});
    byIndex.get(idx)[m[2]] = v;
  }
  const out = [];
  for (const idx of [...byIndex.keys()].sort((a, b) => a - b)) {
    const p = byIndex.get(idx);
    if (!p.NAME || !p.BASE_URL || !p.API_KEY) continue;
    out.push({
      name: p.NAME,
      baseUrl: p.BASE_URL.replace(/\/+$/, ""),
      apiKey: p.API_KEY,
      models: (p.MODELS || "").split(",").map((s) => s.trim()).filter(Boolean),
    });
  }
  return out;
}

export function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function err(code, message, status) {
  return json({ error: { code, message } }, status);
}

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  };
}

export function withCors(res) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

export function handleOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function bearer(request) {
  const h = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  return m ? m[1] : null;
}

export function requireAdmin(request, env) {
  if (!env.ADMIN_KEY) return err("admin_not_configured", "ADMIN_KEY is not set on the server.", 503);
  if (bearer(request) !== env.ADMIN_KEY) return err("unauthorized", "Invalid admin key.", 401);
  return null;
}

// Scoped bot credential: ONLY the bot key-creation endpoint accepts it.
// It can never list/delete keys or touch admin routes (those use ADMIN_KEY).
export function requireBot(request, env) {
  if (!env.BOT_SERVICE_KEY) return err("bot_not_configured", "BOT_SERVICE_KEY is not set on the server.", 503);
  if (bearer(request) !== env.BOT_SERVICE_KEY) return err("unauthorized", "Invalid bot service key.", 401);
  return null;
}

// Pure key lookup without quota enforcement or period reset (for /v1/models).
async function loadKeyRecord(env, token) {
  const kv = env.GATEWAY_KV;
  if (!kv || !token) return null;
  const hash = await sha256Hex(token);
  const raw = await kv.get(KEY_PREFIX + hash);
  return raw ? JSON.parse(raw) : null;
}

async function loadGatewayKey(env, token) {
  const kv = env.GATEWAY_KV;
  if (!kv) return { error: err("kv_not_bound", "GATEWAY_KV is not bound. Bind a KV namespace in Pages Settings.", 503) };
  if (!token) return { error: err("unauthorized", "Missing Authorization Bearer key.", 401) };
  const hash = await sha256Hex(token);
  const raw = await kv.get(KEY_PREFIX + hash);
  if (!raw) return { error: err("unauthorized", "Invalid gateway key.", 401) };
  const record = JSON.parse(raw);
  // Package keys (bot-sold token packages) never reset: their quota is a
  // one-time balance, not a monthly allowance. Monthly keys reset on UTC
  // month change, as before.
  if (record.quota_type !== "package") {
    const now = monthKey();
    if (record.period !== now) {
      record.used_tokens = 0;
      record.period = now;
      await kv.put(KEY_PREFIX + hash, JSON.stringify(record));
    }
  }
  if (record.used_tokens >= record.quota_tokens) {
    const msg = record.quota_type === "package"
      ? "Token package quota exceeded for this key."
      : "Monthly token quota exceeded for this key.";
    return { error: err("quota_exceeded", msg, 429) };
  }
  return { record, hash };
}

async function addUsage(env, hash, record, tokens) {
  if (!tokens || tokens <= 0) return;
  const kv = env.GATEWAY_KV;
  if (!kv) return;
  const fresh = await kv.get(KEY_PREFIX + hash);
  const rec = fresh ? JSON.parse(fresh) : record;
  rec.used_tokens = (rec.used_tokens || 0) + tokens;
  await kv.put(KEY_PREFIX + hash, JSON.stringify(rec));
}

function usageTokens(usage) {
  if (!usage) return 0;
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  return (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
}

export async function handleModels(env, request) {
  // Key-aware: a hybrid key (per-key upstream) sees ONLY its own models,
  // with owned_by masked to the gateway brand so the upstream never leaks
  // through /v1/models. No key / unknown key / plain key -> public list.
  if (request) {
    const record = await loadKeyRecord(env, bearer(request));
    if (record && record.upstream && Array.isArray(record.upstream.models)) {
      return json({
        object: "list",
        data: record.upstream.models.map((id) => ({ id, object: "model", owned_by: HYBRID_OWNED_BY })),
      });
    }
  }
  const seen = new Set();
  const data = [];
  for (const p of getProviders(env)) {
    for (const id of p.models) {
      if (seen.has(id)) continue;
      seen.add(id);
      data.push({ id, object: "model", owned_by: p.name });
    }
  }
  return json({ object: "list", data });
}

export function handleHealth(env) {
  const providers = getProviders(env);
  return json({
    status: "ok",
    kv_bound: Boolean(env.GATEWAY_KV),
    admin_configured: Boolean(env.ADMIN_KEY),
    providers: providers.length,
    models: providers.reduce((n, p) => n + p.models.length, 0),
  });
}

export async function handleChatCompletions(request, env, fetchImpl = fetch) {
  const auth = await loadGatewayKey(env, bearer(request));
  if (auth.error) return auth.error;
  const { record, hash } = auth;

  let body;
  try {
    body = await request.json();
  } catch {
    return err("invalid_request", "Request body must be valid JSON.", 400);
  }
  if (!body || typeof body.model !== "string") {
    return err("invalid_request", "Field 'model' is required.", 400);
  }
  // Hybrid key: route ONLY to the key's own upstream (its attached ArxPays
  // key). It must never fall back to env providers — a buyer key must not
  // spend the owner's River balance, and River models must 404 for it.
  let candidates;
  if (record.upstream && record.upstream.baseUrl && record.upstream.apiKey) {
    const up = record.upstream;
    candidates = [{
      name: "upstream",
      baseUrl: up.baseUrl.replace(/\/+$/, ""),
      apiKey: up.apiKey,
      models: Array.isArray(up.models) ? up.models : [],
    }].filter((p) => p.models.includes(body.model));
  } else {
    candidates = getProviders(env).filter((p) => p.models.includes(body.model));
  }
  if (candidates.length === 0) {
    return err("model_not_found", `No configured provider offers model '${body.model}'.`, 404);
  }

  const stream = body.stream === true;
  for (const provider of candidates) {
    let upstream;
    try {
      upstream = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify(body),
      });
    } catch {
      continue; // network error -> failover to next provider
    }
    if (upstream.status === 429 || upstream.status >= 500) {
      continue; // failover to next provider
    }
    if (!upstream.ok) {
      // Client error from provider: pass through as-is, no failover.
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
      });
    }
    if (!stream) {
      const data = await upstream.json();
      await addUsage(env, hash, record, usageTokens(data.usage));
      return json(data, 200);
    }
    // Streaming: forward bytes unchanged, watch for a usage chunk.
    // Accounting happens inside pull() BEFORE the stream closes, so a
    // consumer that reads to the end always sees the usage recorded.
    // shortcut: streaming usage is metered only when the provider
    // reports it (e.g. stream_options.include_usage); otherwise the
    // request is unmetered — documented in README as a v1 limit.
    let streamedUsage = 0;
    let accounted = false;
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";
    const inspectLine = (line) => {
      const t = line.trim();
      if (!t.startsWith("data:")) return;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      try {
        const u = usageTokens(JSON.parse(payload).usage);
        if (u > 0) streamedUsage = u;
      } catch { /* partial/non-JSON line: ignore */ }
    };
    const passthrough = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          if (lineBuf.trim()) inspectLine(lineBuf);
          controller.close();
          return;
        }
        controller.enqueue(value);
        lineBuf += decoder.decode(value, { stream: true });
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop();
        for (const line of lines) inspectLine(line);
        if (streamedUsage > 0 && !accounted) {
          accounted = true;
          await addUsage(env, hash, record, streamedUsage);
        }
      },
      async cancel() {
        try { await reader.cancel(); } catch { /* ignore */ }
      },
    });
    return new Response(passthrough, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }
  return err("all_providers_failed", "All providers for this model failed. Try again later.", 502);
}

// ---- admin: gateway keys ----

export async function listGatewayKeys(env) {
  const kv = env.GATEWAY_KV;
  if (!kv) return { error: err("kv_not_bound", "GATEWAY_KV is not bound.", 503) };
  const listed = await kv.list({ prefix: KEY_PREFIX });
  const out = [];
  for (const k of listed.keys) {
    const raw = await kv.get(k.name);
    if (!raw) continue;
    const r = JSON.parse(raw);
    out.push({
      id: r.id,
      name: r.name,
      quota_tokens: r.quota_tokens,
      used_tokens: r.used_tokens,
      period: r.period,
      quota_type: r.quota_type || "monthly",
      has_upstream: Boolean(r.upstream),
      created_at: r.created_at,
    });
  }
  out.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  return { keys: out };
}

export async function createGatewayKey(env, input, opts = {}) {
  const kv = env.GATEWAY_KV;
  if (!kv) return { error: err("kv_not_bound", "GATEWAY_KV is not bound.", 503) };
  const name = typeof input?.name === "string" ? input.name.trim().slice(0, 64) : "";
  if (!name) return { error: err("invalid_request", "Field 'name' is required.", 400) };
  const quota = input?.quota_tokens ?? 1000000;
  if (typeof quota !== "number" || !Number.isInteger(quota) || quota <= 0) {
    return { error: err("invalid_request", "Field 'quota_tokens' must be a positive integer.", 400) };
  }
  const quota_type = opts.allowPackage && input?.quota_type === "package" ? "package" : "monthly";
  // Per-key upstream: bot-created hybrid keys only (admin path passes no
  // opts, so upstream input is ignored there). The upstream API key is
  // stored raw in KV by necessity (the gateway must present it upstream);
  // it is NEVER returned in any response or listing.
  let upstream = null;
  if (opts.allowUpstream) {
    const apiKey = input?.upstream_api_key;
    if (typeof apiKey !== "string" || !apiKey) {
      return { error: err("invalid_request", "Field 'upstream_api_key' is required for a hybrid key.", 400) };
    }
    const baseUrl = (typeof input?.upstream_base_url === "string" && input.upstream_base_url
      ? input.upstream_base_url : BOT_UPSTREAM_ALLOWLIST[0]).replace(/\/+$/, "");
    if (!BOT_UPSTREAM_ALLOWLIST.includes(baseUrl)) {
      return { error: err("invalid_request", "upstream_base_url is not allowlisted.", 400) };
    }
    let models = input?.models;
    if (models === undefined) models = ARXPAYS_DEFAULT_MODELS;
    if (!Array.isArray(models) || models.length === 0 || models.length > 20
      || models.some((m) => typeof m !== "string" || !m)) {
      return { error: err("invalid_request", "Field 'models' must be a non-empty array of model ids.", 400) };
    }
    upstream = { baseUrl, apiKey, models };
  }
  const id = randomHex(6);
  const rawKey = `ca-${randomHex(16)}`;
  const hash = await sha256Hex(rawKey);
  const record = {
    id,
    name,
    key_hash: hash,
    quota_tokens: quota,
    used_tokens: 0,
    period: monthKey(),
    quota_type,
    created_at: new Date().toISOString(),
  };
  if (upstream) record.upstream = upstream;
  await kv.put(KEY_PREFIX + hash, JSON.stringify(record));
  await kv.put(KEY_INDEX_PREFIX + id, hash);
  return { created: { id, name, key: rawKey, quota_tokens: quota, quota_type } };
}

export async function deleteGatewayKey(env, id) {
  const kv = env.GATEWAY_KV;
  if (!kv) return { error: err("kv_not_bound", "GATEWAY_KV is not bound.", 503) };
  const hash = await kv.get(KEY_INDEX_PREFIX + id);
  if (!hash) return { error: err("not_found", `No key with id '${id}'.`, 404) };
  await kv.delete(KEY_PREFIX + hash);
  await kv.delete(KEY_INDEX_PREFIX + id);
  return { deleted: id };
}

export async function usageReport(env) {
  const listed = await listGatewayKeys(env);
  if (listed.error) return listed;
  const keys = listed.keys;
  const providers = getProviders(env).map((p) => ({ name: p.name, models: p.models.length }));
  return {
    keys,
    totals: {
      keys: keys.length,
      quota_tokens: keys.reduce((n, k) => n + k.quota_tokens, 0),
      used_tokens: keys.reduce((n, k) => n + k.used_tokens, 0),
    },
    providers,
  };
}
