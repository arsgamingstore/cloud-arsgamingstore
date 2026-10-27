import { requireAdmin, deleteGatewayKey, json } from "../../../lib/gateway.js";

export async function onRequest({ request, env, params }) {
  const adminErr = requireAdmin(request, env);
  if (adminErr) return adminErr;
  if (request.method !== "DELETE") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const r = await deleteGatewayKey(env, params.id);
  if (r.error) return r.error;
  return json(r);
}
