// test/gateway.test.mjs — logika gateway, tanpa jaringan, tanpa wrangler.
// Dijalankan: node --test test/
// KV palsu (Map) + fetch stub; tidak ada key asli di sini.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getProviders,
  requireBot,
  sha256Hex,
  handleModels,
  handleHealth,
  handleChatCompletions,
  createGatewayKey,
  listGatewayKeys,
  deleteGatewayKey,
} from "../functions/lib/gateway.js";

class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix }) {
    const keys = [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

function baseEnv(kv) {
  return {
    ADMIN_KEY: "admin-secret",
    GATEWAY_KV: kv,
    PROVIDER_1_NAME: "gonkarouter",
    PROVIDER_1_BASE_URL: "https://api.gonkarouter.io/v1",
    PROVIDER_1_API_KEY: "prov-secret-1",
    PROVIDER_1_MODELS: "zai-org/GLM-5.3-Flash, model-shared",
    PROVIDER_2_NAME: "backup",
    PROVIDER_2_BASE_URL: "https://backup.example/v1/",
    PROVIDER_2_API_KEY: "prov-secret-2",
    PROVIDER_2_MODELS: "model-shared",
    PROVIDER_3_NAME: "incomplete-no-key",
    PROVIDER_3_BASE_URL: "https://x.example/v1",
  };
}

function chatReq(key, body) {
  return new Request("https://gw.test/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

async function makeGatewayKey(env) {
  const r = await createGatewayKey(env, { name: "test", quota_tokens: 1000 });
  assert.ok(r.created.key.startsWith("ca-"));
  return r.created.key;
}

test("getProviders: grouping, sorting, skip incomplete, strip trailing slash", () => {
  const ps = getProviders(baseEnv(null));
  assert.equal(ps.length, 2);
  assert.equal(ps[0].name, "gonkarouter");
  assert.equal(ps[1].baseUrl, "https://backup.example/v1");
  assert.deepEqual(ps[0].models, ["zai-org/GLM-5.3-Flash", "model-shared"]);
});

test("handleModels: dedupe across providers, no auth needed", async () => {
  const res = await handleModels(baseEnv(null));
  const data = await res.json();
  assert.equal(data.object, "list");
  assert.deepEqual(data.data.map((m) => m.id), ["zai-org/GLM-5.3-Flash", "model-shared"]);
});

test("handleHealth: reports binding state, no secrets", async () => {
  const data = await (await handleHealth(baseEnv(new FakeKV()))).json();
  assert.equal(data.status, "ok");
  assert.equal(data.kv_bound, true);
  assert.equal(data.admin_configured, true);
  assert.equal(data.providers, 2);
  assert.ok(!JSON.stringify(data).includes("prov-secret"));
});

test("chat: 401 without key, 401 unknown key, 503 without KV", async () => {
  const kv = new FakeKV();
  const env = baseEnv(kv);
  const noAuth = await handleChatCompletions(
    new Request("https://gw.test/v1/chat/completions", { method: "POST", body: "{}" }),
    env, async () => jsonResp({}),
  );
  assert.equal(noAuth.status, 401);
  const bad = await handleChatCompletions(chatReq("ca-nope", { model: "model-shared", messages: [] }), env, async () => jsonResp({}));
  assert.equal(bad.status, 401);
  const noKv = await handleChatCompletions(chatReq("ca-x", { model: "model-shared", messages: [] }), baseEnv(null), async () => jsonResp({}));
  assert.equal(noKv.status, 503);
});

test("chat: 404 model not offered, 429 quota exceeded, upstream not called", async () => {
  const kv = new FakeKV();
  const env = baseEnv(kv);
  const key = await makeGatewayKey(env);
  let calls = 0;
  const fetchStub = async () => { calls++; return jsonResp({}); };
  const nf = await handleChatCompletions(chatReq(key, { model: "no-such-model", messages: [] }), env, fetchStub);
  assert.equal(nf.status, 404);
  assert.equal(calls, 0);
  // exhaust quota via a real call, then next call must 429 without fetch
  const okFetch = async () => jsonResp({ choices: [], usage: { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000 } });
  const ok = await handleChatCompletions(chatReq(key, { model: "model-shared", messages: [] }), env, okFetch);
  assert.equal(ok.status, 200);
  calls = 0;
  const over = await handleChatCompletions(chatReq(key, { model: "model-shared", messages: [] }), env, fetchStub);
  assert.equal(over.status, 429);
  assert.equal(calls, 0);
});

test("chat: happy path proxies with provider key and accounts usage", async () => {
  const kv = new FakeKV();
  const env = baseEnv(kv);
  const key = await makeGatewayKey(env);
  const seen = [];
  const fetchStub = async (url, opts) => {
    seen.push({ url, auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
    return jsonResp({ choices: [{ message: { content: "halo" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  };
  const res = await handleChatCompletions(chatReq(key, { model: "zai-org/GLM-5.3-Flash", messages: [{ role: "user", content: "hi" }] }), env, fetchStub);
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://api.gonkarouter.io/v1/chat/completions");
  assert.equal(seen[0].auth, "Bearer prov-secret-1");
  assert.equal(seen[0].body.model, "zai-org/GLM-5.3-Flash");
  const listed = await listGatewayKeys(env);
  assert.equal(listed.keys[0].used_tokens, 15);
});

test("chat: failover on 502, no failover on 400", async () => {
  const kv = new FakeKV();
  const env = baseEnv(kv);
  const key = await makeGatewayKey(env);
  const order = [];
  const fetchStub = async (url) => {
    order.push(url);
    if (url.includes("gonkarouter")) return new Response("bad gateway", { status: 502 });
    return jsonResp({ choices: [{ message: { content: "via backup" } }], usage: { total_tokens: 3 } });
  };
  const res = await handleChatCompletions(chatReq(key, { model: "model-shared", messages: [] }), env, fetchStub);
  assert.equal(res.status, 200);
  assert.deepEqual(order, ["https://api.gonkarouter.io/v1/chat/completions", "https://backup.example/v1/chat/completions"]);
  // 400 from first provider must pass through, second provider untouched
  order.length = 0;
  const fetch400 = async (url) => {
    order.push(url);
    if (url.includes("gonkarouter")) return jsonResp({ error: { message: "bad request" } }, 400);
    return jsonResp({});
  };
  const bad = await handleChatCompletions(chatReq(key, { model: "model-shared", messages: [] }), env, fetch400);
  assert.equal(bad.status, 400);
  assert.equal(order.length, 1);
});

test("chat: streaming forwards SSE and accounts usage chunk", async () => {
  const kv = new FakeKV();
  const env = baseEnv(kv);
  const key = await makeGatewayKey(env);
  const sse =
    'data: {"choices":[{"delta":{"content":"ha"}}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n' +
    "data: [DONE]\n\n";
  const fetchStub = async () => new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
  const res = await handleChatCompletions(chatReq(key, { model: "model-shared", messages: [], stream: true }), env, fetchStub);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('"content":"ha"'));
  assert.ok(text.includes("[DONE]"));
  const listed = await listGatewayKeys(env);
  assert.equal(listed.keys[0].used_tokens, 15);
});

test("admin: create/list hides secrets, delete revokes", async () => {
  const kv = new FakeKV();
  const env = baseEnv(kv);
  const created = await createGatewayKey(env, { name: "main", quota_tokens: 500 });
  assert.ok(created.created.key);
  const listed = await listGatewayKeys(env);
  assert.equal(listed.keys.length, 1);
  assert.ok(!JSON.stringify(listed).includes(created.created.key));
  assert.ok(!JSON.stringify(listed).includes("key_hash"));
  // key works for chat
  const ok = await handleChatCompletions(
    chatReq(created.created.key, { model: "model-shared", messages: [] }), env,
    async () => jsonResp({ choices: [], usage: { total_tokens: 1 } }),
  );
  assert.equal(ok.status, 200);
  // delete, then chat must 401
  const del = await deleteGatewayKey(env, created.created.id);
  assert.equal(del.deleted, created.created.id);
  const gone = await handleChatCompletions(
    chatReq(created.created.key, { model: "model-shared", messages: [] }), env,
    async () => jsonResp({}),
  );
  assert.equal(gone.status, 401);
  const missing = await deleteGatewayKey(env, "nope");
  assert.equal(missing.error.status, 404);
});

// ---- hybrid keys (bot-sold packages) ----

async function makeHybridKey(env, over = {}) {
  const r = await createGatewayKey(env, {
    name: "buyer",
    quota_tokens: 1000000,
    quota_type: "package",
    upstream_api_key: "arx-test-secret",
    models: ["deepseek-v4.1-flash-uncensored", "glm-5.3-flash-uncensored"],
    ...over,
  }, { allowUpstream: true, allowPackage: true });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.equal(r.created.quota_type, "package");
  return r.created.key;
}

async function setRecord(kv, key, patch) {
  const hash = await sha256Hex(key);
  const rec = JSON.parse(await kv.get(`gwkey:${hash}`));
  Object.assign(rec, patch);
  await kv.put(`gwkey:${hash}`, JSON.stringify(rec));
}

test("hybrid: package key never resets, monthly key still resets", async () => {
  const kv = new FakeKV();
  const env = baseEnv(kv);
  const monthly = await makeGatewayKey(env);
  const hybrid = await makeHybridKey(env);
  // Fake an old period with prior usage on both keys.
  await setRecord(kv, monthly, { period: "2000-01", used_tokens: 500 });
  await setRecord(kv, hybrid, { period: "2000-01", used_tokens: 500 });
  const fetchStub = async () => jsonResp({ choices: [], usage: { total_tokens: 10 } });
  await handleChatCompletions(chatReq(monthly, { model: "model-shared", messages: [] }), env, fetchStub);
  await handleChatCompletions(chatReq(hybrid, { model: "deepseek-v4.1-flash-uncensored", messages: [] }), env, fetchStub);
  const listed = await listGatewayKeys(env);
  const byKey = Object.fromEntries(listed.keys.map((k) => [k.name, k]));
  assert.equal(byKey.test.used_tokens, 10); // reset to 0, then +10
  assert.equal(byKey.buyer.used_tokens, 510); // no reset: 500 + 10
  assert.equal(byKey.buyer.quota_type, "package");
  assert.equal(byKey.buyer.has_upstream, true);
});

test("hybrid: chat routes via key upstream only, never env providers", async () => {
  const kv = new FakeKV();
  const env = baseEnv(kv);
  const hybrid = await makeHybridKey(env);
  const seen = [];
  const fetchStub = async (url, opts) => {
    seen.push({ url, auth: opts.headers.Authorization });
    return jsonResp({ choices: [], usage: { total_tokens: 1 } });
  };
  const res = await handleChatCompletions(
    chatReq(hybrid, { model: "deepseek-v4.1-flash-uncensored", messages: [] }), env, fetchStub);
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://arxpay.my.id/chat/completions");
  assert.equal(seen[0].auth, "Bearer arx-test-secret");
  // A River/env model must 404 for the hybrid key, without any fetch.
  seen.length = 0;
  const nf = await handleChatCompletions(
    chatReq(hybrid, { model: "model-shared", messages: [] }), env, fetchStub);
  assert.equal(nf.status, 404);
  assert.equal(seen.length, 0);
});

test("hybrid: models masks owned_by for hybrid key, public list unchanged", async () => {
  const kv = new FakeKV();
  const env = baseEnv(kv);
  const hybrid = await makeHybridKey(env);
  const authed = new Request("https://gw.test/v1/models", {
    headers: { Authorization: `Bearer ${hybrid}` },
  });
  const data = await (await handleModels(env, authed)).json();
  assert.deepEqual(data.data.map((m) => m.id),
    ["deepseek-v4.1-flash-uncensored", "glm-5.3-flash-uncensored"]);
  assert.ok(data.data.every((m) => m.owned_by === "ArsRouter Proxy"));
  assert.ok(!JSON.stringify(data).includes("arx"));
  const pub = await (await handleModels(env)).json();
  assert.deepEqual(pub.data.map((m) => m.id), ["zai-org/GLM-5.3-Flash", "model-shared"]);
});

test("bot: credential gating, upstream validation, no upstream leak", async () => {
  const kv = new FakeKV();
  const env = baseEnv(kv);
  const botReq = (token) => new Request("https://gw.test/api/bot/keys", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  assert.equal(requireBot(botReq("x"), env).status, 503); // BOT_SERVICE_KEY unset
  env.BOT_SERVICE_KEY = "bot-secret";
  assert.equal(requireBot(botReq("wrong"), env).status, 401);
  assert.equal(requireBot(botReq("bot-secret"), env), null);
  // Admin path ignores upstream input: no hybrid key smuggled via admin.
  const plain = await createGatewayKey(env, {
    name: "admin", quota_tokens: 100, quota_type: "package", upstream_api_key: "arx-test-secret",
  });
  assert.equal(plain.created.quota_type, "monthly");
  const listed0 = await listGatewayKeys(env);
  assert.equal(listed0.keys[0].has_upstream, false);
  // Bot path validation.
  const missing = await createGatewayKey(env, { name: "b", quota_tokens: 100, quota_type: "package" },
    { allowUpstream: true, allowPackage: true });
  assert.equal(missing.error.status, 400);
  const evil = await createGatewayKey(env, {
    name: "b", quota_tokens: 100, quota_type: "package",
    upstream_api_key: "arx-test-secret", upstream_base_url: "https://evil.example/v1",
  }, { allowUpstream: true, allowPackage: true });
  assert.equal(evil.error.status, 400);
  const ok = await createGatewayKey(env, {
    name: "b", quota_tokens: 100, quota_type: "package", upstream_api_key: "arx-test-secret",
  }, { allowUpstream: true, allowPackage: true });
  assert.ok(!ok.error);
  assert.ok(!JSON.stringify(ok.created).includes("arx-test-secret"));
  const listed = await listGatewayKeys(env);
  assert.ok(!JSON.stringify(listed).includes("arx-test-secret"));
});

