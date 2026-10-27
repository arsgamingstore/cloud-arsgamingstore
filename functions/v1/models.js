import { handleModels, handleOptions, withCors } from "../lib/gateway.js";

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") return handleOptions();
  if (request.method !== "GET") {
    return withCors(new Response("Method Not Allowed", { status: 405 }));
  }
  return withCors(handleModels(env));
}
