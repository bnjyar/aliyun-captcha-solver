// test-chrome.mjs — cross-platform Chrome discovery and user-agent shaping.
// Offline; no browser is launched.

import assert from 'node:assert';
import fs from 'node:fs';
import {
  chromeCandidates,
  resolveChromeExecutable,
  platformUserAgent,
  chromeMajorVersion,
} from '../src/chrome.mjs';

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

console.log('cross-platform Chrome resolution');

t('candidate lists are platform-specific', () => {
  assert.ok(chromeCandidates('linux').includes('/usr/bin/google-chrome-stable'));
  assert.ok(chromeCandidates('darwin').some((p) => p.includes('Google Chrome.app')));
  assert.ok(chromeCandidates('win32').some((p) => /chrome\.exe$/i.test(p)));
  assert.ok(chromeCandidates('win32').every((p) => p.includes('\\') || p.includes('/')));
});

t('an explicit executablePath is returned as-is, even when missing', () => {
  assert.equal(resolveChromeExecutable('/nope/chrome'), '/nope/chrome');
});

t('CHROME_PATH wins over platform probing', () => {
  const prev = process.env.CHROME_PATH;
  process.env.CHROME_PATH = '/env/chrome';
  try {
    assert.equal(resolveChromeExecutable(), '/env/chrome');
  } finally {
    if (prev === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = prev;
  }
});

t('resolveChromeExecutable() returns null or a path that exists', () => {
  const found = resolveChromeExecutable();
  assert.ok(found === null || fs.existsSync(found), `not a real path: ${found}`);
});

t('user agent follows the host platform and the detected major version', () => {
  assert.match(platformUserAgent('145', 'darwin'), /Macintosh.*Chrome\/145\./);
  assert.match(platformUserAgent('145', 'win32'), /Windows NT 10\.0.*Chrome\/145\./);
  assert.match(platformUserAgent('145', 'linux'), /X11; Linux x86_64.*Chrome\/145\./);
});

t('a missing version falls back without producing an empty UA', () => {
  assert.match(platformUserAgent(null, 'linux'), /Chrome\/\d+\./);
});

t('chromeMajorVersion honours CHROME_MAJOR_VERSION and tolerates a bad path', () => {
  const prev = process.env.CHROME_MAJOR_VERSION;
  process.env.CHROME_MAJOR_VERSION = '151';
  try {
    assert.equal(chromeMajorVersion('/nope/chrome'), '151');
  } finally {
    if (prev === undefined) delete process.env.CHROME_MAJOR_VERSION;
    else process.env.CHROME_MAJOR_VERSION = prev;
  }
  assert.equal(chromeMajorVersion('/nope/chrome'), null);
  assert.equal(chromeMajorVersion(null), null);
});

console.log(`\n${passed} passed`);
