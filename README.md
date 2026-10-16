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

Farm device token punya **dua engine** dengan kontrak yang sama (`start`/`harvest`/
`isStale`/`restart`/`stop`):

| Engine | Kelas | Butuh | Catatan |
|---|---|---|---|
| Chrome headless (default) | `TokenFarm` | playwright-core + profil Chrome | tab hangat; bukti live paling matang |
| Node + jsdom (**tanpa Chrome**) | `JsdomFarm` | jsdom + aset SDK | SDK AliyunCaptcha.js **jalan di jsdom**, registrasi device (Log1) lewat jaringan dari Node; token lolos Verify live (T001) — lihat riset H13 di repo `zai` |

## Prinsip

Risk engine Aliyun tidak memeriksa client saat verifikasi — trust terbentuk saat
*minting*. Jadi satu-satunya andalan browser adalah **device token**, yang dipanen
dari satu tab yang hangat via `window.z_um.getToken()`. Setelah itu
Init/Verify/pembuatan parameter semuanya jalan di Node.

`JsdomFarm` menghapus tab itu: SDK dijalankan di jsdom, dan `z_um.getToken()` tetap
komputasi lokal di dalam dokumen (nol request per token) — yang lewat jaringan hanya
warm-up (`Log1` registrasi + `Log2`/`Log3` upload fingerprint).

Konsekuensi yang harus lo terima: **butuh satu farm per situs**. Device token
berformat `SG_WEB#<fp>...` dari cloudauth dan kemungkinan besar ter-scope ke
tenant, jadi token dari situs A belum tentu valid untuk tenant B.

## Install

```bash
npm install aliyun-captcha-solver
```

`playwright-core` cuma dibutuhkan kalau lo pakai `TokenFarm`. Ini peer dependency
opsional — Kalau sudah ada di app lo, resolve otomatis. Kalau tidak, set
`PLAYWRIGHT_CORE_PATH=/path/ke/playwright-core/package.json`.

`jsdom` (>= 30) cuma dibutuhkan kalau lo pakai `JsdomFarm` — juga peer dependency
opsional. Kalau tidak terpasang di app lo, set `JSDOM_PATH=/path/ke/jsdom`
(direktori paket atau `package.json`-nya).

`undici` ikut terpasang otomatis, dipakai untuk jalur proxy (lihat di bawah). Butuh
Node ≥ 20.18.1 (jsdom 30 praktis butuh Node modern; diuji di Node 26).

Kalau solver dipakai lewat `file:` (symlink, bukan dari registry), npm **tidak** memasang
dependensinya di app pemakai. Jalankan `npm install` di folder solver sendiri. `proxy-direct`
melakukannya lewat `postinstall`. Untuk tes solver, `playwright-core` dan `jsdom` ada di
`devDependencies`, jadi `npm install` di sini cukup untuk menjalankan `npm test`.

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
  // log: (msg) => console.log(msg), // opsional: durasi tiap mint, Init dan Verify dipisah
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

## Farm tanpa Chrome (`JsdomFarm`)

Drop-in untuk `TokenFarm`: SDK AliyunCaptcha.js dijalankan di dalam jsdom, dan
registrasi device (Log1) ikut dikirim dari Node — **tidak ada Chrome di mana pun**.

```js
import { createAliyunCaptcha, CaptchaPool, JsdomFarm, loadProxyRouter } from 'aliyun-captcha-solver';

const proxy = loadProxyRouter('/path/ke/proxies.txt', { cooldownMs: 300_000, timeoutMs: 20_000 });
const farm = new JsdomFarm({
  url: 'https://situs-target.tld',   // origin halaman (SDK tidak butuh JS situs)
  prefix: 'no8xfe',
  region: 'sgp',
  proxy,                              // semua egress farm lewat proxy aktif
  assetsDir: '/path/ke/aset-sdk',     // opsional: AliyunCaptcha.js + feilin*.js dari disk
  cacheDir: '/path/ke/cache',         // opsional: cache aset CDN
  verbose: true,
});
await farm.start();                   // ~2-8 dtk (Log1 + aset + feilin)
const tokens = await farm.harvest(25); // string[] (sama seperti TokenFarm)

const pool = new CaptchaPool({ captcha });
pool.setCollector(() => farm.harvest(25));
```

