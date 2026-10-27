import { requireAdmin, listGatewayKeys, createGatewayKey, json, err } from "../../lib/gateway.js";

export async function onRequest({ request, env }) {
  const adminErr = requireAdmin(request, env);
  if (adminErr) return adminErr;
  if (request.method === "GET") {
    const r = await listGatewayKeys(env);
    if (r.error) return r.error;
    return json({ keys: r.keys });
  }
  if (request.method === "POST") {
    let input;
    try {
      input = await request.json();
    } catch {
      return err("invalid_request", "Body must be valid JSON.", 400);
    }
    const r = await createGatewayKey(env, input);
    if (r.error) return r.error;
    return json(r.created, 201);
  }
  return new Response("Method Not Allowed", { status: 405 });
}
