// jsdom-farm.mjs — device-token farm WITHOUT Chrome: the real Aliyun captcha SDK
// runs inside jsdom (Node) and window.z_um.getToken() yields the device tokens.
//
// Same contract as TokenFarm (see ./token-farm.mjs):
//     const farm = new JsdomFarm({ prefix: 'no8xfe', region: 'sgp', proxy });
//     await farm.start();               // warms once
//     const tokens = await farm.harvest(25);
//
// Modes:
//   live   (default) — the page's device XHRs (Log1 = device registration, Log2/Log3
//           = fingerprint upload) are forwarded to the real network through `fetchImpl`
//           (the caller's ProxyRouter.fetch when a `proxy` is given), so the SDK warms
//           from a genuinely fresh registration. Request/response bodies are only kept
//           in memory (plus `auditDir`, when set, for debugging).
//   replay — device XHRs are answered from `deviceConfig` (a DeviceConfig blob captured
//           earlier). Fully offline; the SDK still collects and uploads nothing, and
//           z_um.getToken() still runs locally. For tests/debugging.
//
// Network rules (both modes): sub-resources are served from `assetsDir`; anything
// missing there is fetched statically from *.alicdn.com through `fetchImpl` and cached
// in `cacheDir`. Nothing else leaves the process. z_um.getToken() itself never touches
// the network.
//
// jsdom is an OPTIONAL peer dependency, resolved like playwright-core in TokenFarm:
// it is require()d from the host app, or from JSDOM_PATH (a module name, a package dir,
// or its package.json).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
const DEVICE_HOST_RE = /(^|\.)cloudauth-device[^/]*\.aliyuncs\.com$|(^|\.)device\.saf\.aliyuncs\.com$/;
const CDN_HOST_RE = /(^|\.)alicdn\.com$/;
const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.cache', 'aliyun-captcha-solver', 'jsdom-assets');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve the jsdom module from the host app or JSDOM_PATH (module, package dir, or package.json). */
export function resolveJsdom() {
  const candidates = [process.env.JSDOM_PATH, 'jsdom'].filter(Boolean);
  const errors = [];
  for (const c of candidates) {
    try {
      const isPath = c.includes('/') || c.startsWith('.');
      const target = isPath ? (path.basename(c) === 'package.json' ? path.dirname(path.resolve(c)) : path.resolve(c)) : c;
      const mod = require(target);
      const picked = mod && mod.JSDOM ? mod : mod?.default?.JSDOM ? mod.default : null;
      if (picked) return picked;
      errors.push(`${c}: no JSDOM export (keys: ${Object.keys(mod || {}).slice(0, 6)})`);
    } catch (e) {
      errors.push(`${c}: ${e.message}`);
    }
  }
  throw new Error(
    'jsdom not found. Install it in your app (npm i jsdom), or set JSDOM_PATH to its package dir/package.json. Tried:\n  ' +
      errors.join('\n  ')
  );
}

/** Basename → full path for a local asset directory (missing dir = empty index). */
export function indexAssets(dir) {
  const index = { all: new Map(), byBase: new Map() };
  if (!dir || !fs.existsSync(dir)) return index;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    index.all.set(name, full);
  }
  return index;
}

/**
 * Pick the local file for a requested URL: exact basename first, then the FeiLin
 * build number (a captured bundle may be named feilin048-full.js rather than
 * feilin048.<sha>.js). Null = not local (caller fetches + caches).
 *
 * `pin` (e.g. '045') makes every FeiLin request resolve to that local build — the
 * server picks the build by `DeviceConfig.version` and can rotate it at any time;
 * pinning freezes the runtime the farm runs (see `pinFeilin`). The returned entry
 * carries `pinned: true` so callers can report the substitution.
 */
export function pickLocalAsset(index, url, pin = null) {
  let base = '';
  try { base = path.basename(new URL(url).pathname); } catch { return null; }
  if (!base) return null;
  const feilin = base.match(/^(feilin\d+)/);
  if (feilin && pin) {
    const wanted = String(pin).toLowerCase() === 'auto'
      ? newestFeilinBuild(index)
      : String(pin).replace(/^feilin/i, '').replace(/\D/g, '');
    if (!wanted) return null;
    const wantedNum = Number(wanted);
    const askedNum = Number(feilin[1].replace('feilin', ''));
    for (const [name, full] of index.all) {
      const m = name.match(/^feilin(\d+)/);
      if (m && name.endsWith('.js') && Number(m[1]) === wantedNum) {
        return { file: full, pinned: askedNum !== wantedNum }; // substitusi build = 'pinned'
      }
    }
    return null; // pinned build not on disk: caller decides (fetch / fail)
  }
  if (index.all.has(base)) return { file: index.all.get(base), pinned: false };
  if (feilin) {
    for (const [name, full] of index.all) {
      if (name.startsWith(feilin[1]) && name.endsWith('.js')) return { file: full, pinned: false };
    }
  }
  return null;
}

