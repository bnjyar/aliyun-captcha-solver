// test-jsdom-farm.mjs — offline tests for the Chrome-less JsdomFarm.
// No jsdom needed for the pure logic; the full warm-up test runs only when jsdom
// resolves (JSDOM_PATH / local install) AND a DeviceConfig fixture is provided
// (JSDOM_FARM_TEST_DEVICE_CONFIG=<file with the blob>) AND assets exist
// (JSDOM_FARM_ASSETS=<dir with AliyunCaptcha.js + feilin*.js>).
// Run: node test/test-jsdom-farm.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsdomFarm, indexAssets, pickLocalAsset, newestFeilinBuild, resolveJsdom, installShims } from '../src/jsdom-farm.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsdom-farm-test-'));

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

console.log('jsdom device-token farm (no Chrome)');

// --- asset index / picks -------------------------------------------------------

await t('asset index picks the exact basename, and a feilin build by number only', () => {
  const dir = path.join(tmp, 'assets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AliyunCaptcha.js'), '// sdk');
  fs.writeFileSync(path.join(dir, 'feilin048-full.js'), '// feilin 048');
  const index = indexAssets(dir);
  assert.deepEqual(pickLocalAsset(index, 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'), { file: path.join(dir, 'AliyunCaptcha.js'), pinned: false });
  assert.deepEqual(pickLocalAsset(index, 'https://g.alicdn.com/captcha-frontend/FeiLin/1.5.2/feilin048.abc123.js'), { file: path.join(dir, 'feilin048-full.js'), pinned: false }, 'same build number: local file is reused');
  assert.equal(pickLocalAsset(index, 'https://g.alicdn.com/captcha-frontend/FeiLin/1.5.2/feilin045.abc123.js'), null, 'different build: must be fetched, not faked');
  assert.equal(pickLocalAsset(index, 'https://g.alicdn.com/captcha-frontend/dynamicJS/3.29.0/pe.080.x.js'), null);
});

await t('pinFeilin: build apa pun dilayani dari build lokal yang dipin (imun rotasi server)', () => {
  const dir = path.join(tmp, 'pinned-assets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AliyunCaptcha.js'), '// sdk');
  fs.writeFileSync(path.join(dir, 'feilin045-full.js'), '// feilin 045');
  fs.writeFileSync(path.join(dir, 'feilin048-full.js'), '// feilin 048');
  const index = indexAssets(dir);
  const asked049 = 'https://g.alicdn.com/captcha-frontend/FeiLin/1.5.2/feilin049.deadbeef.js';
  assert.deepEqual(pickLocalAsset(index, asked049, '045'), { file: path.join(dir, 'feilin045-full.js'), pinned: true }, 'server minta 049, yang dilayani 045');
  assert.deepEqual(pickLocalAsset(index, asked049, 'auto'), { file: path.join(dir, 'feilin048-full.js'), pinned: true }, 'auto = build tertinggi yang ada');
  assert.equal(pickLocalAsset(index, 'https://g.alicdn.com/captcha-frontend/FeiLin/1.5.2/feilin045.x.js', '045').pinned, false, 'build yang sama bukan substitusi');
  assert.equal(pickLocalAsset(index, asked049, '051'), null, 'pin tidak ada di disk: caller yang memutuskan');
  assert.equal(newestFeilinBuild(index), '048');
  const farm = new JsdomFarm({ prefix: 'no8xfe', mode: 'live', assetsDir: dir, pinFeilin: 'auto' });
  assert.equal(farm.effectivePin(index), '048');
  farm.pinFeilin = null;
  assert.equal(farm.effectivePin(index), null);
  farm.pinFeilin = '045';
  assert.equal(farm.effectivePin(index), '045');
});

await t('a missing asset directory is an empty index, not an error', () => {
  const index = indexAssets(path.join(tmp, 'nope'));
  assert.equal(index.all.size, 0);
  assert.equal(pickLocalAsset(index, 'https://o.alicdn.com/x/AliyunCaptcha.js'), null);
});

// --- jsdom resolution ----------------------------------------------------------

await t('resolveJsdom() points at the real error when jsdom is absent', () => {
  const saved = process.env.JSDOM_PATH;
  delete process.env.JSDOM_PATH;
  try {
    resolveJsdom();
    console.log('    (jsdom is installed here; resolution succeeded)');
  } catch (e) {
    assert.match(e.message, /jsdom not found/, `unexpected message: ${e.message}`);
    assert.match(e.message, /JSDOM_PATH/, 'the error must say how to fix it');
  } finally {
    if (saved !== undefined) process.env.JSDOM_PATH = saved;
  }
});

