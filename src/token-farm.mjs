// token-farm.mjs — persistent warm browser tab as a device-token farm.
//
// ONE headless Chrome profile keeps a tab alive on a target site. Once the
// Aliyun captcha SDK is warmed, window.z_um.getToken() yields one-time device
// tokens on demand — dozens per harvest, browser stays warm.
//
// The farm NEVER sends requests via the page; it only warms the SDK. The
// z_um.getToken() tokens are the ONLY thing taken from the browser; everything
// else (Init/Verify/param) happens in Node.
//
// Platform-agnostic: pass the site you need tokens for. The SDK warm-up does
// not depend on the site's own JS — any origin works, so a blank-ish page is
// enough if the site is unreachable.

import { createRequire } from 'node:module';
import path from 'node:path';
import { chromeProxyFailureReason } from './proxy.mjs';
import { resolveChromeExecutable, chromeMajorVersion, platformUserAgent } from './chrome.mjs';

const require = createRequire(import.meta.url);

const SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve a playwright-core candidate to its `chromium` launcher.
 *
 * The candidate may be a bare module name ("playwright-core"), a path to its
 * package.json, or a path to the entry file — the README advertises the
 * package.json form, which require() resolves to *metadata*, not a module, so
 * we follow `main` ourselves instead of handing back an object with no
 * `.chromium` on it.
 */
function chromiumFrom(candidate) {
  const isPath = path.isAbsolute(candidate) || /[\\/]/.test(candidate);
  let mod = require(candidate);
  for (let hop = 0; hop < 3; hop++) {
    if (!mod || typeof mod !== 'object') break;
    if (mod.chromium) return mod.chromium;
    // ESM-transpiled default export, or package.json metadata: one hop down.
    if (mod.default && typeof mod.default === 'object' && !mod.main) {
      mod = mod.default;
      continue;
    }
    if (typeof mod.main === 'string') {
      const dir = isPath ? path.dirname(path.resolve(candidate)) : null;
      if (!dir) break;
      mod = require(path.join(dir, mod.main));
      continue;
    }
    // Modern packages (playwright-core >= 1.30) have no `main`, only an
    // `exports` map. Follow its CJS/ESM entry by hand.
    const entry = mod.exports && typeof mod.exports === 'object' && mod.exports['.'];
    if (entry) {
      const dir = isPath ? path.dirname(path.resolve(candidate)) : null;
      if (!dir) break;
      const rel = typeof entry === 'string' ? entry : entry.require || entry.default || entry.import;
      mod = require(path.join(dir, rel));
      continue;
    }
    break;
  }
  throw new Error(`resolved but no .chromium export (keys: ${Object.keys(mod || {}).slice(0, 8)})`);
}

/** Resolve playwright-core from the host app (optional peer dependency). */
function loadChromium() {
  const candidates = [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean);
  const errors = [];
  for (const c of candidates) {
    try {
      return chromiumFrom(c);
    } catch (e) {
      errors.push(`${c}: ${e.message}`);
    }
  }
  throw new Error(
    'playwright-core not found. Install it in your app, or set PLAYWRIGHT_CORE_PATH to its package.json. Tried:\n  ' +
      errors.join('\n  ')
  );
}