/** Highest FeiLin build number present in an asset index, zero-padded ('048'), or null. */
export function newestFeilinBuild(index) {
  let best = null;
  for (const name of index.all.keys()) {
    const m = name.match(/^feilin(\d+)/);
    if (!m) continue;
    if (best === null || Number(m[1]) > Number(best)) best = m[1];
  }
  return best;
}

// --- browser shims (jsdom has no canvas/WebGL/audio/Worker; the SDK tolerates
//     degraded signals — it only needs the globals to exist) -------------------

function makeFake2D() {
  const px = new Uint8ClampedArray(4 * 16 * 16);
  return {
    canvas: null,
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1,
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    shadowBlur: 0, shadowColor: 'transparent', globalCompositeOperation: 'source-over',
    measureText: (s) => ({ width: String(s).length * 7.5, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    fillRect() {}, clearRect() {}, strokeRect() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, arc() {}, arcTo() {}, bezierCurveTo() {}, quadraticCurveTo() {},
    rect() {}, fill() {}, stroke() {}, clip() {}, save() {}, restore() {}, translate() {},
    rotate() {}, scale() {}, transform() {}, setTransform() {}, resetTransform() {},
    drawImage() {}, createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }), createPattern: () => null,
    fillText() {}, strokeText() {}, setLineDash() {}, getLineDash: () => [],
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: px.slice(0, w * h * 4) }),
    putImageData() {}, isPointInPath: () => false, isPointInStroke: () => false,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
}

function makeFakeGL(canvas) {
  const UNMASKED = { getParameter: (p) => ({ 37445: 'Google Inc. (Mesa)', 37446: 'ANGLE (Mesa, llvmpipe, OpenGL 4.5)' }[p] ?? 'fake') };
  return {
    canvas,
    getExtension: (n) => (/WEBGL_debug_renderer_info/.test(n) ? UNMASKED : (n === 'WEBGL_lose_context' ? { loseContext() {} } : null)),
    getSupportedExtensions: () => ['WEBGL_debug_renderer_info', 'EXT_texture_filter_anisotropic', 'OES_texture_float'],
    getParameter: (p) => ({
      37445: 'Google Inc. (Mesa)', 37446: 'ANGLE (Mesa, llvmpipe, OpenGL 4.5)',
      7938: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)', 35724: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      3379: 8192, 34921: 16, 36347: 1024, 36348: 32, 36349: 1024, 3410: 8, 3411: 8, 3412: 8,
      3413: 8, 3414: 24, 3415: 8, 34047: 16, 34076: 16384, 3386: [32767, 32767], 33902: [1, 1], 33901: [1, 1024],
    }[p] ?? 'fake-' + p),
    getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
    getAttribLocation: (p, n) => String(n).length % 4,
    getUniformLocation: () => ({}), createShader: () => ({}), createProgram: () => ({}),
    shaderSource() {}, compileShader() {}, attachShader() {}, linkProgram() {}, useProgram() {},
    getShaderParameter: () => true, getProgramParameter: () => true, getShaderInfoLog: () => '',
    getProgramInfoLog: () => '', getActiveUniform: () => null, getActiveAttrib: () => null,
    getError: () => 0, createBuffer: () => ({}), bindBuffer() {}, bufferData() {},
    createTexture: () => ({}), bindTexture() {}, texImage2D() {}, texParameteri() {},
    createFramebuffer: () => ({}), bindFramebuffer() {}, framebufferTexture2D() {},
    viewport() {}, enable() {}, disable() {}, clear() {}, clearColor() {}, drawArrays() {},
    drawElements() {}, deleteShader() {}, deleteProgram() {}, activeTexture() {},
    pixelStorei() {}, generateMipmap() {}, uniform1i() {}, uniform1f() {}, uniformMatrix4fv() {},
    readPixels() {}, getContextAttributes: () => ({ alpha: true, antialias: true, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false }),
  };
}

