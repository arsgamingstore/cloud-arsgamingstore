# DESIGN.md — cloud-arsgamingstore (Workers-native AI gateway)

Status: DRAFT — menunggu persetujuan user sebelum build (gerbang brainstorm).
Repo: https://github.com/arsgamingstore/cloud-arsgamingstore.git
Subdomain: ditunda sampai project jadi (keputusan user 2026-10-28).

## 1. Masalah yang diselesaikan

User ingin gateway seperti 9router-pro (satu endpoint OpenAI-compatible di depan
banyak provider) yang bisa di-deploy di Cloudflare Pages. 9router-pro mentah
TIDAK BISA jalan di Pages/Workers: Next.js 16 + SQLite lokal via native addon
(better-sqlite3) + custom server — Pages/Workers adalah runtime isolate (tidak
bisa listen port, tidak ada filesystem lokal, native addon tidak ke-load).
Bukti: verifikasi clone+grep 2026-10-27 + ilmu workerd #16.

Jadi proyek ini BUKAN port 9router-pro — ini gateway baru yang ditulis ulang
untuk model Workers (event-in/binding-out). Fitur inti dipertahankan, fitur
yang mustahil di Workers dicoret dengan jujur (lihat §6).

## 2. Arsitektur

Satu Cloudflare Pages project, dua bagian:

- **API (Pages Functions = Workers runtime):** `functions/` — semua logika gateway.
  Stateless per request; state hanya lewat binding (KV/D1).
- **Dashboard (static frontend):** halaman web ringan (HTML/JS, tanpa build
  framework) yang memanggil API yang sama. Login dashboard pakai admin key
  yang sama dengan master key API (v1, satu kredensial admin).

Tidak ada server Node, tidak ada SQLite file, tidak ada background loop,
tidak ada MITM/proxy lokal. Semua provider dipanggil lewat `fetch` keluar
dari Worker (fetch standar, bukan socket mentah).

## 3. Endpoint (OpenAI-compatible)

- `GET /v1/models` — daftar model gabungan dari semua provider yang aktif.
  Tanpa auth (katalog publik, seperti 9router-pro).
- `POST /v1/chat/completions` — chat completion, dukung streaming (SSE).
  Wajib header `Authorization: Bearer <GATEWAY_KEY>`.
- `GET /api/health` — liveness (tanpa auth).
- `GET /api/admin/keys` / `POST /api/admin/keys` / `DELETE /api/admin/keys/:id`
  — kelola API key (auth: admin key).
- `GET /api/admin/usage` — pemakaian per key + status provider (auth: admin key).

Request yang tidak bawa key → 401. Key yang kuotanya habis → 429.
Provider tidak merespons / error → failover ke provider berikutnya yang
menyediakan model yang sama (maksimal 2x percobaan per request, lalu 502).

## 4. Provider (dikonfigurasi lewat env, bukan dashboard di v1)

Provider v1 (dikonfirmasi dari gonkarouter.io, 2026-10-28):

- **GonkaRouter** — "AI Model Router on the Gonka Network", satu API untuk
  banyak model, OpenAI-compatible (contoh resmi memakai OpenAI SDK).
- Base URL: `https://api.gonkarouter.io/v1`, auth Bearer key.
- Contoh model dari homepage: `zai-org/GLM-5.3-Flash` (262k context,
  function calling ready). Daftar model lengkap via env (lihat bawah),
  karena endpoint `/v1/models` GonkaRouter menjawab 401 tanpa key dengan
  error `unauthorized / missing Authorization or x-api-key header` —
  katalog model TIDAK publik dan provider menerima header `Authorization`
  Bearer atau `x-api-key`, jadi gateway tidak bisa passthrough
  katalog tanpa key.
- Harga referensi dari homepage: user baru dapat 10M token gratis,
  mulai $0.0045 per 1M token (biaya pemakaian tetap ditanggung akun
  GonkaRouter user, bukan gateway).

Satu provider = satu grup env di Pages (Secrets, nilainya tidak pernah masuk
repo atau chat):