// --- device XHR routing --------------------------------------------------------

await t('live mode forwards device actions, replay mode answers them from the blob', () => {
  const live = new JsdomFarm({ prefix: 'no8xfe', mode: 'live' });
  assert.equal(live.decideXhr('https://cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com', 'Action=Log1&x=1').kind, 'live');
  assert.equal(live.decideXhr('https://cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com', 'Action=Log2&x=1').kind, 'live');
  assert.equal(live.decideXhr('https://device.saf.aliyuncs.com', 'Action=Log3').kind, 'live');
  const blocked = live.decideXhr('https://chat.z.ai/api', '');
  assert.equal(blocked.kind, 'error');
  assert.equal(live.blockedHosts.get('chat.z.ai'), 1, 'blocked hosts are counted');

  const replay = new JsdomFarm({ prefix: 'no8xfe', mode: 'replay', deviceConfig: 'AAA#BBB' });
  const r1 = replay.decideXhr('https://cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com', 'Action=Log1');
  assert.equal(r1.kind, 'ok');
  assert.equal(JSON.parse(r1.body).ResultObject.DeviceConfig, 'AAA#BBB');
  const r2 = replay.decideXhr('https://cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com', 'Action=Log3');
  assert.equal(r2.kind, 'ok');
  assert.equal(JSON.parse(r2.body).Code, '200');
});

await t('replay mode without a DeviceConfig fails fast at construction', () => {
  assert.throws(() => new JsdomFarm({ prefix: 'no8xfe', mode: 'replay' }), /needs deviceConfig/);
  assert.throws(() => new JsdomFarm({ prefix: 'no8xfe', mode: 'banana' }), /unknown mode/);
});

// --- live forwarding + audit ---------------------------------------------------