export function installShims(window, shimUse = new Set()) {
  const proto = window.HTMLCanvasElement.prototype;
  const origGetContext = proto.getContext;
  proto.getContext = function (type, ...rest) {
    shimUse.add('canvas.getContext:' + type);
    if (/webgl/i.test(type)) return makeFakeGL(this);
    if (type === '2d') return makeFake2D();
    return origGetContext ? origGetContext.call(this, type, ...rest) : null;
  };
  proto.toDataURL = function () {
    shimUse.add('canvas.toDataURL');
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  };
  proto.toBlob = function (cb) { shimUse.add('canvas.toBlob'); setTimeout(() => cb(new window.Blob([Buffer.alloc(0)], { type: 'image/png' })), 0); };

  class FakeAudioContext {
    constructor() { shimUse.add('AudioContext'); this.sampleRate = 44100; this.state = 'suspended'; this.destination = {}; this.currentTime = 0; }
    createOscillator() { const o = { type: 'sine', frequency: { value: 440, setValueAtTime() {} }, connect() { return o; }, start() {}, stop() {}, disconnect() {}, onended: null }; return o; }
    createAnalyser() { return { fftSize: 2048, frequencyBinCount: 1024, connect: () => ({}), disconnect() {}, getFloatFrequencyData(a) { a.fill(-100); }, getByteFrequencyData(a) { a.fill(0); } }; }
    createGain() { return { gain: { value: 1, setValueAtTime() {} }, connect: () => ({}) }; }
    createDynamicsCompressor() { return { threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, connect: () => ({}) }; }
    createScriptProcessor() { return { connect: () => ({}), onaudioprocess: null }; }
    createBufferSource() { return { connect: () => ({}), start() {}, stop() {}, buffer: null }; }
    createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
    close() { return Promise.resolve(); }
    resume() { return Promise.resolve(); }
  }
  window.AudioContext = FakeAudioContext;
  window.webkitAudioContext = FakeAudioContext;
  window.OfflineAudioContext = FakeAudioContext;

  if (!window.matchMedia) window.matchMedia = (q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, onchange: null, dispatchEvent: () => false });
  if (window.screen) ['width', 'height', 'availWidth', 'availHeight'].forEach((k) => {
    try { Object.defineProperty(window.screen, k, { get: () => (/width/i.test(k) ? 1280 : 800), configurable: true }); } catch { /* noop */ }
  });
  Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true });
  if (!window.requestIdleCallback) window.requestIdleCallback = (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 1);
  if (!window.crypto) window.crypto = {};
  if (!window.crypto.getRandomValues) {
    shimUse.add('crypto.getRandomValues');
    window.crypto.getRandomValues = (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; };
  }
  if (!window.crypto.randomUUID) window.crypto.randomUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); });
  if (!window.crypto.subtle) {
    shimUse.add('crypto.subtle(missing->shim)');
    window.crypto.subtle = { digest: () => Promise.resolve(new ArrayBuffer(32)), importKey: () => Promise.resolve({}), encrypt: () => Promise.resolve(new ArrayBuffer(16)), decrypt: () => Promise.resolve(new ArrayBuffer(16)), sign: () => Promise.resolve(new ArrayBuffer(32)) };
  }
  if (!window.navigator.hardwareConcurrency) Object.defineProperty(window.navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  Object.defineProperty(window.navigator, 'deviceMemory', { get: () => 8, configurable: true });
  Object.defineProperty(window.navigator, 'webdriver', { get: () => false, configurable: true });
  if (!window.navigator.plugins || window.navigator.plugins.length === 0) shimUse.add('navigator.plugins(empty)');
  if (!window.PerformanceObserver) window.PerformanceObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  if (!window.ResizeObserver) window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!window.IntersectionObserver) window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  if (!window.Notification) window.Notification = class { static permission = 'default'; static requestPermission() { return Promise.resolve('default'); } };
  // FeiLin 1.5.2/048 reads the global `Worker` inside obfuscated expressions that
  // run synchronously on the getToken path; jsdom has no Worker → ReferenceError.
  // Browsers define it. The marker keeps `!Worker` falsy like a browser while
  // construction still fails loudly (never a silent hang).
  if (!window.Worker) {
    shimUse.add('Worker(read-only marker)');
    window.Worker = class Worker { constructor() { throw new Error('jsdom farm: Worker is not implemented'); } };
  }
  if (!window.indexedDB) window.indexedDB = { open: () => ({ onsuccess: null, onerror: null, result: { createObjectStore() {}, transaction: () => ({ objectStore: () => ({ put() {}, get() {} }) }) } }), deleteDatabase: () => ({}) };
  if (!window.localStorage) {
    const store = new Map();
    Object.defineProperty(window, 'localStorage', { value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear(), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } }, configurable: true });
  }
  if (window.screen && !window.screen.orientation) window.screen.orientation = { type: 'landscape-primary', angle: 0, addEventListener() {}, removeEventListener() {} };
  if (!window.visualViewport) window.visualViewport = { width: 1280, height: 800, scale: 1, addEventListener() {}, removeEventListener() {} };
}

