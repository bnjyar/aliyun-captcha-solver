# aliyun-captcha-solver

[![test](https://github.com/bnjyar/aliyun-captcha-solver/actions/workflows/test.yml/badge.svg)](https://github.com/bnjyar/aliyun-captcha-solver/actions/workflows/test.yml)

An Alibaba captcha solver (FeiLin / Aliyun Captcha 2.0) that runs **entirely in
Node** — no paid solving service and no slider puzzle.

Generic by design: nothing is hardcoded to a platform. Only the **tenant
configuration** (AccessKey, SceneId, prefix, region) and the **site the device
token is harvested from** are site-specific, and both come from config.

```
warm browser tab  →  device token  →  CaptchaPool  →  captcha_verify_param
  (the browser's only contribution)      (pure Node)
```

The device-token farm ships with **two engines** sharing one contract
(`start` / `harvest` / `isStale` / `restart` / `stop`):

| Engine | Class | Needs | Notes |
|---|---|---|---|
| Headless Chrome (default) | `TokenFarm` | playwright-core + a Chrome profile | warm tab; the most battle-tested path |
| Node + jsdom (**no Chrome**) | `JsdomFarm` | jsdom + SDK assets | `AliyunCaptcha.js` runs inside jsdom; device registration (`Log1`) goes to the network from Node; tokens pass live Verify |

## Scope and acceptable use

- Scope: **Aliyun Captcha 2.0 (FeiLin) with the `TRACELESS` challenge only**. Not
  reCAPTCHA/hCaptcha/Turnstile, not an image grid, not a slider.
- MIT licensed (see [`LICENSE`](LICENSE)), no warranty of any kind.
- Use this only on systems you are authorized to test or automate. Minting captcha
  params may violate the target service's terms and local law; you are responsible
  for how you use it.

## How it works

The Aliyun risk engine does not inspect the client at verification time — trust is
established when the token is *minted*. The browser's only job is therefore the
**device token**, harvested from one warm tab via `window.z_um.getToken()`. After
that, Init, Verify and param construction all run in Node.

`JsdomFarm` removes even that tab: the SDK runs inside jsdom, and
`z_um.getToken()` remains a local computation inside the document (zero requests
per token). Only warm-up touches the network (`Log1` registration plus
`Log2`/`Log3` fingerprint upload).

One consequence you have to accept: **one farm per site**. Device tokens look like
`SG_WEB#<fp>...` and come from cloudauth; they are most likely tenant-scoped, so a
token from site A is not necessarily valid for tenant B.

## Install

```bash
npm install aliyun-captcha-solver
```

`playwright-core` is only needed for `TokenFarm`. It is an optional peer
dependency: if your app already has it, it resolves automatically. Otherwise set
`PLAYWRIGHT_CORE_PATH=/path/to/playwright-core/package.json`.

Chrome is discovered automatically: `CHROME_PATH` → the well-known locations on
Linux, macOS and Windows → Playwright's own resolution (or pass
`opts.executablePath`). The user agent is derived from the **browser version
actually running** and the host OS, so it never contradicts the browser's own
fingerprint. `CHROME_MAJOR_VERSION` can override version detection (handy in a
read-only container).

`jsdom` (>= 30) is only needed for `JsdomFarm` — also an optional peer dependency.
If it is not installed in your app, set `JSDOM_PATH=/path/to/jsdom` (the package
directory or its `package.json`).

`undici` is installed automatically and is used for the proxy path (see below).
Requires Node >= 20.18.1 (jsdom 30 realistically needs a modern Node; tested on
Node 26).

When the solver is consumed through `file:` (a symlink rather than the registry),
npm does **not** install its dependencies in the consuming app. Run `npm install`
in the solver folder itself; a `postinstall` hook in the host app is a common way
to automate that. For the solver's own tests, `playwright-core` and `jsdom` are
`devDependencies`, so `npm install` here is enough to run `npm test`.

## Usage

TypeScript declarations for the root entry ship with the package
(`src/index.d.ts`).

```js
import { createAliyunCaptcha, CaptchaPool, TokenFarm } from 'aliyun-captcha-solver';

// 1. Client for one tenant
const captcha = createAliyunCaptcha({
  accessKey: process.env.ALIYUN_ACCESS_KEY,
  secretKey: process.env.ALIYUN_SECRET_KEY,
  sceneId:   'your-scene-id',   // public value, found in the target site's JS
  prefix:    'your-prefix',
  region:    'sgp',             // SDK region token (window.AliyunCaptchaConfig)
  endpointRegion: 'southeast',  // DNS region token in the hostname
  // challengePolicy: 'warn',   // 'warn' (default) or 'throw'
  // log: (msg) => console.log(msg), // optional: per-mint timing, Init and Verify split
});

// 2. Device-token farm (needs a browser)
const farm = new TokenFarm({
  url: 'https://target.example',
  prefix: 'your-prefix',
  region: 'sgp',
  profile: '/path/to/chrome-profile', // null = ephemeral context
  verbose: true,
});
await farm.start();

// 3. Warm param pool with pacing + backoff
const pool = new CaptchaPool({ captcha, verbose: true });
pool.setCollector(() => farm.harvest(25));
await pool.start();

const param = await pool.get(30_000); // captcha_verify_param, or null
```

If you only need one param and already have a device token, skip the browser
entirely and call `captcha.computeCaptchaParam(deviceToken)`.

## The Chrome-free farm (`JsdomFarm`)

A drop-in replacement for `TokenFarm`: `AliyunCaptcha.js` runs inside jsdom and
device registration (`Log1`) is sent from Node — **there is no Chrome anywhere**.

```js
import { createAliyunCaptcha, CaptchaPool, JsdomFarm, loadProxyRouter } from 'aliyun-captcha-solver';

const proxy = loadProxyRouter('/path/to/proxies.txt', { cooldownMs: 300_000, timeoutMs: 20_000 });
const farm = new JsdomFarm({
  url: 'https://target.example',     // page origin (the SDK does not need the site's JS)
  prefix: 'your-prefix',
  region: 'sgp',
  proxy,                              // every farm egress leaves through the active proxy
  assetsDir: '/path/to/sdk-assets',   // optional: AliyunCaptcha.js + feilin*.js from disk
  cacheDir: '/path/to/cache',         // optional: CDN asset cache
  verbose: true,
});
await farm.start();                    // ~2-8 s (Log1 + assets + feilin)
const tokens = await farm.harvest(25); // string[] (same as TokenFarm)

const pool = new CaptchaPool({ captcha });
pool.setCollector(() => farm.harvest(25));
```

Recognised environment variables (optional, same meaning as the options above):
`JSDOM_PATH` (jsdom location), `JSDOM_FARM_ASSETS` (SDK asset directory),
`JSDOM_FARM_CACHE` (CDN download cache; defaults to
`~/.cache/aliyun-captcha-solver/jsdom-assets`).

Network rules:

- **`live` mode (default)** — in-page device XHRs (`Log1` registration,
  `Log2`/`Log3` fingerprint upload) are forwarded to the real network through
  `fetchImpl` (= `proxy.fetch` when `proxy` is given). Set `auditDir` to dump raw
  request/response pairs while debugging.
- **`replay` mode** — `Log1` is answered from a supplied `deviceConfig` blob
  (captured earlier); fully offline. For tests and debugging.
- Sub-resources: served from `assetsDir`; anything missing there is fetched
  statically from `*.alicdn.com` (the FeiLin build can rotate at any time — the
  `DeviceConfig` decides which one) and then cached. Every other host is blocked.
- `z_um.getToken()` itself **never touches the network** (local SDK computation).

Operational notes:

- **Warm-up is retried** (`warmAttempts`, default 2; env
  `JSDOM_FARM_WARM_ATTEMPTS`). Each attempt builds a fresh DOM (plus a fresh
  `Log1` registration in live mode) and drops CDN-downloaded assets first, so a
  half-written download is never reused forever. A cold farm **re-warms itself**
  on the next `harvest()` (the pool's collector path), so a transient failure does
  not kill it permanently; `stats().warmFailures` / `lastWarmError` show the cause.
  Retrying does **not** help when a new SDK build genuinely needs an API that is
  not shimmed yet — that is a shim fix, and there is no "downgrade build" path (the
  server flags downgrades as `F001`).
- **Token-length health check.** If registration fails, the SDK installs a
  `z_um.getToken = () => ""` stub without raising an error — `start()` rejects
  tokens shorter than `minTokenLen` (default 500) and, in live mode, rejects a
  `Log1` that is not `Code 200` + `DeviceConfig`.
- **The FeiLin build follows the server.** `DeviceConfig.version` decides which
  build is loaded; one that is not in `assetsDir` is fetched statically from the
  CDN and cached. **Do not pin a build for a fresh registration** — the server
  binds the build to the registration it issued and flags downgrades (`F001`,
  measured during development). `pinFeilin` is only for sessions that reuse an
  older registration identity (`replay` mode). The build in use is visible in
  `stats().feilin` (and in a caller's `/healthz`, for example).
- **feilin 1.5.2/048** reads the global `Worker` inside obfuscated expressions that
  run synchronously on the `getToken` path. jsdom has no `Worker`, so the farm
  installs a **read-only marker** (`!Worker` → false, like a browser;
  `new Worker(...)` throws explicitly instead of hanging silently).
- `pinFeilin` (`'045'` or `'auto'`) serves EVERY FeiLin request from one local
  build — the mechanism works, but fresh registrations are rejected as downgrades
  (`F001`). Use it only when the registration identity really comes from that build
  era (`replay`).
- `restart()` rebuilds the DOM = a new device context (and a new `Log1` in live
  mode). `isStale()` follows the proxy router exactly like `TokenFarm`.
- A jsdom fingerprint is poorer than Chrome's (canvas/WebGL/audio are shims only,
  with no real `canvas` package). Tokens still pass live Verify, but this is the
  first candidate to improve if `F001` ever appears.

## Non-traceless challenges (slider)

This solver only builds the param for the **`TRACELESS`** challenge (no slider):
its `TrackList` is intentionally empty. `InitCaptchaV3` reports the challenge it
issued as `CaptchaType`; if the server issues another type, Verify rejects the
param and the reason is easy to miss.

`createAliyunCaptcha({ challengePolicy })` controls the reaction:

| Value | Behaviour |
|---|---|
| `'warn'` (default) | Log one line and continue. Never blocks a mint. |
| `'throw'` | Throw `CHALLENGE_NOT_TRACELESS` before Verify, saving one paced call. |

The default is `warn` because the full set of `CaptchaType` values across tenants
is not mapped; blocking on a guess could kill a setup that actually works. Once
you have observed the values your tenant returns, switch to `'throw'`. The last
Init response is always available as `captcha.lastInit` (including
`CaptchaType`), and `pool.stats().lastError.captchaType` keeps the last failing
one.

## Outbound proxy (optional)

You can give the package one HTTP proxy list. Requests the package sends — Aliyun
Init and Verify, plus the Chrome farm — leave through the same active proxy:

```js
import { createAliyunCaptcha, TokenFarm, loadProxyRouter } from 'aliyun-captcha-solver';

const proxy = loadProxyRouter('/path/to/proxies.txt', {
  cooldownMs: 300_000,
  timeoutMs: 60_000,         // a silent proxy (no response headers) counts as failed; 0 = off
  rotateOn: null,            // (res, url) => reason | null; a string moves to the next proxy
  log: console.log,
});

const captcha = createAliyunCaptcha({ /* ... */, proxy });
const farm = new TokenFarm({ /* ... */, proxy });
```

List format, one per line (blank lines and `#` are ignored): `host:port:user:pass`
(a typical proxy-provider export), `user:pass@host:port`, or `host:port`. HTTP
(CONNECT) only. Error messages name the line number, never its contents.

- **Sticky.** One proxy is used until it fails, then the next one is selected and
  the failed entry cools down for `cooldownMs`. Init and Verify must leave from
  the same IP, so there is no per-request rotation.
- **Counted as failures:** the proxy cannot be reached (`ECONNREFUSED` and
  friends), CONNECT is refused (407, 403, 5xx), no response headers arrive within
  `timeoutMs` (the proxy accepts the connection then goes silent), or Chrome
  reports `ERR_PROXY_*` / `ERR_TUNNEL_*` / a timeout (`ERR_TIMED_OUT`, page never
  finishes loading). A caller that gives up waiting for headers via
  `AbortSignal.timeout()` (the Aliyun `httpPost`) is treated like `timeoutMs`: a
  silent proxy. A plain caller abort and a TLS error after the tunnel is
  established are not counted.
- **`rotateOn(res, url)`** runs for every response from `proxy.fetch`. The package
  does not know which status or host means "blocked"; that decision stays with the
  caller.
- **`rotateOnTransportErrors`** (default `false`) — when `true`, a tunnel that
  **breaks mid-connection** (`ECONNRESET`, socket hang up, undici
  `UND_ERR_SOCKET`/body timeout) also counts as a proxy failure: the router moves
  on and the error is marked `proxyFailure` for the caller. Off by default because
  a single error cannot distinguish a dead proxy from a flaky target, and moving
  away from a healthy proxy is expensive (sticky IP). Turn it on for long, cheap
  lists full of half-dead entries: one bad entry no longer stalls every request.
  The classifiers are `proxyFailureReason()` (older, conservative) and
  `transportFailureReason()` (transport-level).
- **The farm** relaunches when the active proxy changes, because Chrome cannot
  switch proxies on a live context. Device tokens harvested beforehand stay in the
  pool and remain usable from the new IP (tested across IPs: minting from IP B with
  a token from IP A succeeds and the param is accepted). If a launch fails because
  of the proxy (a dead proxy, for example), `start()` tries the next proxy, up to
  the number of entries in the list. Other failures are thrown as usual.
- **Without `proxy`**, behaviour is unchanged: direct connections and global
  `fetch`.
- `proxy.fetch(url, init)` is available for your own requests through the same
  proxy. `proxy.status()` is for diagnostics.

## What generalizes, what does not

| Component | Coverage | Notes |
|---|---|---|
| RPC protocol + HMAC-SHA1 signing | ✅ **Global** — the whole Aliyun Captcha 2.0 cloud | Only the hostname changes, and it is derived automatically from `prefix` + `endpointRegion` |
| Cipher constants (`argConstant`, `encryptKey`, perm table) | ⚠️ **Per SDK build** | Proven across scenes within one tenant. Other tenants may ship a different build → verify per tenant. Guard: `npm run test:solver` |
| Device token (`z_um.getToken()`) | ⚠️ **Per-tenant-ish** | `TokenFarm`: a tab on the target site's origin. `JsdomFarm`: jsdom + SDK assets + a `Log1` registration from Node |
| Outbound proxy path (`proxy`) | ✅ **Global** — identical for every site | The "which status means blocked" choice belongs to the caller (`rotateOn`) |

What this package does **not** include: how the param is consumed (header, body,
or any other field owned by the target app). That is reversed per site, not
generic.

## Pacing and backoff

Defaults in `CaptchaPool`; override them through `timing`:

| Constant | Default | Meaning |
|---|---|---|
| `PARAM_TTL_MS` | 75s | param lifetime |
| `MAX_PARAMS` | 2 | warm params kept. `0` = on-demand: Verify only runs inside `get()`, no background minting |
| `IDLE_PAUSE_MS` | 180s | with no `get()` for this long, the pool stops minting entirely, including refills of still-live params |
| `MIN_GEN_INTERVAL_MS` | 10s | minimum gap between Verifies |
| `F001_PAUSE_MS` | 300s | risk-control cooldown |
| `F011_PAUSE_MS` | 60s | frequency/desync cooldown |
| `FAIL_BACKOFF_MS` | 35s | backoff after a generic Verify failure. Does not apply to proxy-path failures (`PROXY_TIMEOUT`, or an error carrying `proxyFailure`: refused CONNECT 407/429, dead proxy): the router has already moved on and Aliyun never returned a verdict |
| `DEVICE_LOW` | 5 | below this many device tokens, a background harvest starts — while there is demand (`IDLE_PAUSE_MS`) and the farm is not waiting for a restart |
| `REFILL_RETRY_MS` | 30s | gap between background harvests, successful or not. A farm relaunch is a burst of proxy connections, so it must not repeat every tick (an inline harvest inside `get()` is unaffected) |

Background and inline harvests share one run (single-flight). Harvesting does not
call Aliyun, so pacing and backoff do not apply to it.

`F001` also sets `pool.farmNeedsRestart = true` — a signal to the farm owner to
rebuild the tab (the device context was flagged, this is not just pacing).

`pool.setStaleCheck(() => farm.isStale())` tells the pool when the farm is behind
the active proxy. Background refill then runs even with a full stock, so the farm
relaunch (~70 s from cold) happens off the request path. Harvest remains
single-flight.

Verify never runs concurrently: at most one mint is in flight, whether started by
the background tick or by `get()` (single-flight). A caller that finds a mint
running waits for its result instead of starting a second Verify.

### Diagnosis: `pool.stats().lastError`

The last failed mint exposes `code` (an Aliyun code such as `F011`, or `ERROR` for
other failures), `message` (a slice of the Aliyun response), `captchaType` (the
challenge Init issued — `TRACELESS` means no slider), and `ageSec`. The field is
kept after recovery, so `ageSec` shows how stale it is.

## Tests

```bash
npm test                # 97 tests: cipher & request shape (14), pool (24), proxy (32),
                        #          cross-platform chrome (7), farm over proxy (3), jsdom farm (17)
npm run test:solver     # canary for Aliyun constant rotation
```

`test-farm-proxy.mjs` drives a real Chrome against two local proxies that answer
502. No traffic leaves the machine. When Chrome is not found the test **skips
itself** (rather than failing), so `npm test` stays green on a machine without
Chrome; set `CHROME_PATH` to force it.

`test-jsdom-farm.mjs` runs without jsdom (asset indexing, XHR routing, health gate,
live forwarding, `isStale`) — one full warm-up test also runs when `JSDOM_PATH`,
`JSDOM_FARM_ASSETS` and `JSDOM_FARM_TEST_DEVICE_CONFIG` (a file containing a
`DeviceConfig` blob) are set. Everything is offline.

`test-solver.mjs` is the most important one: if the FeiLin cipher constants
change, this test fails first — before any request is silently rejected.

## CLI

```bash
CHROME_PATH=/path/to/chrome \
PLAYWRIGHT_CORE_PATH=/path/to/playwright-core/package.json \
  node src/token-farm.mjs --url https://target.example --prefix your-prefix --count 25

JSDOM_PATH=/path/to/jsdom JSDOM_FARM_ASSETS=/path/to/sdk-assets \
  node src/jsdom-farm.mjs --prefix your-prefix --count 3      # no Chrome
```

## Origin

Ported from earlier Go and Python implementations of the same protocol. The
investigation notes are not part of this repository.
