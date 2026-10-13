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
const t = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
};

console.log('cipher primitives (vectors from the Go reference):');

t('generateArg matches reference', () => {
  // From /tmp/glmfree-check generateArg("test-certify-id-123")
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

console.log('\ntenant client config:');

t('client derives endpoints from prefix + region', () => {
  const c = createAliyunCaptcha({
    accessKey: 'AK',
    secretKey: 'SK',
    sceneId: 'scene1',
    prefix: 'no8xfe',
    region: 'southeast',
  });
  assert.equal(c.initUrl, 'https://no8xfe.captcha-open-southeast.aliyuncs.com/');
  assert.equal(c.verifyUrl, 'https://no8xfe-verify.captcha-open-southeast.aliyuncs.com/');
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
  // config. If a Z.ai key ever creeps back in, this fails.
  const src = fs.readFileSync(path.join(__dirname, '../src/aliyun-captcha.mjs'), 'utf8');
  assert.ok(!/LTAI[A-Za-z0-9]{16,}/.test(src), 'no hardcoded AccessKeyId');
  assert.ok(!/didk33e0|11xygtvd/.test(src), 'no hardcoded Z.ai scene ids');
});

console.log(`\n${passed} passed`);