export class JsdomFarm {
  /**
   * @param {object}  opts
   * @param {string}  [opts.url]            page origin for the SDK (default https://chat.z.ai)
   * @param {string}  [opts.prefix]         Aliyun tenant prefix, e.g. 'no8xfe'
   * @param {string}  [opts.region]         SDK region token, e.g. 'sgp'
   * @param {'live'|'replay'} [opts.mode]   'live' (default): register the device over the
   *                                        real network; 'replay': answer Log1 from `deviceConfig`
   * @param {string}  [opts.deviceConfig]   DeviceConfig blob for replay mode
   * @param {string}  [opts.assetsDir]      dir with AliyunCaptcha.js / feilin*.js (env JSDOM_FARM_ASSETS)
   * @param {string}  [opts.cacheDir]       where CDN downloads are cached (env JSDOM_FARM_CACHE)
   * @param {string}  [opts.pinFeilin]      build number ('045') or 'auto' (highest local build):
   *                                        every FeiLin request is served from that local build,
   *                                        whatever `DeviceConfig.version` asks for (env
   *                                        JSDOM_FARM_PIN_FEILIN). Makes the farm immune to the
   *                                        server rotating the FeiLin build; stop pinning (or bump
   *                                        the pin) when Aliyun starts rejecting old builds (F00x).
   * @param {string}  [opts.auditDir]       live mode: dump raw device request/response pairs here
   * @param {object}  [opts.proxy]          ProxyRouter from ./proxy.mjs. Every outbound call the
   *                                        farm makes (Log1/Log2/Log3, asset downloads) leaves
   *                                        through the active proxy, and the farm reports a moved
   *                                        router through isStale().
   * @param {function}[opts.fetchImpl]      override the outbound fetch entirely (tests)
   * @param {number}  [opts.timeoutMs]      z_um wait budget (default 15000)
   * @param {number}  [opts.settleMs]       extra wait after z_um appears (default 0)
   * @param {number}  [opts.minTokenLen]    health gate: shorter token = broken SDK (default 500)
   * @param {boolean} [opts.verbose]
   */
  constructor({
    url = 'https://chat.z.ai',
    prefix,
    region = 'sgp',
    mode = 'live',
    deviceConfig = null,
    assetsDir = process.env.JSDOM_FARM_ASSETS || null,
    cacheDir = process.env.JSDOM_FARM_CACHE || DEFAULT_CACHE_DIR,
    pinFeilin = process.env.JSDOM_FARM_PIN_FEILIN || null,
    auditDir = null,
    proxy = null,
    fetchImpl = null,
    timeoutMs = 15000,
    settleMs = 0,
    minTokenLen = 500,
    verbose = false,
  } = {}) {
    if (!prefix) throw new Error('JsdomFarm requires prefix');
    if (mode !== 'live' && mode !== 'replay') throw new Error(`JsdomFarm: unknown mode "${mode}"`);
    if (mode === 'replay' && !deviceConfig) throw new Error('JsdomFarm: replay mode needs deviceConfig');
    this.url = url;
    this.prefix = prefix;
    this.region = region;
    this.mode = mode;
    this.deviceConfig = deviceConfig;
    this.assetsDir = assetsDir;
    this.cacheDir = cacheDir;
    this.pinFeilin = pinFeilin ? String(pinFeilin).trim() || null : null;
    this.auditDir = auditDir;
    this.proxy = proxy;
    this.fetchImpl = fetchImpl || (proxy ? (u, i) => proxy.fetch(u, i) : (u, i) => fetch(u, i));
    this.timeoutMs = timeoutMs;
    this.settleMs = settleMs;
    this.minTokenLen = minTokenLen;
    this.verbose = verbose;

    this.dom = null;
    this.window = null;
    this.warmed = false;
    this.state = 'idle';
    this.launchedProxy = null;
    this.shimUse = new Set();
    this.liveRequests = []; // per-request summary (no bodies)
    this.log1 = null;
    this.blockedHosts = new Map();
    this.marks = {};
    this.auditSeq = 0;
  }

  log(...a) {
    if (this.verbose) console.log('[jsdom-farm]', ...a);
  }

  // --- asset serving -----------------------------------------------------------

