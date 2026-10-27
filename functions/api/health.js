import { handleHealth } from "../lib/gateway.js";

export async function onRequest({ env }) {
  return handleHealth(env);
}