Env yang dikenal (opsional, sama artinya dengan opsi di atas):
`JSDOM_PATH` (lokasi jsdom), `JSDOM_FARM_ASSETS` (dir aset SDK),
`JSDOM_FARM_CACHE` (cache unduhan CDN; default `~/.cache/aliyun-captcha-solver/jsdom-assets`).

Aturan jaringan:

- **Mode `live` (default)** — XHR device di dalam halaman (`Log1` registrasi,
  `Log2`/`Log3` upload fingerprint) diteruskan ke jaringan asli lewat `fetchImpl`
  (= `proxy.fetch` kalau `proxy` diberikan). `auditDir` bisa diisi untuk menyimpan
  request/response mentah saat debug.
- **Mode `replay`** — `Log1` dijawab dari `deviceConfig` yang dikasih (hasil capture
  sebelumnya); sepenuhnya offline. Untuk tes/debug.
- Sub-resource: dari `assetsDir`; yang tidak ada di sana di-fetch statis dari
  `*.alicdn.com` (build FeiLin bisa berotasi kapan saja — `DeviceConfig` yang
  menentukan) lalu dicache. Host lain diblokir.
- `z_um.getToken()` sendiri **tidak menyentuh jaringan** (komputasi lokal SDK).

Catatan operasional:

- **Warm di-retry** (`warmAttempts`, default 2; env `JSDOM_FARM_WARM_ATTEMPTS`). Tiap percobaan =
  DOM baru (+ registrasi Log1 baru di mode live), dan aset hasil unduhan CDN dibuang dulu supaya
  unduhan setengah jadi tidak dipakai selamanya. Farm yang dingin **memanas-kan diri** di
  `harvest()` berikutnya (jalur kolektor pool), jadi kegagalan sementara tidak mematikan farm
  permanen; `stats().warmFailures`/`lastWarmError` menunjukkan penyebabnya. Retry **tidak**
  menolong kalau build SDK baru memang butuh API yang belum di-shim — itu perbaikan shim, dan
  memang tidak ada jalan "turun build" (server menandai downgrade: F001).
- **Health check berbasis panjang token.** Kalau registrasi gagal, SDK memasang
  stub `z_um.getToken = () => ""` tanpa error — `start()` menolak token di bawah
  `minTokenLen` (default 500) dan (mode live) menolak Log1 yang bukan
  `Code 200` + `DeviceConfig`.
- **Build FeiLin mengikuti server.** `DeviceConfig.version` menentukan build yang dimuat;
  yang tidak ada di `assetsDir` di-fetch statis dari CDN lalu dicache. **Jangan pin build
  untuk registrasi segar** — server mengikat build ke registrasi yang ia terbitkan dan
  menandai downgrade (F001; diukur 2026-10-16). `pinFeilin` hanya untuk sesi dengan
  identitas registrasi lama (mode replay). Build yang dipakai terlihat di `stats().feilin`
  (dan `/healthz` pemanggil, mis. `farmFeilin`).
- **feilin 1.5.2/048** membaca global `Worker` di ekspresi obfuscated yang jalan
  sinkron di jalur `getToken`. jsdom tidak punya `Worker`, jadi farm memasang
  **penanda read-only** (`!Worker` → false seperti browser; `new Worker(...)`
  melempar eksplisit, bukan hang diam-diam).
- `pinFeilin` ('045' atau 'auto') melayani SEMUA permintaan FeiLin dari build lokal tertentu —
  mekanismenya bekerja, tapi untuk registrasi segar server menolak downgrade (F001, diukur
  2026-10-16). Pakai hanya kalau identitas registrasi memang dari era build itu (replay).
