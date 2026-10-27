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

async function loadGatewayKey(env, token) {
  const kv = env.GATEWAY_KV;
  if (!kv) return { error: err("kv_not_bound", "GATEWAY_KV is not bound. Bind a KV namespace in Pages Settings.", 503) };
  if (!token) return { error: err("unauthorized", "Missing Authorization Bearer key.", 401) };
  const hash = await sha256Hex(token);
  const raw = await kv.get(KEY_PREFIX + hash);
  if (!raw) return { error: err("unauthorized", "Invalid gateway key.", 401) };
  const record = JSON.parse(raw);
  const now = monthKey();
  if (record.period !== now) {
    record.used_tokens = 0;
    record.period = now;
    await kv.put(KEY_PREFIX + hash, JSON.stringify(record));
  }
  if (record.used_tokens >= record.quota_tokens) {
    return { error: err("quota_exceeded", "Monthly token quota exceeded for this key.", 429) };
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

export function handleModels(env) {
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
  const candidates = getProviders(env).filter((p) => p.models.includes(body.model));
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
      created_at: r.created_at,
    });
  }
  out.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  return { keys: out };
}

export async function createGatewayKey(env, input) {
  const kv = env.GATEWAY_KV;
  if (!kv) return { error: err("kv_not_bound", "GATEWAY_KV is not bound.", 503) };
  const name = typeof input?.name === "string" ? input.name.trim().slice(0, 64) : "";
  if (!name) return { error: err("invalid_request", "Field 'name' is required.", 400) };
  const quota = input?.quota_tokens ?? 1000000;
  if (typeof quota !== "number" || !Number.isInteger(quota) || quota <= 0) {
    return { error: err("invalid_request", "Field 'quota_tokens' must be a positive integer.", 400) };
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
    created_at: new Date().toISOString(),
  };
  await kv.put(KEY_PREFIX + hash, JSON.stringify(record));
  await kv.put(KEY_INDEX_PREFIX + id, hash);
  return { created: { id, name, key: rawKey, quota_tokens: quota } };
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
