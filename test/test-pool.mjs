// test-pool.mjs — unit tests for CaptchaPool pacing/backoff logic.
// Run: node test/test-pool.mjs   (no network — fake captcha client)

import assert from 'node:assert';
import { CaptchaPool } from '../src/captcha-pool.mjs';

let passed = 0;
const t = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
};

const fake = (opts = {}) => ({
  calls: 0,
  async computeCaptchaParam() {
    this.calls++;
    if (opts.failWith) throw opts.failWith;
    return 'PARAM' + this.calls;
  },
});

const noWait = { MIN_GEN_INTERVAL_MS: 0, PARAM_TTL_MS: 75_000 };

console.log('pool:');

await t('requires a captcha client', () => {
  assert.throws(() => new CaptchaPool(), /computeCaptchaParam/);
});

await t('serves a warm param from get()', async () => {
  const c = fake();
  const p = new CaptchaPool({ captcha: c, deviceTokens: ['tok1'], timing: noWait });
  const v = await p.get(1000);
  assert.equal(v, 'PARAM1');
  assert.equal(c.calls, 1);
  p.stop();
});

await t('returns null when no device tokens are available', async () => {
  const p = new CaptchaPool({ captcha: fake(), deviceTokens: [], timing: noWait });
  const v = await p.get(150);
  assert.equal(v, null);
  p.stop();
});

await t('device token is consumed once', async () => {
  const c = fake();
  const p = new CaptchaPool({ captcha: c, deviceTokens: ['a', 'b'], timing: noWait });
  await p.get(1000);
  await p.get(1000);
  assert.equal(c.calls, 2);
  assert.equal(p.consumed.size, 2);
  p.stop();
});

await t('collector refills the token pool', async () => {
  const c = fake();
  const p = new CaptchaPool({ captcha: c, deviceTokens: [], timing: noWait });
  p.setCollector(async () => ['fresh1']);
  const v = await p.get(2000);
  assert.equal(v, 'PARAM1');
  p.stop();
});

await t('F001 pauses verifies for 300s', async () => {
  const err = new Error('rejected');
  err.verifyCode = 'F001';
  const p = new CaptchaPool({ captcha: fake({ failWith: err }), deviceTokens: ['t'], timing: noWait });
  await p.get(200);
  assert.equal(p.stats().paused.f001, 300);
  assert.equal(p.farmNeedsRestart, true);
  p.stop();
});

await t('F011 pauses verifies for 60s', async () => {
  const err = new Error('rejected');
  err.verifyCode = 'F011';
  const p = new CaptchaPool({ captcha: fake({ failWith: err }), deviceTokens: ['t'], timing: noWait });
  await p.get(200);
  assert.equal(p.stats().paused.f011, 60);
  p.stop();
});

await t('generic failure uses the short backoff', async () => {
  const p = new CaptchaPool({ captcha: fake({ failWith: new Error('boom') }), deviceTokens: ['t'], timing: noWait });
  await p.get(200);
  assert.equal(p.stats().paused.backoff, 35);
  p.stop();
});

await t('stale device tokens are dropped', async () => {
  const p = new CaptchaPool({
    captcha: fake(),
    timing: { ...noWait, DEVICE_TOKEN_TTL_MS: 0 },
  });
  p.addDeviceTokens(['old']);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await p.get(150), null);
  p.stop();
});

await t('expired warm params are evicted', async () => {
  const c = fake();
  const p = new CaptchaPool({ captcha: c, deviceTokens: ['t'], timing: { ...noWait, PARAM_TTL_MS: 0 } });
  p.params.push({ createdAt: Date.now() - 1000, value: 'STALE' });
  assert.equal(p.stats().warmParams, 0);
  p.stop();
});

await t('never runs two verifies at once', async () => {
  // Regression: get() and the background tick each started a Verify, so a
  // slow mint could overlap a second one — the burst pattern F011 punishes.
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const captcha = {
    async computeCaptchaParam() {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      inFlight--;
      return 'P' + ++calls;
    },
  };
  const p = new CaptchaPool({ captcha, deviceTokens: ['a', 'b', 'c'], timing: noWait });
  const vals = await Promise.all([p.get(2000), p.get(2000), p.get(2000)]);
  assert.deepEqual(vals, ['P1', 'P2', 'P3']);
  assert.equal(maxInFlight, 1);
  p.stop();
});

await t('last failed mint keeps its Aliyun code and CaptchaType', async () => {
  const err = new Error('VerifyCaptchaV3 rejected (code=F011): {"Success":true}');
  err.verifyCode = 'F011';
  err.captchaType = 'TRACELESS';
  const p = new CaptchaPool({ captcha: fake({ failWith: err }), deviceTokens: ['t'], timing: noWait });
  assert.equal(p.stats().lastError, null);
  await p.get(200);
  const le = p.stats().lastError;
  assert.equal(le.code, 'F011');
  assert.equal(le.captchaType, 'TRACELESS');
  assert.match(le.message, /code=F011/);
  assert.ok(le.ageSec >= 0);
  p.stop();
});

await t('idle pool parks even while a warm param is still alive', () => {
  // Regression: `idle && !params.length` let an idle pool keep refilling as its
  // last live param expired (~96 Verifies/hour with zero requests).
  const c = fake();
  const p = new CaptchaPool({ captcha: c, deviceTokens: ['a', 'b'], timing: { ...noWait, PARAM_TTL_MS: 10_000, IDLE_PAUSE_MS: 50 } });
  p.params.push({ createdAt: Date.now(), value: 'LIVE' });
  p.lastActive = Date.now() - 1000;
  assert.equal(p.shouldGenerate(), false);
  p.tick();
  assert.equal(c.calls, 0);
  p.stop();
});