- `restart()` membangun ulang DOM = konteks device baru (dan Log1 baru di mode
  live). `isStale()` mengikuti router proxy seperti `TokenFarm`.
- Fingerprint jsdom lebih miskin dari Chrome (canvas/WebGL/audio hanya shim, tanpa
  paket `canvas` nyata); token tetap diterima Verify live (bukti T001 di riset H13),
  tapi ini kandidat perbaikan kalau kelak muncul F001.

## Proxy keluar (opsional)

Lo bisa kasih satu daftar proxy HTTP ke paket ini. Request yang dikirim paket, yaitu
Init dan Verify Aliyun serta Chrome farm, lewat proxy aktif yang sama:

```js
import { createAliyunCaptcha, TokenFarm, loadProxyRouter } from 'aliyun-captcha-solver';

const proxy = loadProxyRouter('/path/ke/proxies.txt', {
  cooldownMs: 300_000,
  timeoutMs: 60_000,         // proxy diam tanpa header respons dihitung gagal; 0 = mati
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
  CONNECT ditolak (407, 403, 5xx), tidak ada header respons sampai `timeoutMs` (proxy yang
  menerima koneksi lalu diam), atau Chrome melaporkan `ERR_PROXY_*` / `ERR_TUNNEL_*` /
  timeout (`ERR_TIMED_OUT`, halaman tidak selesai dimuat).
  Pemanggil yang menyerah menunggu header dengan `AbortSignal.timeout()` (httpPost Aliyun)
  dihitung sama dengan `timeoutMs`: proxy diam. Abort biasa dari pemanggil dan error TLS
  setelah tunnel terbentuk tidak dihitung.
- **`rotateOn(res, url)`** dipanggil untuk setiap respons dari `proxy.fetch`. Paket tidak
  tahu status atau host mana yang berarti diblokir. Keputusan itu tetap di pemanggil.
- **`rotateOnTransportErrors`** (default `false`) — kalau `true`, tunnel yang **putus di
  tengah koneksi** (`ECONNRESET`, socket hang up, undici `UND_ERR_SOCKET`/timeout body)
  dihitung sebagai kegagalan proxy juga: router pindah, dan error-nya ditandai
  `proxyFailure` untuk pemanggil. Default mati karena dari satu error saja proxy mati
  tidak bisa dibedakan dari target yang goyang, dan memindahkan proxy sehat itu mahal
  (IP sticky). Nyalakan untuk daftar proxy panjang yang isinya banyak setengah mati:
  satu entri busuk tidak lagi menahan setiap request. Klasifikasinya:
  `proxyFailureReason()` (lama, konservatif) dan `transportFailureReason()` (transport).
- **Farm** diluncurkan ulang saat proxy aktif berganti, karena Chrome tidak bisa ganti
  proxy di konteks yang sedang jalan. Device token yang sudah dipanen sebelum itu tetap
  ada di pool dan tetap bisa dipakai dari IP baru (diuji lintas-IP 2026-10-15: mint dari IP B
  dengan token dari IP A sukses dan paramnya diterima). Kalau peluncuran gagal karena proxy
  (misalnya proxy mati), `start()` mencoba
  proxy berikutnya, sebanyak jumlah proxy di daftar. Kegagalan lain dilempar seperti biasa.
- **Tanpa `proxy`**, perilakunya sama seperti sebelumnya: koneksi langsung dan fetch global.
- `proxy.fetch(url, init)` bisa dipakai pemanggil untuk request lain lewat proxy yang sama.
  `proxy.status()` untuk diagnosis.

## Yang generalisasi, yang tidak

| Komponen | Cakupan | Catatan |
|---|---|---|
| Protokol RPC + signing HMAC-SHA1 | ✅ **Global** — seluruh Aliyun Captcha 2.0 cloud | Hanya hostname berubah, dan itu otomatis diturunkan dari `prefix` + `endpointRegion` |
| Konstanta cipher (`argConstant`, `encryptKey`, perm-table) | ⚠️ **Per-SDK-build** | Terbukti lintas-scene dalam satu tenant. Tenant lain bisa punya build berbeda → verifikasi per tenant. Guard: `npm run test:solver` |
| Device token (`z_um.getToken()`) | ⚠️ **Per-tenant-ish** | `TokenFarm`: tab di origin situs target. `JsdomFarm`: jsdom + aset SDK + registrasi Log1 dari Node |
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
| `FAIL_BACKOFF_MS` | 35s | backoff verify gagal biasa. Tidak berlaku untuk kegagalan jalur proxy (`PROXY_TIMEOUT`, atau error dengan `proxyFailure`: CONNECT ditolak 407/429, proxy mati): router sudah pindah proxy, dan Aliyun tidak pernah memberi putusan |
| `DEVICE_LOW` | 5 | stok device token di bawah ini memicu harvest di latar belakang, selama ada permintaan (`IDLE_PAUSE_MS`) dan farm tidak sedang menunggu restart |
| `REFILL_RETRY_MS` | 30s | jeda antar harvest di latar belakang, berhasil atau tidak. Relaunch farm adalah rentetan koneksi proxy, jadi tidak boleh diulang tiap tick (harvest inline dalam `get()` tidak terpengaruh) |

Harvest di latar belakang dan inline berbagi satu proses (single-flight). Harvest tidak
memanggil Aliyun, jadi pacing dan backoff tidak berlaku untuknya.

`F001` juga set `pool.farmNeedsRestart = true` — sinyal ke pemilik farm untuk
bangun ulang tab (device context yang kena-flag, bukan sekadar pacing).

`pool.setStaleCheck(() => farm.isStale())` memberi tahu pool kalau farm tertinggal dari
proxy aktif. Saat itu refill latar belakang jalan walau stok masih penuh, jadi relaunch
farm (sekitar 70 dtk dari dingin) terjadi di luar jalur request. Harvest tetap single-flight.

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
npm test                # 86 test: cipher & request shape (14), pool (24), proxy (32),
                        #          farm lewat proxy (3), jsdom farm (12)
npm run test:solver     # canary rotasi konstanta Aliyun
```