  serveLocal(index, requestUrl) {
    const hit = pickLocalAsset(index, requestUrl, this.effectivePin(index));
    if (!hit) return null;
    const base = path.basename(hit.file);
    const build = (base.match(/^feilin(\d+)/) || [])[1] || null;
    if (build) {
      this.feilinBuild = build;
      this.feilinSource = 'local';
      const asked = (path.basename(new URL(requestUrl).pathname).match(/feilin(\d+)/) || [])[1] || null;
      this.feilinRequested = asked;
    }
    if (hit.pinned) {
      this.pinnedServes = (this.pinnedServes || 0) + 1;
      this.log(`feilin pinned: ${path.basename(hit.file)} served for ${path.basename(new URL(requestUrl).pathname).slice(0, 40)}`);
    }
    return { body: fs.readFileSync(hit.file), from: hit.file, pinned: hit.pinned };
  }

  /** 'auto' → highest local build (assets dir wins over the CDN cache's opaque names). */
  effectivePin(index) {
    if (!this.pinFeilin) return null;
    if (this.pinFeilin !== 'auto') return this.pinFeilin;
    const auto = newestFeilinBuild(index);
    if (!auto) {
      this.log('pinFeilin=auto tapi tidak ada feilin* di assets dir — tidak dipin');
      return null;
    }
    return auto;
  }

  makeInterceptor(index) {
    return (request) =>
      (async () => {
        const url = request.url;
        const local = this.serveLocal(index, url);
        if (local) return new Response(local.body, { headers: this.contentType(url) });
        let host = '';
        try { host = new URL(url).host; } catch { /* noop */ }
        if (CDN_HOST_RE.test(host)) {
          const cached = this.cachePath(url);
          const build = (path.basename(new URL(url).pathname).match(/feilin(\d+)/) || [])[1] || null;
          if (build) {
            this.feilinBuild = build;
            this.feilinRequested = build;
            this.feilinSource = 'cdn';
          }
          if (cached && fs.existsSync(cached)) return new Response(fs.readFileSync(cached), { headers: this.contentType(url) });
          this.log('cdn-fetch', url.slice(0, 120));
          const r = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
          const buf = Buffer.from(await r.arrayBuffer());
          if (cached && r.status === 200) {
            fs.mkdirSync(path.dirname(cached), { recursive: true });
            fs.writeFileSync(cached, buf);
          }
          return new Response(buf, { status: r.status, headers: this.contentType(url, r.headers.get('content-type')) });
        }
        this.blockedHosts.set(host, (this.blockedHosts.get(host) || 0) + 1);
        this.log('resource-blocked', url.slice(0, 120));
        return Response.error();
      })();
  }

  contentType(url, fromServer = null) {
    if (/\.css/.test(url)) return { 'content-type': 'text/css' };
    return { 'content-type': fromServer || 'application/javascript' };
  }

  cachePath(url) {
    if (!this.cacheDir) return null;
    const name = Buffer.from(url).toString('base64url').slice(0, 160);
    return path.join(this.cacheDir, name);
  }

  // --- device XHR routing ------------------------------------------------------

  /** live → forward Log1/Log2/Log3 to the network; replay → answer from the blob. */
  routeDevice(action) {
    if (this.mode === 'live') return { kind: 'live', note: `live ${action || 'device-xhr'}` };
    if (action === 'Log1' || action === null) {
      return {
        kind: 'ok', status: 200, note: 'replay DeviceConfig (Log1/INIT)',
        body: JSON.stringify({ ResultObject: { DeviceConfig: this.deviceConfig }, Message: 'success', RequestId: '00000000-0000-0000-0000-000000000000', Code: '200' }),
      };
    }
    return { kind: 'ok', status: 200, note: `replay ${action}`, body: '{"ResultObject":true,"Code":"200","Success":true}' };
  }

  decideXhr(url, body) {
    const action = (String(body).match(/Action=([A-Za-z0-9]+)/) || [])[1] || null;
    let host = '';
    try { host = new URL(url).host; } catch { host = 'invalid'; }
    if (DEVICE_HOST_RE.test(host)) return this.routeDevice(action);
    this.blockedHosts.set(host, (this.blockedHosts.get(host) || 0) + 1);
    return { kind: 'error', note: 'blocked host ' + host };
  }

