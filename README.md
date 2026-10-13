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

## Yang generalisasi, yang tidak

| Komponen | Cakupan | Catatan |
|---|---|---|
| Protokol RPC + signing HMAC-SHA1 | ✅ **Global** — seluruh Aliyun Captcha 2.0 cloud | Hanya hostname berubah, dan itu otomatis diturunkan dari `prefix` + `endpointRegion` |
| Konstanta cipher (`argConstant`, `encryptKey`, perm-table) | ⚠️ **Per-SDK-build** | Terbukti lintas-scene dalam satu tenant. Tenant lain bisa punya build berbeda → verifikasi per tenant. Guard: `npm run test:solver` |
| Device token (`z_um.getToken()`) | ⚠️ **Per-tenant-ish** | Butuh farm tab di origin situs target |

Yang **tidak** termasuk package ini: cara pemakaian param itu sendiri (header/body/
apa pun milik aplikasi target). Itu di-reverse per situs, bukan generik.

## Pacing & backoff

Nilai default di `CaptchaPool`, bisa di-override lewat `timing`:

| Konstanta | Default | Arti |
|---|---|---|
| `PARAM_TTL_MS` | 75s | masa pakai param |
| `MAX_PARAMS` | 2 | jumlah param warm |
| `MIN_GEN_INTERVAL_MS` | 10s | jarak minimum antar Verify |
| `F001_PAUSE_MS` | 300s | cooldown risk-control |
| `F011_PAUSE_MS` | 60s | cooldown frequency/desync |
| `FAIL_BACKOFF_MS` | 35s | backoff verify gagal biasa |

`F001` juga set `pool.farmNeedsRestart = true` — sinyal ke pemilik farm untuk
bangun ulang tab (device context yang kena-flag, bukan sekadar pacing).

## Test

```bash
npm test              # 20 test: cipher primitives + pool logic
npm run test:solver   # canary rotasi konstanta Aliyun
```

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