- `PROVIDER_<N>_NAME` — nama tampil (v1: `gonkarouter`).
- `PROVIDER_<N>_BASE_URL` — base URL OpenAI-compatible provider itu
  (v1: `https://api.gonkarouter.io/v1`).
- `PROVIDER_<N>_API_KEY` — secret (Pages Secrets; nilai key dari file
  yang diupload user TIDAK dibaca — user memasukkannya sendiri ke
  Pages Secrets saat deploy).
- `PROVIDER_<N>_MODELS` — daftar model yang disediakan, dipisah koma
  (diisi user dari katalog GonkaRouter-nya).

Routing v1: model yang diminta dicari di provider yang aktif; kalau provider
utama gagal, failover ke provider lain yang menyediakan model yang sama.
Round-robin antar provider untuk model yang sama = v2 (bukan v1).

## 5. Auth + kuota (v1)

- **Master admin key** (`ADMIN_KEY`, Pages Secret): untuk dashboard + kelola key.
- **Gateway key per pemakai** (dibuat lewat dashboard, disimpan hash-nya saja
  di KV; key mentah hanya ditampilkan sekali saat dibuat, seperti pola
  API key yang benar).
- **Kuota per key:** hitung token (prompt + completion dari respons provider)
  per key per bulan kalender, disimpan di KV. Batas default per key diatur
  saat key dibuat (mis. 1.000.000 token/bulan, bisa diubah). Kuota habis →
  429 sampai bulan berikutnya. Dashboard menampilkan pemakaian vs batas.
- **Keamanan:** semua key provider hanya ada di Pages Secrets (env), tidak
  pernah di-commit, tidak pernah dikirim ke klien, tidak pernah ditulis
  ke log. Dashboard tidak pernah menampilkan key provider.

## 6. Yang SENGAJA tidak ada di v1 (jujur, bukan janji)

- MITM / proxy lokal / intercept traffic (mustahil di Workers).
- SQLite lokal, server persisten, background job (mustahil di Workers).
- Dashboard selengkap 9router-pro (prompt injection per-key per-model,
  proxy-pool health check lengkap, dsb.) — v1: kelola key + kuota + status
  provider saja. Prompt injection global (system prompt tambahan) = v2.
- Multi-akun per provider / rotasi akun (itu jalur account-farming; tidak
  dibangun — satu key resmi per provider).
- Round-robin, load balancing berbobot, analitik mendetail (v2).

## 7. Repo + deploy

- Repo: `arsgamingstore/cloud-arsgamingstore` (dibuat user; assistant tidak
  bisa membuat repo dari sini karena gh CLI tidak login).
- Struktur repo: `functions/` (API), `public/` (dashboard statis),
  `wrangler.toml` (Pages project), `DESIGN.md` ini, `.gitignore` (env
  tidak pernah ikut).
- Deploy: Pages dihubungkan ke repo (Git integration) → push = auto-deploy.
  Push pertama dilakukan user dari PC-nya (bundle + kredensial sendiri),
  atau assistant push via SSH kalau repo sudah ada dan key SSH sudah
  ditambahkan (pola yang pernah jalan untuk repo lain).
- Setelah deploy: user mengisi Pages Secrets (ADMIN_KEY + provider env)
  lewat dashboard Cloudflare, lalu subdomain ditentukan belakangan.

## 8. Open items (harus dijawab sebelum/saat build)

1. ~~Provider "gonka"~~ TERJAWAB 2026-10-28: GonkaRouter, base URL
   https://api.gonkarouter.io/v1 (OpenAI-compatible, Bearer). Sisa: nilai
   key masuk langsung ke Pages Secrets oleh user saat deploy (file key
   tidak dibaca).
2. ~~Konfirmasi desain~~ DISETUJUI user 2026-10-28 ("okee gaskeunn").
3. Subdomain: ditunda (sudah disepakati).
4. Push dari VM DITOLAK 2026-10-28: SSH key di VM = jhon7z, tanpa akses
   tulis ke repo org arsgamingstore. Butuh user push dari PC-nya, atau
   tambah jhon7z sebagai collaborator di repo ini lalu assistant push ulang.
