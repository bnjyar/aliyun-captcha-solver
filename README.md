# aliyun-captcha-solver

Solver captcha Alibaba (FeiLin / Aliyun Captcha 2.0) yang jalan **penuh di Node** —
tanpa layanan solver berbayar dan tanpa puzzle slider.

Generik: bukan khusus satu platform. Yang platform-specific cuma **konfigurasi tenant**
(AccessKey, SceneId, prefix, region) dan **situs tempat device token dipanen** —
keduanya lo kasih lewat config, bukan di-hardcode.

```
tab browser (warm)  →  device token  →  CaptchaPool  →  captcha_verify_param
       (satu-satunya sumbangan browser)      (Node murni)
```

## Prinsip

Risk engine Aliyun tidak memeriksa client saat verifikasi — trust terbentuk saat
*minting*. Jadi satu-satunya andalan browser adalah **device token**, yang dipanen
dari satu tab yang hangat via `window.z_um.getToken()`. Setelah itu
Init/Verify/pembuatan parameter semuanya jalan di Node.

Konsekuensi yang harus lo terima: **butuh satu farm tab per situs**. Device token
berformat `SG_WEB#<fp>...` dari cloudauth dan kemungkinan besar ter-scope ke
tenant, jadi token dari situs A belum tentu valid untuk tenant B.

## Install

```bash
npm install aliyun-captcha-solver
```

`playwright-core` cuma dibutuhkan kalau lo pakai `TokenFarm`. Ini peer dependency
opsional — Kalau sudah ada di app lo, resolve otomatis. Kalau tidak, set
`PLAYWRIGHT_CORE_PATH=/path/ke/playwright-core/package.json`.

`undici` ikut terpasang otomatis, dipakai untuk jalur proxy (lihat di bawah). Butuh
Node ≥ 20.18.1.

## Pakai

```js
import { createAliyunCaptcha, CaptchaPool, TokenFarm } from 'aliyun-captcha-solver';

// 1. Klien untuk satu tenant
const captcha = createAliyunCaptcha({
  accessKey: process.env.ALIYUN_ACCESS_KEY,
  secretKey: process.env.ALIYUN_SECRET_KEY,
  sceneId:   'didk33e0',        // nilai publik, ada di JS situs target
  prefix:    'no8xfe',
  region:    'sgp',             // token region SDK (window.AliyunCaptchaConfig)
  endpointRegion: 'southeast',  // token region DNS di hostname
});

// 2. Farm device token (butuh browser)
const farm = new TokenFarm({
  url: 'https://chat.z.ai',
  prefix: 'no8xfe',
  region: 'sgp',
  profile: '/path/ke/chrome-profile',
  verbose: true,
});
await farm.start();

// 3. Pool param warm dengan pacing + backoff
const pool = new CaptchaPool({ captcha, verbose: true });
pool.setCollector(() => farm.harvest(25));
await pool.start();

const param = await pool.get(30_000); // captcha_verify_param, atau null
```

Kalau cuma butuh param sekali tanpa browser, semua bisa lewat
`captcha.computeCaptchaParam(deviceToken)` langsung.

## Proxy keluar (opsional)

Lo bisa kasih satu daftar proxy HTTP ke paket ini. Request yang dikirim paket, yaitu
Init dan Verify Aliyun serta Chrome farm, lewat proxy aktif yang sama:

```js
import { createAliyunCaptcha, TokenFarm, loadProxyRouter } from 'aliyun-captcha-solver';

const proxy = loadProxyRouter('/path/ke/proxies.txt', {
  cooldownMs: 300_000,
  rotateOn: null,            // (res, url) => alasan | null; string = pindah proxy
  log: console.log,
});

const captcha = createAliyunCaptcha({ /* ... */, proxy });
const farm = new TokenFarm({ /* ... */, proxy });
```

Format daftar, satu per baris (baris kosong dan `#` diabaikan):
`host:port:user:pass` (ekspor Webshare), `user:pass@host:port`, atau `host:port`.
Hanya HTTP (CONNECT). Pesan error menyebut nomor baris, tidak pernah isinya.

- **Sticky.** Satu proxy dipakai sampai gagal. Lalu pindah ke proxy berikutnya, dan
  yang gagal didinginkan selama `cooldownMs`. Init dan Verify harus keluar dari IP yang
  sama, jadi tidak ada rotasi per request.
- **Yang dihitung gagal:** proxy tidak bisa dihubungi (`ECONNREFUSED` dan sejenisnya),
  CONNECT ditolak (407, 403, 5xx), atau Chrome melaporkan `ERR_PROXY_*` / `ERR_TUNNEL_*`.
  Abort dari pemanggil dan error TLS setelah tunnel terbentuk tidak dihitung.
