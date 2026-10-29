import { requireBot, createGatewayKey, json, err } from "../../lib/gateway.js";

// POST /api/bot/keys — scoped bot endpoint: creates ONE package-type hybrid
// key (per-key ArxPays upstream). Auth is BOT_SERVICE_KEY, never ADMIN_KEY.
// The bot is the only caller; buyers never see this endpoint or credential.
export async function onRequest({ request, env }) {
  const botErr = requireBot(request, env);
  if (botErr) return botErr;
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  let input;
  try {
    input = await request.json();
  } catch {
    return err("invalid_request", "Body must be valid JSON.", 400);
  }
  // Bot sales are always one-time packages, never monthly keys.
  input.quota_type = "package";
  const r = await createGatewayKey(env, input, { allowUpstream: true, allowPackage: true });
  if (r.error) return r.error;
  return json(r.created, 201);
}