  /** Forward one device XHR to the real network; bodies are never logged. */
  async forwardLive({ method, url, headers, body, action }) {
    const started = Date.now();
    const clean = {};
    for (const [k, v] of Object.entries(headers || {})) {
      const lk = String(k).toLowerCase();
      if (['host', 'connection', 'content-length', 'accept-encoding', 'cookie', 'origin', 'referer'].includes(lk)) continue;
      clean[k] = v;
    }
    let res;
    let text = '';
    try {
      res = await this.fetchImpl(url, { method: method || 'POST', headers: clean, body, signal: AbortSignal.timeout(this.timeoutMs) });
      text = await res.text();
    } catch (e) {
      this.liveRequests.push({ action, at: Date.now(), ok: false, error: String(e?.message || e).slice(0, 160) });
      this.log('live-failed', action, String(e?.message || e).slice(0, 120));
      if (this.auditDir) this.writeAudit({ at: new Date().toISOString(), action, method, url, reqHeaders: clean, reqBody: body, error: String(e?.message || e).slice(0, 300), ms: Date.now() - started });
      throw e;
    }
    let data = null;
    try { data = JSON.parse(text); } catch { /* noop */ }
    const hasDeviceConfig = !!data?.ResultObject?.DeviceConfig;
    this.liveRequests.push({
      action,
      at: Date.now(),
      ok: res.status === 200,
      status: res.status,
      ms: Date.now() - started,
      code: data?.Code ?? null,
      hasDeviceConfig,
      respLen: text.length,
    });
    if (action === 'Log1' || hasDeviceConfig) {
      this.log1 = { code: data?.Code ?? null, message: data?.Message ?? null, hasDeviceConfig, deviceConfigLen: data?.ResultObject?.DeviceConfig?.length ?? 0, at: Date.now() };
      if (hasDeviceConfig) this.deviceConfig = data.ResultObject.DeviceConfig;
    }
    this.log('live-ok', action, `status=${res.status} code=${data?.Code ?? null} respLen=${text.length}`);
    if (this.auditDir) {
      this.writeAudit({
        at: new Date().toISOString(), action, method, url, status: res.status,
        reqHeaders: clean, reqBody: body, respBody: text,
        respHeaders: Object.fromEntries(res.headers?.entries?.() ?? []),
        ms: Date.now() - started,
      });
    }
    return { status: res.status, text, headers: { 'content-type': res.headers?.get?.('content-type') || 'application/json' } };
  }

  writeAudit(entry) {
    try {
      fs.mkdirSync(this.auditDir, { recursive: true });
      this.auditSeq++;
      const name = `live-${String(this.auditSeq).padStart(2, '0')}-${entry.action || 'xhr'}.json`;
      fs.writeFileSync(path.join(this.auditDir, name), JSON.stringify(entry, null, 1));
    } catch (e) {
      this.log('audit-write-failed', String(e?.message || e).slice(0, 120));
    }
  }

  // --- lifecycle ---------------------------------------------------------------

  async start() {
    if (this.window && this.state === 'warm') return this.marks;
    if (this.window) await this.stop(); // cold but leftover DOM: rebuild cleanly
    this.t0 = Date.now();
    this.state = 'starting';
    const jsdom = resolveJsdom();
    const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;
    if (!JSDOM) throw new Error(`jsdom module has no JSDOM export (keys: ${Object.keys(jsdom || {}).slice(0, 8)})`);
    if (typeof requestInterceptor !== 'function') {
      throw new Error('jsdom version too old: requestInterceptor is missing (need jsdom >= 30); upgrade or point JSDOM_PATH at a newer copy');
    }
    const assetIndex = indexAssets(this.assetsDir);

    const html = '<!doctype html><html><head><meta charset="utf-8"><title>jsdom-farm</title></head><body></body></html>';
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => this.log('jsdomError', String(e.message).slice(0, 200)));
    vc.on('error', () => {});
    vc.on('warn', () => {});
    vc.on('log', () => {});
    vc.on('info', () => {});

    const interceptor = requestInterceptor(this.makeInterceptor(assetIndex));

