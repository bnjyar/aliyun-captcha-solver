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

console.log(`\n${passed} passed`);
