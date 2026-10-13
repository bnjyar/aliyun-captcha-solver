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

const require = createRequire(import.meta.url);

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve playwright-core from the host app (optional peer dependency). */
function loadChromium() {
  const candidates = [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean);
  const errors = [];
  for (const c of candidates) {
    try {
      return require(c).chromium;
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
   * @param {string}  opts.prefix       Aliyun tenant prefix, e.g. 'no8xfe'
   * @param {string}  [opts.region]     SDK region token, e.g. 'sgp'
   * @param {string}  [opts.profile]    Chrome user-data-dir to persist
   * @param {string}  [opts.executablePath]
   * @param {string}  [opts.waitSelector]  optional: site is "ready" when this selector exists
   * @param {string}  [opts.warmMessage]    optional: fallback warm-up via a real UI message
   * @param {string}  [opts.inputSelector]   defaults to opts.waitSelector
   * @param {boolean} [opts.verbose]
   * @param {boolean} [opts.headless]
   */
  constructor({
    url,
    prefix,
    region = 'sgp',
    profile = null,
    executablePath = '/usr/bin/google-chrome-stable',
    waitSelector = null,
    warmMessage = null,
    inputSelector = null,
    verbose = false,
    headless = true,
  } = {}) {
    if (!url) throw new Error('TokenFarm requires url');
    if (!prefix) throw new Error('TokenFarm requires prefix');
    this.url = url;
    this.prefix = prefix;
    this.region = region;
    this.profile = profile;
    this.executablePath = executablePath;
    this.waitSelector = waitSelector;
    this.warmMessage = warmMessage;
    this.inputSelector = inputSelector || waitSelector;
    this.verbose = verbose;
    this.headless = headless;
    this.context = null;
    this.page = null;
    this.warmed = false;
  }

  log(...a) {
    if (this.verbose) console.log('[token-farm]', ...a);
  }

  async start() {
    if (this.context) return;
    const chromium = loadChromium();
    this.log('launching chrome:', this.profile || '(ephemeral)');
    const launchOpts = {
      headless: this.headless,
      executablePath: this.executablePath,
      viewport: { width: 1280, height: 800 },
      userAgent: UA,
      locale: 'en-US',
      args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-sandbox'],
    };
    this.context = this.profile
      ? await chromium.launchPersistentContext(this.profile, launchOpts)
      : await chromium.launch(launchOpts);
    this.page = this.context.pages()[0] || (await this.context.newPage());
    await this.warm();
  }

  async warm() {
    const page = this.page;
    this.log('opening', this.url);
    await page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (this.waitSelector) {
      try {
        await page.waitForSelector(this.waitSelector, { timeout: 30000 });
      } catch {
        this.log(`warn: selector ${this.waitSelector} not found (continuing; SDK warm-up may still work)`);
      }
    }
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

    // Path 2 (fallback, opt-in): warm via a real UI message — the site's own
    // frontend then loads the SDK and runs its invisible verify cycle.
    if (!(await this.isWarm()) && this.warmMessage && this.inputSelector) {
      this.log('fallback: sending warm-up message via UI');
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
    if (!(await this.isWarm())) {
      throw new Error(
        'token farm warm-up failed: z_um not available (SDK blocked, or the tab needs a login/challenge first)'
      );
    }
    // Let the SDK finish its own invisible verify cycle before harvesting,
    // so we never grab a token that the SDK itself is about to consume.
    await sleep(8000);
    this.warmed = true;
    this.log('warm; z_um ready');
  }

  async isWarm() {
    return this.page.evaluate(
      () => typeof window.z_um !== 'undefined' && typeof window.z_um.getToken === 'function'
    );
  }

  async harvest(count = 25) {
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
        if (t) out.push(t);
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
      this.context = null;
      this.warmed = false;
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