    this.dom = new JSDOM(html, {
      url: this.url,
      runScripts: 'dangerously',
      resources: { interceptors: [interceptor] },
      pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse: (window) => {
        window.AliyunCaptchaConfig = { region: this.region, prefix: this.prefix };
        installShims(window, this.shimUse);

        class FakeXHR {
          constructor() { this.readyState = 0; this.status = 0; this.responseText = ''; this.response = ''; this.responseType = ''; this.timeout = 0; this.withCredentials = false; this._h = {}; this._respHeaders = {}; this.upload = {}; this._listeners = {}; }
          open(m, u) { this.method = m; this.url = u; this.readyState = 1; this._fire('readystatechange'); }
          setRequestHeader(k, v) { this._h[k] = v; }
          getResponseHeader(k) { const v = this._respHeaders[String(k).toLowerCase()]; return v === undefined ? null : v; }
          getAllResponseHeaders() { return Object.entries(this._respHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n'); }
          addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
          removeEventListener(t, fn) { this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== fn); }
          _fire(t) { const e = { type: t, target: this, currentTarget: this }; (this._listeners[t] || []).forEach((f) => f.call(this, e)); const h = this['on' + t]; if (typeof h === 'function') h.call(this, e); }
          send(body) {
            const b = String(body == null ? '' : body);
            const d = this.__farm.decideXhr(this.url, b);
            this.__farm.log('xhr', this.url.slice(0, 80), d.note);
            const deliver = (status, text, headers) => {
              this.readyState = 4;
              this.status = status;
              if (status === 0) { this._fire('readystatechange'); this._fire('error'); this._fire('loadend'); return; }
              this._respHeaders = headers || { 'content-type': 'application/json' };
              this.responseText = text; this.response = text;
              this._fire('readystatechange'); this._fire('load'); this._fire('loadend');
            };
            if (d.kind === 'live') {
              this.__farm
                .forwardLive({ method: this.method, url: this.url, headers: this._h, body: b, action: d.note.replace(/^live /, '') })
                .then((r) => deliver(r.status, r.text, r.headers))
                .catch(() => deliver(0));
              return;
            }
            setTimeout(() => {
              if (d.kind === 'error') return deliver(0);
              deliver(d.status || 200, d.body, { 'content-type': 'application/json' });
            }, 1);
          }
          abort() { this._fire('abort'); }
        }
        window.XMLHttpRequest = FakeXHR;
        Object.defineProperty(window.XMLHttpRequest.prototype, '__farm', { value: this, configurable: true });

        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : input?.url || String(input);
          const d = this.decideXhr(url, String(init?.body || ''));
          if (d.kind === 'live') {
            return this.forwardLive({ method: init?.method || 'GET', url, headers: init?.headers || {}, body: init?.body, action: d.note.replace(/^live /, '') })
              .then((r) => new window.Response(r.text, { status: r.status, headers: r.headers }));
          }
          if (d.kind === 'error') return Promise.reject(new window.TypeError('Failed to fetch (blocked host)'));
          return Promise.resolve(new window.Response(d.body, { status: d.status || 200, headers: { 'content-type': 'application/json' } }));
        };
      },
    });

    this.window = this.dom.window;
    this.launchedProxy = this.proxy ? this.proxy.current() : null;
    this.marks.domCreatedMs = Date.now() - this.t0;

    await new Promise((resolve) => {
      const s = this.window.document.createElement('script');
      s.src = SDK_URL;
      s.onload = () => { this.marks.sdkLoadMs = Date.now() - this.t0; resolve(); };
      s.onerror = () => { this.marks.sdkLoadMs = Date.now() - this.t0; resolve(); };
      this.window.document.head.appendChild(s);
      setTimeout(resolve, this.timeoutMs);
    });

    const deadline = Date.now() + this.timeoutMs;
    let up = false;
    while (Date.now() < deadline) {
      const fn = this.window.eval('typeof (window.z_um && window.z_um.getToken)');
      if (fn === 'function') { up = true; break; }
      await sleep(250);
    }
    if (!up) {
      this.state = 'failed';
      throw new Error('jsdom farm warm-up failed: z_um.getToken never appeared (registration blocked, or assets missing)');
    }
    this.marks.zUmMs = Date.now() - this.t0;

    if (this.mode === 'live') {
      const l1 = this.log1;
      if (!l1 || l1.code !== '200' || !l1.hasDeviceConfig) {
        this.state = 'failed';
        throw new Error(`jsdom farm live: Log1 registration failed (${l1 ? `code=${l1.code} deviceConfig=${l1.hasDeviceConfig}` : 'no Log1 response'})`);
      }
      this.marks.log1Ms = l1.at - this.t0;
    }

