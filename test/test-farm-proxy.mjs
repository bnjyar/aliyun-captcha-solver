// test-farm-proxy.mjs — the farm's Chrome leaves through the proxy router.
// Uses the real Chrome (executablePath default) against two local recorder
// proxies. They answer CONNECT with 502, so nothing reaches the internet.
// Run: node test/test-farm-proxy.mjs   (needs /usr/bin/google-chrome-stable)

import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TokenFarm } from '../src/token-farm.mjs';
import { ProxyRouter, parseProxyLine } from '../src/proxy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const profile = path.join(here, '.tmp-farm-profile');
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const closeServer = (server) => {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
};

// Records every CONNECT. Wrong auth gets 407; right auth gets 502 (no upstream).
function makeRecorder(user, pass) {
  const hits = [];
  const server = http.createServer((req, res) => res.end());
  server.on('connect', (req, sock) => {
    hits.push({ target: req.url, auth: req.headers['proxy-authorization'] ?? null });
    sock.on('error', () => {});
    if (req.headers['proxy-authorization'] !== basic(user, pass)) {
      sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    sock.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
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

console.log('farm egress through the proxy router');

const recA = makeRecorder('ua', 'pa');
const recB = makeRecorder('ub', 'pb');
const portA = await listen(recA.server);
const portB = await listen(recB.server);
const router = new ProxyRouter(
  [
    parseProxyLine(`127.0.0.1:${portA}:ua:pa`),
    parseProxyLine(`127.0.0.1:${portB}:ub:pb`),
  ],
  { cooldownMs: 60_000 }
);
const farm = new TokenFarm({
  url: 'https://farm-test.invalid/', // never resolved: CONNECT goes to the recorder
  prefix: 'no8xfe',
  profile,
  proxy: router,
});

try {
  await t('first launch: Chrome CONNECTs through proxy #1 with its credentials; failure moves to #2', async () => {
    let err = null;
    try {
      await farm.start();
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'navigation through a 502 proxy must fail');
    assert.match(err.message, /ERR_(TUNNEL|PROXY)_/, `unexpected error: ${err.message}`);
    assert.ok(
      recA.hits.some((h) => h.target === 'farm-test.invalid:443' && h.auth === basic('ua', 'pa')),
      `proxy #1 did not see an authenticated CONNECT: ${JSON.stringify(recA.hits)}`
    );
    assert.equal(farm.launchedProxy.index, 1);
    assert.equal(router.status().active, 2);
    assert.equal(router.status().failures, 1);
  });

  await t('next harvest relaunches Chrome on proxy #2; the page is no longer loaded through #1', async () => {
    // Chrome's background requests (update, gstatic) may still reach #1 while the
    // old instance shuts down. Only the page load is asserted here.
    const pageLoadsOnA = () => recA.hits.filter((h) => h.target === 'farm-test.invalid:443').length;
    const beforeA = pageLoadsOnA();
    await assert.rejects(farm.harvest(1));
    assert.equal(farm.launchedProxy.index, 2);
    assert.ok(
      recB.hits.some((h) => h.target === 'farm-test.invalid:443' && h.auth === basic('ub', 'pb')),
      `proxy #2 did not see an authenticated CONNECT: ${JSON.stringify(recB.hits)}`
    );
    assert.equal(pageLoadsOnA(), beforeA, 'the cooled-down proxy #1 gets no new page load');
  });
} finally {
  await farm.stop();
  await router.destroy();
  await closeServer(recA.server);
  await closeServer(recB.server);
  fs.rmSync(profile, { recursive: true, force: true });
}

console.log(`\n${passed} passed`);
