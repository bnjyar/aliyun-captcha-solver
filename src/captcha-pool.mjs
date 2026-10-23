// captcha-pool.mjs — device-token pool + paced background param generator.
//
// Keeps fresh captcha_verify_param payloads warm (TTL 75s) and paces Aliyun
// VerifyCaptchaV3 calls (one at a time, min 10s apart; F001 -> 300s pause;
// F011 -> 60s pause) so the device/risk engine never flags us.
//
// The pool is platform-agnostic: it talks to any object exposing
// computeCaptchaParam(deviceToken) -> Promise<string> (see
// createAliyunCaptcha in ./aliyun-captcha.mjs).
//
// Device tokens come from a token farm (see token-farm.mjs): a warm browser
// tab whose window.z_um.getToken() yields one-time tokens.

const PARAM_TTL_MS = 75_000; // param payload usable window (prior-art measured)
const MAX_PARAMS = 2; // warm payloads kept (0 = on-demand: mint only inside get())
const MIN_GEN_INTERVAL_MS = 10_000; // pacing between Verify calls
const F001_PAUSE_MS = 300_000; // risk-control flag cooldown (~5 min)
const F011_PAUSE_MS = 60_000; // frequency/desync cooldown
const FAIL_BACKOFF_MS = 35_000; // generic verify-failure backoff
const IDLE_PAUSE_MS = 180_000; // park generation when no demand
const DEVICE_TOKEN_TTL_MS = 240_000; // device token freshness window
const DEVICE_LOW = 5; // refill in the background when fewer tokens are left
const REFILL_RETRY_MS = 30_000; // a harvest that returned nothing waits this long before the next one
const MAX_CONSUMED = 5000; // remembered one-time tokens; bounded so a long process cannot leak

export class CaptchaPool {
  /**
   * @param {object} opts
   * @param {{ computeCaptchaParam(deviceToken: string): Promise<string> }} opts.captcha
   * @param {string[]} [opts.deviceTokens]  seed tokens
   * @param {object}  [opts.timing]          override pacing constants
   * @param {boolean} [opts.verbose]
   */
  constructor({ captcha, deviceTokens = [], timing = {}, verbose = false } = {}) {
    if (!captcha || typeof captcha.computeCaptchaParam !== 'function') {
      throw new Error('CaptchaPool requires a captcha client with computeCaptchaParam()');
    }
    this.captcha = captcha;
    this.t = { ...{ PARAM_TTL_MS, MAX_PARAMS, MIN_GEN_INTERVAL_MS, F001_PAUSE_MS, F011_PAUSE_MS, FAIL_BACKOFF_MS, IDLE_PAUSE_MS, DEVICE_TOKEN_TTL_MS, DEVICE_LOW, REFILL_RETRY_MS, MAX_CONSUMED }, ...timing };

    this.params = []; // { createdAt, value }
    this.deviceTokens = deviceTokens.map((t) => ({ addedAt: Date.now(), token: t }));
    this.consumed = new Set();
    this.inflight = null; // the single VerifyCaptchaV3 allowed in flight
    this.lastError = null; // { code, message, captchaType, at } of the last failed mint
    this.lastGen = 0;
    this.lastActive = Date.now();
    this.f001Until = 0;
    this.f011Until = 0;
    this.failBackoffUntil = 0;
    this.collector = null; // async () => string[] device tokens (refill)
    this.staleCheck = null; // () => boolean, see setStaleCheck
    this.refilling = null; // the single harvest in flight (background or inline)
    this.refillRetryAt = 0; // no background harvest again before this time
    this.timer = null;
    this.verbose = verbose;
    this.farmNeedsRestart = false;
  }

  log(...a) {
    if (this.verbose) console.log('[captcha-pool]', ...a);
  }

