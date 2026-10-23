// test-solver.mjs — unit tests for the browserless captcha solver primitives.
// Run: node test-solver.mjs   (no network, no browser — pure crypto checks)
//
// This file pins CIPHER CORRECTNESS so a future FeiLin bundle change is caught
// early, before any live request starts failing silently.

import assert from 'node:assert';
import { generateArg, aliHash, encrypt, createAliyunCaptcha } from '../src/aliyun-captcha.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
// Async cases run SEQUENTIALLY after the sync ones, never concurrently: they
// stub globalThis.fetch, and two overlapping stubs make one restore the real
// fetch while the other is still mid-request (which silently turns a unit test
// into a live API call).
const queue = [];
const pass = (name) => {
  passed++;
  console.log(`  ✓ ${name}`);
};
const fail = (name, e) => {
  console.error(`  ✗ ${name}: ${e.message}`);
  process.exitCode = 1;
};
const t = (name, fn) => {
  if (fn.constructor.name === 'AsyncFunction') {
    queue.push([name, fn]);
    return;
  }
  try {
    fn();
    pass(name);
  } catch (e) {
    fail(name, e);
  }
};

console.log('cipher primitives (vectors from the Go reference):');

t('generateArg matches reference', () => {
  // Vector produced by the Go reference for generateArg("test-certify-id-123")
  assert.equal(generateArg('test-certify-id-123'), 'bmJ4MnKBW5JkEHw4c1UHahtMQQ==');
});

t('aliHash matches reference', () => {
  // From the Python reference ali_hash('{"TrackList":{"fi":"","startTime":12345},"arg":"abc"}', '0000')
  assert.equal(
    aliHash('{"TrackList":{"fi":"","startTime":12345},"arg":"abc"}', '0000'),
    'c3174e3f2301f33edc4477a2302ed81a'
  );
});

t('encrypt matches reference', () => {
  assert.equal(encrypt('dGVzdA=='), 'JC5bWQdVBhY=');
});