export class TokenFarm {
  /**
   * @param {object} opts
   * @param {string}  opts.url          page to keep warm (needs a real origin for the SDK)
   * @param {string}  opts.prefix       Aliyun tenant prefix, e.g. 'abc123'
   * @param {string}  [opts.region]     SDK region token, e.g. 'sgp'
   * @param {string}  [opts.profile]    Chrome user-data-dir to persist
   * @param {string}  [opts.executablePath] Chrome/Chromium binary. Defaults to CHROME_PATH,
   *                                     then the platform's well-known locations (Linux, macOS,
   *                                     Windows); null lets Playwright resolve it.
   * @param {string}  [opts.userAgent]   override; by default derived from the browser version
   *                                     and the host platform so the UA matches the fingerprint
   * @param {number}  [opts.minTokenLen] reject tokens shorter than this (default 500): the SDK
   *                                     can install a silent stub when registration failed
   * @param {string}  [opts.waitSelector]  optional: site is "ready" when this selector exists
   * @param {string}  [opts.warmMessage]    optional: fallback warm-up via a real UI message
   * @param {string}  [opts.inputSelector]   defaults to opts.waitSelector
   * @param {boolean} [opts.verbose]
   * @param {boolean} [opts.headless]
   * @param {object}  [opts.proxy]     ProxyRouter from ./proxy.mjs. Chrome leaves through the active
   *                                   proxy, relaunches when the router moves on, and reports
   *                                   Chrome-side proxy errors back to the router.
   */
  constructor({
    url,
    prefix,
    region = 'sgp',
    profile = null,
    executablePath = null,
    userAgent = null,
    minTokenLen = 500,
    waitSelector = null,
    warmMessage = null,
    inputSelector = null,
    verbose = false,
    headless = true,
    proxy = null,
  } = {}) {
    if (!url) throw new Error('TokenFarm requires url');
    if (!prefix) throw new Error('TokenFarm requires prefix');
    this.url = url;
    this.prefix = prefix;
    this.region = region;
    this.profile = profile;
    this.executablePath = executablePath;
    this.userAgent = userAgent;
    this.minTokenLen = minTokenLen;
    this.waitSelector = waitSelector;
    this.warmMessage = warmMessage;
    this.inputSelector = inputSelector || waitSelector;
    this.verbose = verbose;
    this.headless = headless;
    this.proxy = proxy;
    this.launchedProxy = null; // router entry the running Chrome was launched with
    this.browser = null; // ephemeral mode only: the Browser we created the context from
    this.context = null;
    this.page = null;
    this.warmed = false;
  }

  log(...a) {
    if (this.verbose) console.log('[token-farm]', ...a);
  }

  async start() {
    if (this.context) return;
    // A proxy-level failure (dead proxy, refused CONNECT) moves the router on. Then
    // launch again on the next proxy, at most once per proxy in the list. Any other
    // failure is thrown as before.
    const attempts = this.proxy ? this.proxy.status().total : 1;
    for (let attempt = 1; ; attempt++) {
      const switchesBefore = this.proxy ? this.proxy.status().switches : 0;
      try {
        return await this.launch();
      } catch (e) {
        const moved = this.proxy && this.proxy.status().switches > switchesBefore;
        if (!moved || attempt >= attempts) throw e;
        this.log(`launch failed on proxy #${this.launchedProxy.index}, retrying on the next proxy`);
        await this.stop();
      }
    }
  }

  async launch() {
    const chromium = loadChromium();
    const executablePath = resolveChromeExecutable(this.executablePath);
    const major = chromeMajorVersion(executablePath);
    const userAgent = this.userAgent || platformUserAgent(major);
    this.log(
      'launching chrome:',
      this.profile || '(ephemeral)',
      executablePath || '(playwright default)',
      `ua Chrome/${major || '?'}`
    );
    const launchOpts = {
      headless: this.headless,
      args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-sandbox'],
    };
    if (executablePath) launchOpts.executablePath = executablePath;
    if (this.proxy) {
      // Chrome cannot switch proxies on a live context, so the choice is made here.
      this.launchedProxy = this.proxy.current();
      launchOpts.proxy = this.launchedProxy.playwrightProxy;
      this.log(`chrome egress via proxy #${this.launchedProxy.index}`);
    }

    // viewport/userAgent/locale are CONTEXT options: launchPersistentContext takes
    // them directly, while chromium.launch() rejects them and returns a Browser
    // (not a context). Normalize both modes to "one context".
    const contextOpts = { viewport: { width: 1280, height: 800 }, userAgent, locale: 'en-US' };
    try {
      if (this.profile) {
        this.context = await chromium.launchPersistentContext(this.profile, { ...launchOpts, ...contextOpts });
        this.browser = null;
      } else {
        this.browser = await chromium.launch(launchOpts);
        this.context = await this.browser.newContext(contextOpts);
      }
    } catch (e) {
      if (!executablePath) {
        throw Object.assign(new Error(`Chrome not found (set CHROME_PATH or opts.executablePath). ${e.message}`), {
          cause: e,
        });
      }
      throw e;
    }
    this.launchedUserAgent = userAgent;
    this.page = this.context.pages()[0] || (await this.context.newPage());
    await this.warm();
  }