  start() {
    if (this.timer) return;
    this.lastActive = Date.now();
    this.timer = setInterval(() => this.tick(), 500);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setCollector(fn) {
    this.collector = fn;
  }

  // Optional () => boolean: true when the collector's farm is out of date (its
  // proxy moved on). Background refill then runs even with full stock, so the
  // relaunch happens off the request path.
  setStaleCheck(fn) {
    this.staleCheck = fn;
  }

  addDeviceTokens(tokens) {
    const now = Date.now();
    let added = 0;
    for (const t of tokens) {
      if (!t || this.consumed.has(t)) continue;
      if (this.deviceTokens.some((e) => e.token === t)) continue;
      this.deviceTokens.push({ addedAt: now, token: t });
      added++;
    }
    // A fresh batch no longer clears the generic backoff. Background refills run
    // during a backoff, and the backoff exists for Aliyun's verdict, not for the
    // harvest. The inline refill never ran during a backoff anyway (mayMint gates it).
    if (added) this.log(`+${added} device tokens (pool ${this.deviceTokens.length})`);
    // One-time tokens are never re-added; remembering every token forever leaks
    // memory in a process that runs for days. A bounded FIFO is enough.
    while (this.consumed.size > this.t.MAX_CONSUMED) {
      const oldest = this.consumed.values().next().value;
      this.consumed.delete(oldest);
    }
    return added;
  }

  popDeviceToken() {
    const now = Date.now();
    while (this.deviceTokens.length) {
      const entry = this.deviceTokens.pop(); // newest first
      if (now - entry.addedAt < this.t.DEVICE_TOKEN_TTL_MS) {
        this.consumed.add(entry.token);
        return entry.token;
      }
      this.log('dropping stale device token');
    }
    return null;
  }

  // Single-flight: a background harvest and an inline one share the same run.
  refillDeviceTokens() {
    if (!this.collector) return Promise.resolve([]);
    if (!this.refilling) {
      this.refilling = this.collectTokens().finally(() => {
        this.refilling = null;
      });
    }
    return this.refilling;
  }

  async collectTokens() {
    let tokens = [];
    try {
      tokens = await this.collector();
    } catch (e) {
      this.log('collector failed:', e.message);
    }
    // Rate-limited whether or not it worked. A harvest that relaunches the farm is a
    // burst of proxy connections; repeating it at tick speed hammers rate-limited proxies.
    this.refillRetryAt = Date.now() + this.t.REFILL_RETRY_MS;
    if (Array.isArray(tokens) && tokens.length) {
      this.addDeviceTokens(tokens);
      return tokens;
    }
    return [];
  }

  async get(timeoutMs = 6000) {
    this.lastActive = Date.now();
    const deadline = Date.now() + timeoutMs;
    this.start();
    while (Date.now() < deadline) {
      const now = Date.now();
      this.params = this.params.filter((p) => now - p.createdAt < this.t.PARAM_TTL_MS);
      if (this.params.length) {
        const p = this.params.shift();
        this.log('serving warm param');
        return p.value;
      }
      // Join the mint already running (its param lands in this.params), or
      // start one if pacing allows. Never a second Verify beside a live one.
      if (this.inflight) await this.inflight;
      else if (this.mayMint()) await this.startMint();
      if (!this.params.length) await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  shouldGenerate() {
    // Idle parks generation outright. The old `idle && !params.length` let a
    // pool with one live param refill forever (~96 Verifies/hour, no demand).
    if (Date.now() - this.lastActive > this.t.IDLE_PAUSE_MS) return false;
    if (this.params.length >= this.t.MAX_PARAMS) return false;
    return this.mayMint();
  }

  // Pacing gate shared by the background tick and get(): one Verify at a time,
  // at least MIN_GEN_INTERVAL_MS after the previous one started, and never
  // during a risk-control pause.
  mayMint() {
    const now = Date.now();
    if (this.inflight) return false;
    if (now - this.lastGen < this.t.MIN_GEN_INTERVAL_MS) return false;
    if (now < this.failBackoffUntil || now < this.f001Until || now < this.f011Until) return false;
    return true;
  }

  tick() {
    const now = Date.now();
    this.params = this.params.filter((p) => now - p.createdAt < this.t.PARAM_TTL_MS);
    if (this.shouldGenerate()) this.startMint();
    this.maybeRefill(now);
  }

  // Background refill, only while there is demand: a mint should not wait for a
  // harvest (25 page evaluations, plus a warm-up on a cold farm). Harvesting makes
  // no Aliyun call, so pacing and backoff do not apply. Skipped while a farm restart
  // is pending (F001) and after an empty harvest, so the farm is not hammered.
  maybeRefill(now) {
    if (!this.collector || this.refilling || this.farmNeedsRestart) return;
    // Stale tokens do not count: popDeviceToken would drop them and harvest inline.
    const fresh = this.deviceTokens.filter((e) => now - e.addedAt < this.t.DEVICE_TOKEN_TTL_MS).length;
    const stale = this.staleCheck ? this.staleCheck() : false;
    if (fresh >= this.t.DEVICE_LOW && !stale) return;
    if (now - this.lastActive > this.t.IDLE_PAUSE_MS || now < this.refillRetryAt) return;
    this.refillDeviceTokens();
  }

  // The only place a Verify is started. Single-flight: a caller that finds a
  // mint already running waits for it rather than racing a second Verify.
  startMint() {
    this.lastGen = Date.now();
    this.inflight = this.generateOne()
      .then((value) => {
        if (value) this.params.push({ createdAt: Date.now(), value });
      })
      .catch((e) => this.log('mint crashed:', e.message))
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async generateOne() {
    const started = Date.now();
    let token = this.popDeviceToken();
    if (!token) {
      await this.refillDeviceTokens();
      token = this.popDeviceToken();
    }
    if (!token) {
      this.log('no device tokens available');
      return null;
    }
    try {
      const value = await this.captcha.computeCaptchaParam(token);
      this.log(`param generated in ${Date.now() - started}ms`);
      return value;
    } catch (e) {
      const code = e.verifyCode;
      this.lastError = {
        code: code || e.code || 'ERROR',
        message: (e.message || '').slice(0, 200),
        captchaType: e.captchaType || null,
        at: Date.now(),
      };
      if (code === 'F001') {
        this.f001Until = Date.now() + this.t.F001_PAUSE_MS;
        this.log('F001 risk-control — pausing verifies 300s');
        // H8 finding: F001 indicates a flagged/problem device, not mere
        // pacing. Signal the farm owner to re-warm on next use.
        this.farmNeedsRestart = true;
      } else if (code === 'F011') {
        this.f011Until = Date.now() + this.t.F011_PAUSE_MS;
        this.log('F011 frequency — pausing verifies 60s');
      } else if (e.code === 'PROXY_TIMEOUT' || e.proxyFailure) {
        // The router already moved to the next proxy (a silent proxy, a refused
        // CONNECT such as 429). Aliyun never answered, so there is no verdict to back
        // off from: retry on the new proxy at once (pacing still applies).
        this.log(`proxy failed (${e.proxyFailure || e.code}), router moved on; no backoff`);
      } else {
        this.failBackoffUntil = Date.now() + this.t.FAIL_BACKOFF_MS;
        this.log('verify failed:', (e.message || '').slice(0, 120));
      }
      return null;
    }
  }

  stats() {
    const now = Date.now();
    const le = this.lastError;
    return {
      warmParams: this.params.filter((p) => now - p.createdAt < this.t.PARAM_TTL_MS).length,
      deviceTokens: this.deviceTokens.length,
      minting: this.inflight !== null,
      paused: {
        f001: this.f001Until > now ? Math.ceil((this.f001Until - now) / 1000) : 0,
        f011: this.f011Until > now ? Math.ceil((this.f011Until - now) / 1000) : 0,
        backoff: this.failBackoffUntil > now ? Math.ceil((this.failBackoffUntil - now) / 1000) : 0,
      },
      // Kept after recovery on purpose: ageSec says how stale it is.
      lastError: le
        ? { code: le.code, message: le.message, captchaType: le.captchaType, ageSec: Math.round((now - le.at) / 1000) }
        : null,
    };
  }
}
