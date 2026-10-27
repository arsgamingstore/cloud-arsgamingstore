import { requireAdmin, usageReport, json } from "../../lib/gateway.js";

export async function onRequest({ request, env }) {
  const adminErr = requireAdmin(request, env);
  if (adminErr) return adminErr;
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const r = await usageReport(env);
  if (r.error) return r.error;
  return json(r);
}