await t('active pool still refills toward MAX_PARAMS', () => {
  const p = new CaptchaPool({ captcha: fake(), deviceTokens: ['a'], timing: { ...noWait, MAX_PARAMS: 2, IDLE_PAUSE_MS: 60_000 } });
  assert.equal(p.shouldGenerate(), true);
  p.params.push({ createdAt: Date.now(), value: 'LIVE' });
  assert.equal(p.shouldGenerate(), true);
  p.params.push({ createdAt: Date.now(), value: 'LIVE2' });
  assert.equal(p.shouldGenerate(), false);
  p.stop();
});

await t('on-demand (MAX_PARAMS 0) mints only when get() asks', async () => {
  const c = fake();
  const p = new CaptchaPool({ captcha: c, deviceTokens: ['a', 'b'], timing: { ...noWait, MAX_PARAMS: 0 } });
  p.start(); // the tick runs, but must not mint
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(c.calls, 0);
  assert.equal(await p.get(1000), 'PARAM1');
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(c.calls, 1); // nothing minted behind the request
  p.stop();
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

await t('low stock is refilled in the background while there is demand', async () => {
  let harvests = 0;
  const p = new CaptchaPool({ captcha: fake(), deviceTokens: ['a'], timing: { ...noWait, MAX_PARAMS: 0 } });
  p.setCollector(async () => {
    harvests++;
    return ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
  });
  p.start(); // no get(): only the tick runs
  await pause(700);
  assert.equal(harvests, 1);
  assert.equal(p.stats().deviceTokens, 7);
  p.stop();
});

await t('a stale farm refills in the background even with full stock', async () => {
  let harvests = 0;
  const p = new CaptchaPool({ captcha: fake(), deviceTokens: Array.from({ length: 25 }, (_, i) => 'f' + i), timing: { ...noWait, MAX_PARAMS: 0 } });
  let stale = false;
  p.setStaleCheck(() => stale);
  p.setCollector(async () => {
    harvests++;
    stale = false; // the relaunch brings the farm onto the active proxy
    return ['r1'];
  });
  p.start();
  await pause(700);
  assert.equal(harvests, 0, 'full and fresh stock, farm current: no harvest');
  stale = true;
  await pause(700);
  assert.equal(harvests, 1, 'farm stale: one background harvest (relaunch)');
  p.stop();
});

await t('stale stock does not count as stock for the background refill', async () => {
  let harvests = 0;
  const p = new CaptchaPool({ captcha: fake(), timing: { ...noWait, MAX_PARAMS: 0, DEVICE_TOKEN_TTL_MS: 1000 } });
  p.deviceTokens = Array.from({ length: 6 }, (_, i) => ({ addedAt: Date.now() - 5000, token: 'old' + i }));
  p.setCollector(async () => {
    harvests++;
    return ['n1'];
  });
  p.start();
  await pause(700);
  assert.equal(harvests, 1);
  p.stop();
});

await t('no background harvest when the pool is idle', async () => {
  let harvests = 0;
  const p = new CaptchaPool({ captcha: fake(), deviceTokens: [], timing: { ...noWait, MAX_PARAMS: 0, IDLE_PAUSE_MS: 50 } });
  p.setCollector(async () => {
    harvests++;
    return ['x'];
  });
  p.start();
  p.lastActive = Date.now() - 1000;
  await pause(700);
  assert.equal(harvests, 0);
  p.stop();
});

await t('background and inline harvests share one run', async () => {
  let harvests = 0;
  const p = new CaptchaPool({ captcha: fake(), deviceTokens: [], timing: { ...noWait, MAX_PARAMS: 0 } });
  p.setCollector(async () => {
    harvests++;
    await pause(1200); // long enough that the tick runs while the inline one is in flight
    return ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'];
  });
  p.start();
  assert.equal(await p.get(3000), 'PARAM1');
  assert.equal(harvests, 1);
  p.stop();
});

await t('an empty harvest waits REFILL_RETRY_MS before the next background try', async () => {
  let harvests = 0;
  const p = new CaptchaPool({ captcha: fake(), deviceTokens: [], timing: { ...noWait, MAX_PARAMS: 0 } });
  p.setCollector(async () => {
    harvests++;
    return [];
  });
  p.start();
  await pause(1200);
  assert.equal(harvests, 1);
  assert.ok(p.refillRetryAt > Date.now());
  p.stop();
});

await t('a silent proxy costs no Aliyun backoff: the router already moved on', async () => {
  const err = Object.assign(new Error('proxy #1 did not answer before the caller\'s timeout'), { code: 'PROXY_TIMEOUT' });
  const c = fake({ failWith: err });
  const p = new CaptchaPool({ captcha: c, deviceTokens: ['a', 'b'], timing: noWait });
  assert.equal(await p.get(300), null);
  assert.ok(c.calls >= 2, `retried on the new proxy at once (calls ${c.calls})`);
  assert.equal(p.stats().paused.backoff, 0);
  assert.equal(p.stats().lastError.code, 'PROXY_TIMEOUT');
  p.stop();
});

console.log(`\n${passed} passed`);
