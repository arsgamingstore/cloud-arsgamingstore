// functions/_middleware.js
// Adds security headers to every Functions response (all /v1/* and /api/*
// routes, including error responses). Static files get theirs from
// public/_headers; middleware only runs for function routes, so a response
// never gets the headers twice. Keep the values in sync with _headers.
// CSP allows inline script/style because the dashboard pages use inline
// <script> and <style>; everything fetched is same-origin.

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000",
};

export async function onRequest(context) {
  const res = await context.next();
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}