- **`rotateOn(res, url)`** dipanggil untuk setiap respons dari `proxy.fetch`. Paket tidak
  tahu status atau host mana yang berarti diblokir. Keputusan itu tetap di pemanggil.
- **Farm** diluncurkan ulang saat proxy aktif berganti, karena Chrome tidak bisa ganti
  proxy di konteks yang sedang jalan. Device token yang sudah dipanen sebelum itu tetap
  ada di pool. Kalau peluncuran gagal karena proxy (misalnya proxy mati), `start()` mencoba
  proxy berikutnya, sebanyak jumlah proxy di daftar. Kegagalan lain dilempar seperti biasa.
- **Tanpa `proxy`**, perilakunya sama seperti sebelumnya: koneksi langsung dan fetch global.
- `proxy.fetch(url, init)` bisa dipakai pemanggil untuk request lain lewat proxy yang sama.
  `proxy.status()` untuk diagnosis.

## Yang generalisasi, yang tidak

| Komponen | Cakupan | Catatan |
|---|---|---|
| Protokol RPC + signing HMAC-SHA1 | ✅ **Global** — seluruh Aliyun Captcha 2.0 cloud | Hanya hostname berubah, dan itu otomatis diturunkan dari `prefix` + `endpointRegion` |
| Konstanta cipher (`argConstant`, `encryptKey`, perm-table) | ⚠️ **Per-SDK-build** | Terbukti lintas-scene dalam satu tenant. Tenant lain bisa punya build berbeda → verifikasi per tenant. Guard: `npm run test:solver` |
| Device token (`z_um.getToken()`) | ⚠️ **Per-tenant-ish** | Butuh farm tab di origin situs target |
| Jalur proxy keluar (`proxy`) | ✅ **Global** — sama untuk semua situs | Pilihan "status apa berarti diblokir" ada di pemanggil (`rotateOn`) |

Yang **tidak** termasuk package ini: cara pemakaian param itu sendiri (header/body/
apa pun milik aplikasi target). Itu di-reverse per situs, bukan generik.

## Pacing & backoff

Nilai default di `CaptchaPool`, bisa di-override lewat `timing`:

| Konstanta | Default | Arti |
|---|---|---|
| `PARAM_TTL_MS` | 75s | masa pakai param |
| `MAX_PARAMS` | 2 | jumlah param warm. `0` = on-demand: Verify hanya jalan di dalam `get()`, tanpa mint di latar belakang |
| `IDLE_PAUSE_MS` | 180s | tanpa `get()` selama ini, pool berhenti mint total, termasuk refill param yang masih hidup |
| `MIN_GEN_INTERVAL_MS` | 10s | jarak minimum antar Verify |
| `F001_PAUSE_MS` | 300s | cooldown risk-control |
| `F011_PAUSE_MS` | 60s | cooldown frequency/desync |
| `FAIL_BACKOFF_MS` | 35s | backoff verify gagal biasa |

`F001` juga set `pool.farmNeedsRestart = true` — sinyal ke pemilik farm untuk
bangun ulang tab (device context yang kena-flag, bukan sekadar pacing).

Verify tidak pernah berjalan bersamaan: hanya satu mint in-flight, baik dari
background tick maupun dari `get()` (single-flight). Caller yang menemukan mint
sedang jalan ikut menunggu hasilnya, tidak memulai Verify kedua.

### Diagnosis: `pool.stats().lastError`

Kegagalan mint terakhir: `code` (kode Aliyun seperti `F011`, atau `ERROR` untuk
kegagalan lain), `message` (potongan respons Aliyun), `captchaType` (tantangan
yang diterbitkan Init — `TRACELESS` = tanpa slider), dan `ageSec`. Field ini
tetap ada setelah pulih, jadi `ageSec` menunjukkan seberapa basi.

## Test

```bash
npm test              # 55 test: cipher & request shape (14), pool (15), proxy (24), farm lewat proxy (2)
npm run test:solver   # canary rotasi konstanta Aliyun
```

`test-farm-proxy.mjs` menjalankan Chrome sungguhan (`/usr/bin/google-chrome-stable`)
melawan dua proxy lokal yang menjawab 502. Tidak ada trafik keluar.

`test-solver.mjs` yang paling penting: kalau konstanta cipher FeiLin berubah,
test inilah yang gagal duluan — sebelum request apa pun ditolak diam-diam.

## CLI

```bash
PLAYWRIGHT_CORE_PATH=/path/ke/playwright-core/package.json \
  node src/token-farm.mjs --url https://site.tld --prefix abc123 --count 25
```

## Asal-usul

Diekstrak dari riset solver captcha chat.z.ai (`captcha-solver/` di repo
`zai`, 2026-10-13). Port dari implementasi Go (GLM-Free-API) dan Python
(glm-5.2-proxy). Bukti dan catatan investigasi ada di sana.