  // ERR_PROXY_* and ERR_TUNNEL_* mean the proxy itself failed (unreachable, or
  // CONNECT refused). Report it, so the router moves on and the next harvest relaunches.
  reportProxyError(e) {
    if (!this.proxy || !this.launchedProxy) return;
    const reason = chromeProxyFailureReason(e?.message);
    if (reason) this.proxy.fail(this.launchedProxy, reason);
  }

  async warm() {
    const page = this.page;
    // Stage marks for the cold-start breakdown (verbose only): ms since warm() began.
    const t0 = Date.now();
    const mark = (stage) => this.log(`warm ${stage} +${Date.now() - t0}ms`);
    this.log('opening', this.url);
    try {
      await page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      this.reportProxyError(e);
      throw e;
    }
    mark('dom-ready');
    if (this.waitSelector) {
      try {
        await page.waitForSelector(this.waitSelector, { timeout: 30000 });
      } catch {
        this.log(`warn: selector ${this.waitSelector} not found (continuing; SDK warm-up may still work)`);
      }
    }
    mark('selector');
    await sleep(1500);

    // Path 1 (simplest): plain-load the Aliyun captcha SDK — NO
    // initAliyunCaptcha popup, NO hidden element, NO UI message needed.
    // AliyunCaptchaConfig + <script src=AliyunCaptcha.js> → window.z_um
    // becomes available in 1-2.6s on any origin.
    if (!(await this.isWarm())) {
      this.log('plain-loading AliyunCaptcha.js (no init, no UI message)');
      await page.evaluate(
        ({ prefix, region, sdkUrl }) => {
          window.AliyunCaptchaConfig = { region, prefix };
          return new Promise((resolve) => {
            const existing = document.querySelector('script[src*="AliyunCaptcha.js"]');
            if (existing) return resolve();
            const s = document.createElement('script');
            s.src = sdkUrl;
            s.onload = () => resolve();
            s.onerror = () => resolve();
            document.head.appendChild(s);
            setTimeout(resolve, 10000);
          });
        },
        { prefix: this.prefix, region: this.region, sdkUrl: SDK_URL }
      );
      for (let i = 0; i < 15; i++) {
        if (await this.isWarm()) break;
        await sleep(500);
      }
    }

    mark('plain-load');
    // Path 2 (fallback, opt-in): warm via a real UI message — the site's own
    // frontend then loads the SDK and runs its invisible verify cycle.
    if (!(await this.isWarm()) && this.warmMessage && this.inputSelector) {
      this.log('fallback: sending warm-up message via UI');
      mark('fallback-sent');
      try {
        await page.fill(this.inputSelector, this.warmMessage);
        await page.keyboard.press('Enter');
      } catch (e) {
        throw new Error(`warm-up send failed: ${e.message}`);
      }
    }

    for (let i = 0; i < 30; i++) {
      if (await this.isWarm()) break;
      await sleep(1000);
    }
    mark('z_um');
    if (!(await this.isWarm())) {
      throw new Error(
        'token farm warm-up failed: z_um not available (SDK blocked, or the tab needs a login/challenge first)'
      );
    }
    // Let the SDK finish its own invisible verify cycle before harvesting,
    // so we never grab a token that the SDK itself is about to consume.
    await sleep(8000);
    // A failed registration can leave a stub that returns short/empty strings
    // without throwing. Surface it here instead of harvesting zero tokens later.
    const probe = await this.page.evaluate(() => {
      try {
        const t = window.z_um.getToken();
        return typeof t === 'string' ? t : '';
      } catch {
        return '';
      }
    });
    if (probe.length < this.minTokenLen) {
      this.log(
        `warn: probe token ${probe.length} chars < minTokenLen ${this.minTokenLen} (registration may have failed)`
      );
    }
    this.warmed = true;
    mark('ready');
    this.log('warm; z_um ready');
  }