await t('forwardLive() registers, keeps the blob, strips hop headers, and audits raw pairs', async () => {
  const auditDir = path.join(tmp, 'audit');
  const seen = [];
  const farm = new JsdomFarm({
    prefix: 'no8xfe',
    mode: 'live',
    auditDir,
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ ResultObject: { DeviceConfig: 'FRESH-BLOB' }, Message: 'success', Code: '200' }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const r = await farm.forwardLive({ method: 'POST', url: 'https://cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'a=b', Host: 'evil', Connection: 'keep-alive' }, body: 'Action=Log1&Data=x', action: 'Log1' });
  assert.equal(r.status, 200);
  assert.equal(farm.log1.code, '200');
  assert.equal(farm.log1.hasDeviceConfig, true);
  assert.equal(farm.deviceConfig, 'FRESH-BLOB');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.headers.Cookie, undefined, 'cookies must not be replayed from Node');
  assert.equal(seen[0].init.headers.Host, undefined);
  assert.equal(seen[0].init.headers.Connection, undefined);
  assert.equal(seen[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded', 'SDK headers survive');
  const files = fs.readdirSync(auditDir);
  assert.equal(files.length, 1);
  const audit = JSON.parse(fs.readFileSync(path.join(auditDir, files[0]), 'utf8'));
  assert.equal(audit.reqBody, 'Action=Log1&Data=x');
  assert.match(audit.respBody, /FRESH-BLOB/);
});

await t('a failed live call is recorded, never cached as success', async () => {
  const farm = new JsdomFarm({ prefix: 'no8xfe', mode: 'live', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(() => farm.forwardLive({ method: 'POST', url: 'https://cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com', headers: {}, body: 'Action=Log1', action: 'Log1' }), /ECONNRESET/);
  assert.equal(farm.log1, null);
  assert.equal(farm.liveRequests.length, 1);
  assert.equal(farm.liveRequests[0].ok, false);
});

// --- health gate ---------------------------------------------------------------

await t('health() rejects the SDK stub () => "" by length, not by typeof', async () => {
  const farm = new JsdomFarm({ prefix: 'no8xfe', mode: 'live' });
  farm.window = { eval: () => ({ ok: true, type: 'string', len: 0 }) };
  const bad = await farm.health();
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /token length 0/);
  farm.window = { eval: () => ({ ok: true, type: 'string', len: 1192 }) };
  const good = await farm.health();
  assert.equal(good.ok, true);
  assert.equal(good.probeLen, 1192);
  farm.window = { eval: () => ({ ok: false, error: 'Worker is not defined' }) };
  const thrown = await farm.health();
  assert.equal(thrown.ok, false);
  assert.match(thrown.reason, /Worker is not defined/);
  farm.window = null;
  assert.equal((await farm.health()).ok, false);
});

await t('the Worker marker shim is installed (feilin 048 reads it synchronously)', () => {
  const calls = [];
  const fakeWindow = {
    HTMLCanvasElement: { prototype: { getContext() { return null; } } },
    screen: {}, navigator: { plugins: { length: 0 } }, crypto: {},
    eval: () => {},
  };
  const shimUse = new Set();
  installShims(fakeWindow, shimUse);
  assert.equal(typeof fakeWindow.Worker, 'function');
  assert.equal(!fakeWindow.Worker, false, 'browser-like truthiness for !Worker');
  assert.throws(() => new fakeWindow.Worker(), /not implemented/, 'construction fails loudly');
  calls.push([...shimUse].includes('Worker(read-only marker)'));
  assert.equal(calls[0], true);
});

// --- staleness (same contract as TokenFarm) ------------------------------------

await t('isStale() follows the proxy router', () => {
  const e1 = { index: 1 };
  const e2 = { index: 2 };
  const fakeRouter = { current: () => e1 };
  const farm = new JsdomFarm({ prefix: 'no8xfe', mode: 'live', proxy: fakeRouter });
  assert.equal(farm.isStale(), false, 'never launched: not stale');
  farm.window = {};
  farm.launchedProxy = e1;
  assert.equal(farm.isStale(), false, 'launched on the active proxy: not stale');
  fakeRouter.current = () => e2;
  assert.equal(farm.isStale(), true, 'router moved on: stale');
  farm.proxy = null;
  assert.equal(farm.isStale(), false, 'no proxy: never stale');
});

await t('harvest() on a stopped farm returns [] instead of throwing', async () => {
  const farm = new JsdomFarm({ prefix: 'no8xfe', mode: 'live' });
  assert.deepEqual(await farm.harvest(3), []);
});

await t('stats() reports engine/mode/state without tokens', async () => {
  const farm = new JsdomFarm({ prefix: 'no8xfe', mode: 'live' });
  farm.liveRequests.push({ action: 'Log1', ok: true, status: 200, code: '200', ms: 120 });
  farm.feilinBuild = '048';
  farm.feilinRequested = '048';
  farm.feilinSource = 'cdn';
  const s = farm.stats();
  assert.equal(s.engine, 'jsdom');
  assert.equal(s.mode, 'live');
  assert.equal(s.state, 'idle');
  assert.equal(s.liveRequests.length, 1);
  assert.deepEqual(s.feilin, { build: '048', requested: '048', source: 'cdn', pinned: false }, 'rotasi build terlihat di stats');
  assert.equal(JSON.stringify(s).includes('SG_WEB'), false);
});

// --- optional full warm-up (needs jsdom + assets + a DeviceConfig fixture) ------

{
  const fixture = process.env.JSDOM_FARM_TEST_DEVICE_CONFIG;
  let jsdomMod = null;
  try { jsdomMod = resolveJsdom(); } catch { /* not installed here */ }
  const assets = process.env.JSDOM_FARM_ASSETS;
  if (!fixture || !jsdomMod || !assets || !fs.existsSync(assets)) {
    console.log('  · warm-up test skipped (needs JSDOM_PATH + JSDOM_FARM_ASSETS + JSDOM_FARM_TEST_DEVICE_CONFIG)');
  } else {
    await t('full offline warm-up: SDK boots in jsdom and mints tokens (replay mode)', async () => {
      const blob = fs.readFileSync(fixture, 'utf8').trim();
      const farm = new JsdomFarm({ prefix: 'no8xfe', mode: 'replay', deviceConfig: blob, assetsDir: assets, cacheDir: path.join(tmp, 'cdn') });
      try {
        const marks = await farm.start();
        assert.ok(marks.readyMs > 0);
        assert.equal(farm.warmed, true);
        const tokens = await farm.harvest(3);
        assert.equal(tokens.length, 3);
        for (const tk of tokens) assert.ok(tk.length >= farm.minTokenLen);
        assert.equal(tokens[0].slice(0, 7), 'U0dfV0V', 'device tokens are b64 of SG_WEB#…');
      } finally {
        await farm.stop();
      }
    });
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed` + (process.exitCode ? ' (with failures)' : ''));
