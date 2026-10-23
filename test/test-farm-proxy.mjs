// test-farm-proxy.mjs — the farm's Chrome leaves through the proxy router, and
// proxy-level failures move it on. Real Chrome against local proxies only;
// nothing reaches the internet.
// Run: node test/test-farm-proxy.mjs   (needs Chrome; set CHROME_PATH if it is
// not in a well-known location — the test skips itself when none is found)

import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TokenFarm } from '../src/token-farm.mjs';
import { resolveChromeExecutable } from '../src/chrome.mjs';
import { ProxyRouter, parseProxyLine } from '../src/proxy.mjs';

const chrome = resolveChromeExecutable();
if (!chrome) {
  console.log('farm egress through the proxy router');
  console.log('  · skipped: Chrome not found (set CHROME_PATH or install Chrome)');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const profile = path.join(here, '.tmp-farm-profile');
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const closeServer = (server) => {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
};
async function deadPort() {
  const s = net.createServer();
  const port = await listen(s);
  await closeServer(s);
  return port;
}

// Records every request. Missing or wrong auth gets 407. Right auth gets the
// socket closed, so Chrome shows ERR_EMPTY_RESPONSE: a page error, not a proxy failure.
function makeRecorder(user, pass) {
  const hits = [];
  const ok = (req) => req.headers['proxy-authorization'] === basic(user, pass);
  const deny = 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\nContent-Length: 0\r\n\r\n';
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, auth: req.headers['proxy-authorization'] ?? null });
    if (!ok(req)) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic', 'Content-Length': '0' });
      return res.end();
    }
    req.socket.destroy();
  });
  server.on('connect', (req, sock) => {
    hits.push({ url: req.url, auth: req.headers['proxy-authorization'] ?? null });
    sock.on('error', () => {});
    if (!ok(req)) return sock.end(deny);
    sock.destroy();
  });
  return { server, hits };
}

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
const pageLoads = (hits) => hits.filter((h) => h.url.includes('farm-test.invalid')).length;

console.log('farm egress through the proxy router');

// isStale() needs no Chrome: a farm that never launched cannot be stale, and one
// whose router moved on since its launch is.
{
  // The router hands out the same entry object each time; isStale compares identity.
  const e1 = { index: 1 };
  const e2 = { index: 2 };
  const fakeRouter = { current: () => e1 };
  const f = new TokenFarm({ url: 'https://farm-test.invalid', prefix: 'abc123', region: 'sgp', proxy: fakeRouter, profile: path.join(here, '.tmp-stale-unused') });
  f.launchedProxy = e1;
  f.context = null;
  assert.equal(f.isStale(), false, 'never launched: not stale');
  f.context = {};
  assert.equal(f.isStale(), false, 'launched on the active proxy: not stale');
  fakeRouter.current = () => e2;
  assert.equal(f.isStale(), true, 'router moved on: stale');
  f.proxy = null;
  assert.equal(f.isStale(), false, 'no proxy: never stale');
  passed++;
  console.log('  ✓ isStale() follows the router');
}

const dead = await deadPort();
const recB = makeRecorder('ub', 'pb');
const recC = makeRecorder('uc', 'pc');
const portB = await listen(recB.server);
const portC = await listen(recC.server);
const router = new ProxyRouter(
  [
    parseProxyLine(`127.0.0.1:${dead}:ua:pa`), // #1: nothing listens here
    parseProxyLine(`127.0.0.1:${portB}:ub:pb`),
    parseProxyLine(`127.0.0.1:${portC}:uc:pc`),
  ],
  { cooldownMs: 60_000 }
);
const farm = new TokenFarm({
  url: 'http://farm-test.invalid/', // never resolved: requests go to the proxy
  prefix: 'abc123',
  profile,
  executablePath: chrome,
  proxy: router,
});

try {
  await t('dead proxy #1 is skipped inside start(): the launch retries on #2 with its credentials', async () => {
    const err = await farm.start().then(() => null, (e) => e);
    assert.ok(err, 'page load through #2 must fail (its socket is closed)');
    assert.match(err.message, /ERR_EMPTY_RESPONSE/, `expected the page error from #2, got: ${err.message}`);
    assert.equal(farm.launchedProxy.index, 2);
    assert.ok(
      recB.hits.some((h) => h.url.includes('farm-test.invalid') && h.auth === basic('ub', 'pb')),
      `proxy #2 did not see an authenticated request: ${JSON.stringify(recB.hits)}`
    );
    assert.equal(router.status().active, 2);
    assert.equal(router.status().failures, 1, 'only the dead proxy counts as failed');
  });

  await t('after another component moves the router, the next harvest relaunches Chrome on #3', async () => {
    router.fail(router.current(), 'test: failed Verify through #2');
    const beforeB = pageLoads(recB.hits);
    const err = await farm.harvest(1).then(() => null, (e) => e);
    assert.ok(err && /ERR_EMPTY_RESPONSE/.test(err.message), `unexpected: ${err?.message}`);
    assert.equal(farm.launchedProxy.index, 3);
    assert.ok(
      recC.hits.some((h) => h.url.includes('farm-test.invalid') && h.auth === basic('uc', 'pc')),
      `proxy #3 did not see an authenticated request: ${JSON.stringify(recC.hits)}`
    );
    assert.equal(pageLoads(recB.hits), beforeB, 'no new page load through #2 after the move');
  });
} finally {
  await farm.stop();
  await router.destroy();
  await closeServer(recB.server);
  await closeServer(recC.server);
  fs.rmSync(profile, { recursive: true, force: true });
}

console.log(`\n${passed} passed`);