`test-farm-proxy.mjs` menjalankan Chrome sungguhan (`/usr/bin/google-chrome-stable`)
melawan dua proxy lokal yang menjawab 502. Tidak ada trafik keluar.

`test-jsdom-farm.mjs` jalan tanpa jsdom (logika aset, routing XHR, health gate,
forwarding live, `isStale`) — satu tes warm-up penuh ikut jalan kalau `JSDOM_PATH`,
`JSDOM_FARM_ASSETS`, dan `JSDOM_FARM_TEST_DEVICE_CONFIG` (file berisi blob
`DeviceConfig`) di-set. Semua offline.

`test-solver.mjs` yang paling penting: kalau konstanta cipher FeiLin berubah,
test inilah yang gagal duluan — sebelum request apa pun ditolak diam-diam.

## CLI

```bash
PLAYWRIGHT_CORE_PATH=/path/ke/playwright-core/package.json \
  node src/token-farm.mjs --url https://site.tld --prefix abc123 --count 25

JSDOM_PATH=/path/ke/jsdom JSDOM_FARM_ASSETS=/path/ke/aset-sdk \
  node src/jsdom-farm.mjs --prefix abc123 --count 3      # tanpa Chrome
```

## Asal-usul

Diekstrak dari riset solver captcha chat.z.ai (`captcha-solver/` di repo
`zai`, 2026-10-13). Port dari implementasi Go (GLM-Free-API) dan Python
(glm-5.2-proxy). Bukti dan catatan investigasi ada di sana.