t('aliHash is deterministic & salt-sensitive', () => {
  const a = aliHash('hello', '0000');
  const b = aliHash('hello', '0000');
  const c = aliHash('hello', '0001');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

t('generateArg is idempotent per certifyId', () => {
  assert.equal(generateArg('abc123'), generateArg('abc123'));
  assert.notEqual(generateArg('abc123'), generateArg('abc124'));
});

console.log('\nrequest shape (regression, silent-400 class):');

t('Timestamp is second-precision ISO-8601', async () => {
  // Regression: an earlier port stripped only the millisecond DIGITS, leaving
  // "2026-10-13T12:23:19.Z". Aliyun answers that with
  // {"Message":"Timestamp is illegal!","Code":400} on EVERY call — including
  // verifies — and the signature is never even evaluated, so nothing about the
  // failure points at the timestamp. Pin the wire format instead.
  const realFetch = globalThis.fetch;
  let body = '';
  globalThis.fetch = async (_url, opts) => {
    body = opts.body;
    return {
      text: async () => JSON.stringify({ CertifyId: 'TESTCERTIFY', CaptchaType: 'TRACELESS' }),
    };
  };
  try {
    const c = createAliyunCaptcha({
      accessKey: 'AK',
      secretKey: 'SK',
      sceneId: 'scene1',
      prefix: 'abc123',
    });
    await c.initCaptchaRaw();
  } finally {
    globalThis.fetch = realFetch;
  }
  const ts = decodeURIComponent(new URLSearchParams(body).get('Timestamp'));
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `got "${ts}"`);
});

t('initCaptcha stays a thin wrapper over initCaptchaRaw', async () => {
  // Existing callers (captcha-pool, anything importing the client) expect a
  // bare CertifyId string — the raw-response helper must not change that.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ text: async () => JSON.stringify({ CertifyId: 'ABC123' }) });
  try {
    const c = createAliyunCaptcha({
      accessKey: 'AK',
      secretKey: 'SK',
      sceneId: 'scene1',
      prefix: 'abc123',
    });
    assert.equal(await c.initCaptcha(), 'ABC123');
    assert.deepEqual(await c.initCaptchaRaw(), { CertifyId: 'ABC123' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

t('computeCaptchaParam returns the final param on success', async () => {
  const realFetch = globalThis.fetch;
  const replies = [
    JSON.stringify({ CertifyId: 'CERT2', CaptchaType: 'TRACELESS' }),
    JSON.stringify({ Success: true, Result: { VerifyResult: true, certifyId: 'CERT2', securityToken: 'SEC' } }),
  ];
  globalThis.fetch = async () => ({ text: async () => replies.shift() });
  let param;
  try {
    const c = createAliyunCaptcha({ accessKey: 'AK', secretKey: 'SK', sceneId: 'scene1', prefix: 'abc123' });
    param = await c.computeCaptchaParam('DEVTOKEN');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(JSON.parse(Buffer.from(param, 'base64').toString('utf8')), {
    certifyId: 'CERT2',
    isSign: true,
    sceneId: 'scene1',
    securityToken: 'SEC',
  });
});

t('verify rejection carries the Init CaptchaType', async () => {
  // Diagnostic: an F011 alone does not say whether Aliyun issued a slider
  // (INPAINTING) or TRACELESS at Init, so the rejection must carry both.
  const realFetch = globalThis.fetch;
  const replies = [
    JSON.stringify({ CertifyId: 'CERT3', CaptchaType: 'INPAINTING' }),
    JSON.stringify({ Success: true, Result: { VerifyResult: false, VerifyCode: 'F011' } }),
  ];
  globalThis.fetch = async () => ({ text: async () => replies.shift() });
  let err;
  try {
    const c = createAliyunCaptcha({ accessKey: 'AK', secretKey: 'SK', sceneId: 'scene1', prefix: 'abc123' });
    await c.computeCaptchaParam('DEVTOKEN');
  } catch (e) {
    err = e;
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(err, 'verify should be rejected');
  assert.equal(err.verifyCode, 'F011');
  assert.equal(err.captchaType, 'INPAINTING');
});

console.log('\ntenant client config:');

t('client derives endpoints from prefix + region', () => {
  const c = createAliyunCaptcha({
    accessKey: 'AK',
    secretKey: 'SK',
    sceneId: 'scene1',
    prefix: 'abc123',
    region: 'southeast',
  });
  assert.equal(c.initUrl, 'https://abc123.captcha-open-southeast.aliyuncs.com/');
  assert.equal(c.verifyUrl, 'https://abc123-verify.captcha-open-southeast.aliyuncs.com/');
});

t('SDK region token differs from DNS region token', () => {
  // Real-world shape: window.AliyunCaptchaConfig region is 'sgp',
  // but the DNS host uses 'southeast'.
  const c = createAliyunCaptcha({
    accessKey: 'AK',
    secretKey: 'SK',
    sceneId: 'scene1',
    prefix: 'abc123',
    region: 'sgp',
    endpointRegion: 'southeast',
  });
  assert.equal(c.region, 'sgp');
  assert.equal(c.initUrl, 'https://abc123.captcha-open-southeast.aliyuncs.com/');
});

t('missing config is rejected loudly', () => {
  assert.throws(() => createAliyunCaptcha({ secretKey: 'SK', sceneId: 's', prefix: 'p' }), /accessKey/);
  assert.throws(() => createAliyunCaptcha({ accessKey: 'AK', sceneId: 's', prefix: 'p' }), /secretKey/);
  assert.throws(() => createAliyunCaptcha({ accessKey: 'AK', secretKey: 'SK', prefix: 'p' }), /sceneId/);
  assert.throws(() => createAliyunCaptcha({ accessKey: 'AK', secretKey: 'SK', sceneId: 's' }), /prefix/);
});

console.log('\nconstants are intact (no accidental edits):');

t('cipher constants are untouched', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/aliyun-captcha.mjs'), 'utf8');
  assert.ok(src.includes("'4xrihv8zb8tf1mfj'"), 'arg constant');
  assert.ok(src.includes("'3e627e1b4c63f913'"), 'encrypt key');
  assert.ok(src.includes('32, 50, 10, 51, 6, 44, 37, 16'), 'perm table head');
  assert.ok(src.includes('24, 28, 14, 9, 0, 21'), 'perm table tail');
});

t('no tenant credentials are hardcoded', () => {
  // This package is platform-agnostic: every tenant value must come from
  // config. If a tenant credential ever creeps back in, this fails.
  const src = fs.readFileSync(path.join(__dirname, '../src/aliyun-captcha.mjs'), 'utf8');
  assert.ok(!/LTAI[A-Za-z0-9]{16,}/.test(src), 'no hardcoded AccessKeyId');
  assert.ok(!/sceneId\s*[:=]\s*['"][^'"]+['"]/.test(src), 'no hardcoded scene id');
});

for (const [name, fn] of queue) {
  try {
    await fn();
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}
console.log(`\n${passed} passed`);