    if (this.settleMs > 0) await sleep(this.settleMs);
    const h = await this.health();
    if (!h.ok) {
      this.state = 'failed';
      throw new Error(`jsdom farm health check failed: ${h.reason}`);
    }
    this.state = 'warm';
    this.warmed = true;
    this.marks.readyMs = Date.now() - this.t0;
    this.log(`warm (${this.mode}); z_um ready in ${this.marks.readyMs}ms; token probe ${h.probeLen} chars`);
    return this.marks;
  }

  /** Probe mint. The probe token is discarded (minting is free and local). */
  async health() {
    if (!this.window) return { ok: false, reason: 'not-started' };
    const t0 = Date.now();
    const res = this.window.eval('(function(){ try { const t = window.z_um.getToken(); return { ok: true, type: typeof t, len: String(t).length }; } catch (e) { return { ok: false, error: String(e && (e.message || e)) }; } })()');
    if (!res.ok) return { ok: false, reason: `getToken threw: ${res.error}`, ms: Date.now() - t0 };
    if (res.type !== 'string') return { ok: false, reason: `token type ${res.type}`, ms: Date.now() - t0 };
    // The SDK installs a silent `() => ""` stub when registration failed; a length
    // gate is the only reliable liveness check (typeof is not enough).
    if (res.len < this.minTokenLen) return { ok: false, reason: `token length ${res.len} < ${this.minTokenLen} (SDK stub?)`, ms: Date.now() - t0 };
    return { ok: true, probeLen: res.len, ms: Date.now() - t0 };
  }

  /** Harvest `count` one-time device tokens. Returns [] when the farm is not warm. */
  async harvest(count = 25) {
    if (this.isStale()) {
      this.log('active proxy changed, rebuilding farm');
      await this.restart();
    }
    if (!this.window || this.state !== 'warm') {
      if (!this.window) return [];
      await this.ensureFresh();
    }
    const out = [];
    for (let i = 0; i < count; i++) {
      const res = this.window.eval('(function(){ try { const t = window.z_um.getToken(); return { ok: true, value: String(t) }; } catch (e) { return { ok: false, error: String(e && (e.message || e)) }; } })()');
      if (res.ok && res.value.length >= this.minTokenLen) out.push(res.value);
      await sleep(15 + Math.random() * 25);
    }
    this.log(`harvested ${out.length}/${count} device tokens`);
    return out;
  }

  /** True when the router moved on since this farm was built (same rule as TokenFarm). */
  isStale() {
    return !!(this.window && this.proxy && this.proxy.current() !== this.launchedProxy);
  }

  async ensureFresh() {
    if (!this.window || this.state !== 'warm') {
      this.warmed = false;
      await this.start();
      return;
    }
    const h = await this.health();
    if (!h.ok) {
      this.warmed = false;
      throw new Error(`jsdom farm lost warmth (${h.reason}); restart needed`);
    }
  }

  /** Rebuild the DOM: a fresh device context (and a fresh Log1 in live mode). */
  async restart() {
    this.log('restarting jsdom farm (fresh device context)');
    await this.stop();
    await this.start();
  }

  /** jsdom warm-up is ~2s, so reheating is just a restart. */
  async reheat() {
    return this.restart();
  }

  async stop() {
    if (this.dom) {
      try { this.dom.window.close(); } catch { /* noop */ }
    }
    this.dom = null;
    this.window = null;
    this.warmed = false;
    this.state = 'stopped';
  }

  /** Diagnostics for /healthz-style endpoints (never includes tokens). */
  stats() {
    return {
      engine: 'jsdom',
      mode: this.mode,
      state: this.state,
      warmed: this.warmed,
      feilin: this.feilinBuild ? { build: this.feilinBuild, requested: this.feilinRequested ?? this.feilinBuild, source: this.feilinSource, pinned: (this.pinnedServes || 0) > 0 } : null,
      assetsDir: this.assetsDir,
      minTokenLen: this.minTokenLen,
      liveRequests: this.liveRequests.slice(-5).map((r) => ({ action: r.action, ok: r.ok, status: r.status ?? null, code: r.code ?? null, ms: r.ms ?? null })),
      shims: [...this.shimUse].sort(),
    };
  }
}

// CLI check (needs jsdom installed / JSDOM_PATH + a tenant prefix):
//   JSDOM_PATH=... JSDOM_FARM_ASSETS=... node src/jsdom-farm.mjs --prefix no8xfe --count 3
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const farm = new JsdomFarm({
    url: arg('url') || 'https://chat.z.ai',
    prefix: arg('prefix'),
    region: arg('region') || 'sgp',
    mode: arg('mode') || 'live',
    deviceConfig: arg('device-config'),
    auditDir: arg('audit-dir'),
    verbose: true,
  });
  try {
    const marks = await farm.start();
    console.log('warm:', JSON.stringify(marks));
    const tokens = await farm.harvest(parseInt(arg('count') || '3', 10));
    console.log(JSON.stringify({ harvestedAt: new Date().toISOString(), count: tokens.length, lengths: tokens.map((t) => t.length) }));
  } finally {
    await farm.stop();
  }
}
