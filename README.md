# ArsRouter Proxy (cloud-arsgamingstore)

Gateway AI Workers-native: satu endpoint OpenAI-compatible di depan banyak
provider, di-deploy di Cloudflare Pages. Ditulis ulang untuk model Workers —
**bukan** port 9router-pro (9router-pro mentah tidak bisa jalan di
Pages/Workers: Next.js 16 + SQLite lokal via native addon + custom server).

Nama website: **ArsRouter Proxy**. Logo: `public/logo.mp4` (video logo,
480×270, 474KB — lebih ringan dan lebih tajam dari GIF).

## Fitur v1

- `POST /v1/chat/completions` — OpenAI-compatible, dukung streaming (SSE),
  auth Bearer gateway key, failover antar provider (5xx/429/error jaringan).
- `GET /v1/models` — katalog model gabungan dari env (tanpa auth).
- `GET /api/health` — status (tanpa auth, tanpa secret).
- Dashboard web (`/`) — login admin, kelola gateway key, lihat pemakaian
  vs kuota per key per bulan, status provider, panel tes chat.
- Kuota per key per bulan kalender (token prompt + completion dari respons
  provider), disimpan di KV. Kuota habis → 429.

## Struktur

- `functions/lib/gateway.js` — seluruh logika (tanpa dependensi).
- `functions/v1/chat/completions.js`, `functions/v1/models.js` — endpoint publik.
- `functions/api/health.js`, `functions/api/admin/*` — health + admin.
- `public/index.html` — dashboard (HTML/JS vanilla, tanpa build).
- `test/gateway.test.mjs` — tes logika (Node 24, tanpa wrangler).
- `DESIGN.md` — desain + keputusan yang dicoret di v1.

## Deploy ke Cloudflare Pages

1. Pages → Create → Pages → Connect to Git → pilih repo
   `arsgamingstore/cloud-arsgamingstore`, branch `main`.
   Build output directory: `public`. (Tidak ada build command — statis + Functions.)
2. Buat KV namespace (Workers & Pages → KV → Create), lalu bind di
   Pages → Settings → Functions → KV namespace bindings:
   variable name `GATEWAY_KV` → namespace yang baru dibuat.
3. Isi Secrets & Variables (Pages → Settings → Environment variables,
   tandai sebagai Secret untuk yang sensitif):
   - `ADMIN_KEY` — kunci admin dashboard (buat yang panjang & acak).
   - `PROVIDER_1_NAME` = `river`
   - `PROVIDER_1_BASE_URL` = `https://api.river.ai/v1`
   - `PROVIDER_1_API_KEY` = key River dari console.river.ai (secret —
     jangan pernah di-commit, jangan lewat chat).
   - `PROVIDER_1_MODELS` = daftar model dipisah koma, mis.
     `deepseek-ai/DeepSeek-V4.1-Flash` (lihat halaman Models di docs River
     untuk ID lengkap).
   - Provider ke-2 dst: ulangi pola `PROVIDER_2_*`, `PROVIDER_3_*`, …
4. Redeploy (Deployments → Retry deployment) setelah KV + secrets diisi.
5. Buka dashboard di URL Pages, login pakai `ADMIN_KEY`, buat gateway key,
   lalu pakai key itu sebagai Bearer token ke `/v1/chat/completions`.

Subdomain custom (mis. `gateway.arsgaming.web.id` atau yang lain) diatur
belakangan di Pages → Custom domains — keputusan user: nanti setelah jadi.

## Pakai dari kode (OpenAI SDK)

```python
from openai import OpenAI
client = OpenAI(api_key="<GATEWAY_KEY>", base_url="https://<pages-url>/v1")
resp = client.chat.completions.create(
    model="deepseek-ai/DeepSeek-V4.1-Flash",
    messages=[{"role": "user", "content": "Halo!"}],
)
```

## Keamanan

- Key provider hanya ada di Pages Secrets (env). Tidak pernah di-commit,
  tidak pernah dikirim ke klien, tidak pernah ditulis ke log.
- Gateway key disimpan sebagai hash SHA-256 di KV. Key mentah hanya
  ditampilkan sekali saat dibuat.
- Tanpa KV binding, gateway menolak melayani (503) — tidak pernah
  fallback ke "allow all".
- Admin key tunggal (v1). Jangan bagikan `ADMIN_KEY` ke pemakai gateway.

## Batas v1 (jujur)

- Streaming: pemakaian token hanya tercatat kalau provider melaporkan
  `usage` di stream (mis. client mengirim `stream_options.include_usage`).
  Tanpa itu, request streaming tidak terhitung kuota.
- Failover hanya untuk 5xx/429/error jaringan. Error 4xx lain dari provider
  diteruskan apa adanya tanpa failover.
- Belum ada round-robin antar provider untuk model yang sama, belum ada
  prompt injection per-key, belum ada multi-akun per provider (satu key
  resmi per provider — multi-akun adalah jalur account-farming, tidak dibangun).
- Kuota memakai read-modify-write KV (bukan atomik) — cukup untuk skala
  kecil, bukan untuk beban konkuren berat.

## Tes lokal

```sh
node --test test/gateway.test.mjs
node --check functions/lib/gateway.js
```

Tes memakai KV palsu (Map) dan fetch stub — tidak menyentuh jaringan atau
key asli. Routing file-ke-URL Pages (konvensi `functions/`) baru terverifikasi
penuh saat deploy pertama di Pages.