  async isWarm() {
    return this.page.evaluate(
      () => typeof window.z_um !== 'undefined' && typeof window.z_um.getToken === 'function'
    );
  }

  // True when the router moved on since Chrome was launched. A harvest relaunches the
  // farm (about 70 s cold). A caller can run that relaunch in the background instead.
  isStale() {
    return !!(this.context && this.proxy && this.proxy.current() !== this.launchedProxy);
  }

  async harvest(count = 25) {
    // The router moved on (a failed Verify or Chrome load). Relaunch so the tab
    // leaves from the same IP as the rest of the solver.
    if (this.isStale()) {
      this.log('active proxy changed, relaunching farm');
      await this.restart();
    }
    if (!this.warmed && !(await this.isWarm())) {
      await this.warm();
    }
    if (!(await this.isWarm())) return [];
    const out = [];
    for (let i = 0; i < count; i++) {
      try {
        const t = await this.page.evaluate(() => {
          try {
            const t = window.z_um.getToken();
            return typeof t === 'string' ? t : null;
          } catch {
            return null;
          }
        });
        // Same health gate as JsdomFarm: a stub or a truncated token is not a token.
        if (t && t.length >= this.minTokenLen) out.push(t);
        else if (t) this.log(`dropped short token (${t.length} chars)`);
      } catch {
        break; // page dead / navigated
      }
      await sleep(15 + Math.random() * 25);
    }
    this.log(`harvested ${out.length}/${count} device tokens`);
    return out;
  }

  async ensureFresh() {
    // Re-warm if the tab crashed or navigated away.
    if (!this.page || this.page.isClosed()) {
      this.warmed = false;
      await this.stop();
      await this.start();
      return;
    }
    try {
      if (!(await this.isWarm())) await this.warm();
    } catch {
      this.warmed = false;
      throw new Error('token farm lost warmth; restart needed');
    }
  }

  async restart() {
    // An F001 flag points at the device context — rebuild the tab.
    this.log('restarting farm tab (fresh device context)');
    await this.stop();
    await this.start();
  }

  async reheat() {
    // z_um cannot be re-booted in a live document (the FeiLin module registry
    // doesn't re-init), but page.reload() + plain-load warm costs only ~3s and
    // fully recovers. Use when the tab is alive but z_um went away.
    if (!this.page || this.page.isClosed()) {
      return this.restart();
    }
    this.log('reheating: page.reload() + plain warm (~3s)');
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    this.warmed = false;
    await this.warm();
  }

  async stop() {
    if (this.context) {
      try {
        await this.context.close();
      } catch {}
      this.context = null;
      this.page = null;
      this.warmed = false;
      this.log('stopped');
    }
    // Ephemeral mode: the context came from this browser; close it too so the
    // process does not linger after stop()/restart().
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
    }
  }
}

// CLI usage: PLAYWRIGHT_CORE_PATH=... node src/token-farm.mjs --url https://site.tld --prefix abc123 [--count 25]
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const farm = new TokenFarm({
    url: arg('url'),
    prefix: arg('prefix'),
    region: arg('region') || 'sgp',
    profile: arg('profile') || undefined,
    waitSelector: arg('wait-selector') || undefined,
    warmMessage: arg('warm-message') || undefined,
    verbose: true,
  });
  try {
    await farm.start();
    const tokens = await farm.harvest(parseInt(arg('count') || '25', 10));
    console.log(JSON.stringify({ harvestedAt: new Date().toISOString(), count: tokens.length, tokens }, null, 2));
  } finally {
    await farm.stop();
  }
}
