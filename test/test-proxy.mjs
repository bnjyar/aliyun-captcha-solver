// test-proxy.mjs — unit and local integration tests for src/proxy.mjs and the
// `proxy` option of createAliyunCaptcha. No external network: upstream and proxy
// run on 127.0.0.1 with fake credentials.
// Run: node test/test-proxy.mjs

import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import {
  ProxyRouter,
  chromeProxyFailureReason,
  parseProxyLine,
  parseProxyList,
  proxyFailureReason,
  transportFailureReason,
} from '../src/proxy.mjs';
import { createAliyunCaptcha } from '../src/aliyun-captcha.mjs';

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

const SECRET = 'S3cret-Pass'; // fake
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const closeServer = (server) => {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
};
const errorOf = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.message;
  }
};

// Upstream that records each request and answers with the given status.
function makeUpstream(status) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method, body });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: status < 400, echo: body }));
    });
  });
  return { server, hits };
}

// HTTP proxy on localhost. undici tunnels http:// and https:// alike with CONNECT,
// so handling CONNECT is enough. Wrong auth gets 407, right auth gets a tunnel.
function makeProxy(user, pass) {
  const hits = [];
  const server = http.createServer((req, res) => res.end());
  server.on('connect', (req, sock) => {
    hits.push({ target: req.url, auth: req.headers['proxy-authorization'] ?? null });
    sock.on('error', () => {});
    if (req.headers['proxy-authorization'] !== basic(user, pass)) {
      sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const [host, port] = req.url.split(':');
    const up = net.connect(Number(port), host, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
  });
  return { server, hits };
}

async function deadPort() {
  const s = net.createServer();
  const port = await listen(s);
  await closeServer(s);
  return port;
}

// Accepts the TCP connection and then never answers the CONNECT request. The
// tunnels are tracked so cleanup can destroy them: server.closeAllConnections()
// does not cover upgraded/connect sockets.
function makeSilentProxy() {
  const sockets = new Set();
  const server = http.createServer(() => {});
  server.on('connect', (req, sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    // no response on purpose
  });
  return { server, sockets, destroy: () => { for (const s of sockets) s.destroy(); } };
}

// Answers CONNECT with 200 and then kills the tunnel right away — the signature of a
// half-dead proxy (real one measured 2026-10-16: "Client network socket disconnected
// before secure TLS connection was established", ECONNRESET).
function makeHalfDeadProxy() {
  const sockets = new Set();
  const server = http.createServer((req, res) => res.end());
  server.on('connect', (req, sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    setImmediate(() => sock.destroy());
  });
  return { server, sockets, destroy: () => { for (const s of sockets) s.destroy(); } };
}

const entryOf = (port, username, password) => ({ host: '127.0.0.1', port, username, password });
const three = () => ['1.1.1.1:1:a:a', '2.2.2.2:2:b:b', '3.3.3.3:3:c:c'].map((s) => parseProxyLine(s));

console.log('parsing');

await t('Webshare host:port:user:pass', () => {
  assert.deepStrictEqual(parseProxyLine('45.38.107.97:6014:u1:p1', 1), {
    host: '45.38.107.97', port: 6014, username: 'u1', password: 'p1',
  });
});

await t('password may contain ":"', () => {
  assert.equal(parseProxyLine('1.2.3.4:6014:u1:a:b').password, 'a:b');
});

await t('user:pass@host:port, with or without http:// and trailing slash', () => {
  const want = { host: '1.2.3.4', port: 6014, username: 'u1', password: 'p1' };
  assert.deepStrictEqual(parseProxyLine('u1:p1@1.2.3.4:6014'), want);
  assert.deepStrictEqual(parseProxyLine('http://u1:p1@1.2.3.4:6014/'), want);
});

await t('host:port without auth', () => {
  assert.deepStrictEqual(parseProxyLine('1.2.3.4:8080'), { host: '1.2.3.4', port: 8080, username: '', password: '' });
});

await t('rejects socks5 and reports the line number without the line', () => {
  const msg = errorOf(() => parseProxyLine('socks5://1.2.3.4:1080', 3));
  assert.match(msg, /line 3: only http:\/\/ proxies/);
});

await t('rejects bad port, three fields and user@host without password; never echoes the password', () => {
  for (const line of [`1.2.3.4:70000:u1:${SECRET}`, '1.2.3.4:6014:u1', 'u1@1.2.3.4:6014', `1.2.3.4:abc:u1:${SECRET}`]) {
    const msg = errorOf(() => parseProxyLine(line, 7));
    assert.ok(msg && msg.includes('line 7'), `no line number: ${msg}`);
    assert.ok(!msg.includes(SECRET), `password leaked: ${msg}`);
  }
});

await t('list skips comments and blank lines, accepts CRLF, rejects empty list', () => {
  assert.equal(parseProxyList('# Webshare\r\n\r\n1.2.3.4:6014:u1:p1\r\n5.6.7.8:6015:u1:p1\r\n').length, 2);
  assert.match(errorOf(() => parseProxyList('# only comments\n')), /no proxy lines/);
  assert.match(errorOf(() => parseProxyList('1.2.3.4:6014:u1:p1\nbroken-line')), /line 2/);
});

console.log('router (sticky + cooldown, fake clock)');

await t('starts at #1; a failure on the active proxy moves to #2 and sticks there after cooldown', () => {
  let t0 = 1000;
  const r = new ProxyRouter(three(), { cooldownMs: 100, now: () => t0 });
  assert.equal(r.current().index, 1);
  r.fail(r.current(), 'test');
  assert.equal(r.current().index, 2);
  t0 = 1150;
  assert.equal(r.current().index, 2, 'no switch back to #1');
});

await t('failure on a non-active proxy does not move the router', () => {
  const r = new ProxyRouter(three(), { cooldownMs: 100, now: () => 1000 });
  r.fail(r.entries[2], 'test');
  assert.equal(r.current().index, 1);
  assert.equal(r.status().failures, 1);
});

await t('when all are cooling, the one that finishes cooling first is used', () => {
  let t0 = 1000;
  const r = new ProxyRouter(three(), { cooldownMs: 100, now: () => t0 });
  r.fail(r.entries[0], 'test');
  t0 = 1010;
  r.fail(r.entries[1], 'test');
  t0 = 1020;
  r.fail(r.entries[2], 'test');
  assert.equal(r.current().index, 1);
  assert.deepStrictEqual(
    { cooling: r.status().cooling, failures: r.status().failures },
    { cooling: 3, failures: 3 }
  );
});

await t('playwrightProxy carries server and credentials only when auth is set', () => {
  const r = new ProxyRouter([parseProxyLine('1.2.3.4:6014:u1:p1'), parseProxyLine('1.2.3.5:6015')]);
  assert.deepStrictEqual(r.entries[0].playwrightProxy, { server: 'http://1.2.3.4:6014', username: 'u1', password: 'p1' });
  assert.deepStrictEqual(r.entries[1].playwrightProxy, { server: 'http://1.2.3.5:6015' });
  return r.destroy();
});

await t('timeoutMs defaults to 60 s; 0 disables the watchdog', async () => {
  const r = new ProxyRouter(three());
  assert.equal(r.timeoutMs, 60_000);
  const off = new ProxyRouter(three(), { timeoutMs: 0 });
  assert.equal(off.timeoutMs, 0);
  await Promise.all([r.destroy(), off.destroy()]);
});

console.log('failure classification');

await t('connection refused counts as a proxy failure', () => {
  const err = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });
  assert.equal(proxyFailureReason(err), 'ECONNREFUSED');
});

await t('CONNECT refusal counts, even though undici names it AbortError', () => {
  const rejected = Object.assign(new Error('Proxy response (407) !== 200 when HTTP Tunneling'), {
    name: 'AbortError',
    code: 'UND_ERR_ABORTED',
  });
  const err = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { cause: rejected }) });
  assert.equal(proxyFailureReason(err), 'Proxy response (407) !== 200 when HTTP Tunneling');
});

await t('ECONNRESET after the tunnel is up does not count', () => {
  const err = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
  });
  assert.equal(proxyFailureReason(err), null);
});

await t('transportFailureReason(): a broken tunnel is named, a clean error is not', () => {
  // Bentuk nyata dari proxy gratis (2026-10-16, diukur dari daftar proxies/all.txt).
  const halfDead = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' }),
  });
  assert.equal(transportFailureReason(halfDead), 'ECONNRESET');
  assert.equal(transportFailureReason(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })), 'ECONNRESET');
  assert.equal(transportFailureReason(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })), 'UND_ERR_SOCKET');
  assert.equal(transportFailureReason(Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND x') })), null, 'DNS bukan transport-break');
  assert.equal(transportFailureReason(new Error('boom')), null);
  assert.equal(proxyFailureReason(halfDead), null, 'klasifikasi lama tetap tidak menghitungnya');
});

await t('Chrome ERR_TUNNEL / ERR_PROXY messages are recognised; plain net errors are not', () => {
  assert.equal(chromeProxyFailureReason('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://x'), 'ERR_TUNNEL_CONNECTION_FAILED');
  assert.equal(chromeProxyFailureReason('net::ERR_PROXY_CONNECTION_FAILED'), 'ERR_PROXY_CONNECTION_FAILED');
  assert.equal(chromeProxyFailureReason('net::ERR_CONNECTION_RESET'), null);
  assert.equal(chromeProxyFailureReason(undefined), null);
});

await t('Chrome timeout codes and a page-load timeout count as proxy failures', () => {
  assert.equal(chromeProxyFailureReason('page.goto: net::ERR_TIMED_OUT at https://x'), 'ERR_TIMED_OUT');
  assert.equal(chromeProxyFailureReason('net::ERR_CONNECTION_TIMED_OUT'), 'ERR_CONNECTION_TIMED_OUT');
  assert.equal(chromeProxyFailureReason('page.goto: Timeout 60000ms exceeded.\nCall log: ...'), 'page load timed out');
  assert.equal(chromeProxyFailureReason('page.waitForSelector: Timeout 30000ms exceeded'), null);
});

console.log('integration (undici + local proxy)');

const upOk = makeUpstream(200);
const upBlocked = makeUpstream(405);
const p1 = makeProxy('u1', SECRET);
const p2 = makeProxy('u2', 'p2-fake');
const servers = [upOk.server, upBlocked.server, p1.server, p2.server];
const upOkPort = await listen(upOk.server);
const upBlockedPort = await listen(upBlocked.server);
const p1Port = await listen(p1.server);
const p2Port = await listen(p2.server);
const urlOk = `http://127.0.0.1:${upOkPort}/v1/chat/completions`;
const urlBlocked = `http://127.0.0.1:${upBlockedPort}/v1/chat/completions`;
const healthy = () => [entryOf(p1Port, 'u1', SECRET), entryOf(p2Port, 'u2', 'p2-fake')];
const logs = [];
const mk = (entries, opts = {}) => new ProxyRouter(entries, { cooldownMs: 60_000, log: (m) => logs.push(m), ...opts });

await t('through the active proxy: 200, body and method intact, Basic auth sent', async () => {
  const r = mk(healthy());
  const res = await r.fetch(urlOk, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).echo, '{"a":1}');
  assert.equal(p1.hits.at(-1).auth, basic('u1', SECRET));
  assert.equal(upOk.hits.at(-1).method, 'POST');
  await r.destroy();
});

await t('dead proxy: first call throws, router moves to #2, next call succeeds through #2', async () => {
  const dead = await deadPort();
  const r = mk([entryOf(dead, 'u1', SECRET), entryOf(p2Port, 'u2', 'p2-fake')]);
  await assert.rejects(r.fetch(urlOk));
  assert.equal(r.status().active, 2);
  assert.ok(logs.some((l) => l.includes('ECONNREFUSED')), 'log names ECONNREFUSED');
  const before = p2.hits.length;
  const res = await r.fetch(urlOk);
  assert.equal(res.status, 200);
  assert.equal(p2.hits.length, before + 1);
  await r.destroy();
});

await t('silent proxy: no CONNECT answer within timeoutMs is a failure; router moves to #2', async () => {
  const silent = makeSilentProxy();
  const silentPort = await listen(silent.server);
  const r = mk([entryOf(silentPort, 'u1', SECRET), entryOf(p2Port, 'u2', 'p2-fake')], { timeoutMs: 250 });
  await assert.rejects(r.fetch(urlOk), /did not answer within 250ms/);
  assert.equal(r.status().active, 2);
  assert.equal(r.status().failures, 1);
  assert.ok(logs.some((l) => l.includes('timeout 250ms')), 'log names the timeout');
  const before = p2.hits.length;
  assert.equal((await r.fetch(urlOk)).status, 200);
  assert.equal(p2.hits.length, before + 1);
  await r.destroy();
  silent.destroy();
  await closeServer(silent.server);
});

await t('silent proxy: a caller timeout on the headers (AbortSignal.timeout, Aliyun httpPost) is a failure too', async () => {
  const silent = makeSilentProxy();
  const silentPort = await listen(silent.server);
  // Router watchdog off: only the caller's own timeout can name the silent proxy.
  const r = mk([entryOf(silentPort, 'u1', SECRET), entryOf(p2Port, 'u2', 'p2-fake')], { timeoutMs: 0 });
  const err = await r.fetch(urlOk, { signal: AbortSignal.timeout(250) }).catch((e) => e);
  assert.equal(err.code, 'PROXY_TIMEOUT');
  assert.equal(r.status().failures, 1);
  assert.equal(r.status().active, 2);
  assert.ok(logs.some((l) => l.includes('caller timeout')), 'log names the caller timeout');
  assert.equal((await r.fetch(urlOk)).status, 200);
  await r.destroy();
  silent.destroy();
  await closeServer(silent.server);
});

await t('a proxy-level failure is marked on the error for the caller (proxyFailure)', async () => {
  const closed = net.createServer();
  const closedPort = await listen(closed);
  await closeServer(closed); // nothing listens: ECONNREFUSED on the first proxy
  const r = mk([entryOf(closedPort, 'u1', SECRET), entryOf(p2Port, 'u2', 'p2-fake')]);
  const err = await r.fetch(urlOk).catch((e) => e);
  assert.ok(err.proxyFailure, 'caller can tell a proxy failure from a target failure');
  assert.equal(r.status().active, 2);
  await r.destroy();
});

await t('half-dead proxy (CONNECT 200 lalu tunnel putus): default TIDAK menghitung, opt-in menghitung', async () => {
  const half = makeHalfDeadProxy();
  const halfPort = await listen(half.server);

  // Default: perilaku lama dipertahankan — error naik tanpa proxyFailure, router tidak pindah.
  const rDefault = mk([entryOf(halfPort, 'u1', SECRET), entryOf(p2Port, 'u2', 'p2-fake')]);
  const errDefault = await rDefault.fetch(urlOk).catch((e) => e);
  assert.ok(errDefault, 'request must fail through a half-dead proxy');
  assert.equal(errDefault.proxyFailure, undefined, 'default: bukan proxyFailure');
  assert.equal(rDefault.status().active, 1, 'default: router tetap di #1');
  assert.equal(rDefault.status().failures, 0);
  await rDefault.destroy();

  // Opt-in: tunnel yang putus dihitung gagal -> pindah proxy, penanda untuk pemanggil.
  const rOpt = mk([entryOf(halfPort, 'u1', SECRET), entryOf(p2Port, 'u2', 'p2-fake')], { rotateOnTransportErrors: true });
  const errOpt = await rOpt.fetch(urlOk).catch((e) => e);
  assert.ok(errOpt.proxyFailure, 'opt-in: caller bisa membedakan kegagalan proxy');
  assert.match(String(errOpt.proxyFailure), /ECONNRESET|socket/i);
  assert.equal(rOpt.status().active, 2, 'opt-in: router pindah ke #2');
  assert.equal(rOpt.status().failures, 1);
  assert.ok(logs.some((l) => /proxy #1 failed \((ECONNRESET|.*socket.*)\)/i.test(l)), `log menyebut kegagalannya: ${logs.slice(-3)}`);
  const before = p2.hits.length;
  assert.equal((await rOpt.fetch(urlOk)).status, 200, 'request berikutnya sukses lewat #2');
  assert.equal(p2.hits.length, before + 1);
  await rOpt.destroy();

  half.destroy();
  await closeServer(half.server);
});

await t('a slow body is not cut by the watchdog (the timer stops at the headers)', async () => {
  const slow = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.flushHeaders(); // header keluar segera; body menyusul
    setTimeout(() => res.end(JSON.stringify({ ok: true, late: true })), 600);
  });
  const slowPort = await listen(slow);
  const r = mk(healthy(), { timeoutMs: 200 });
  const res = await r.fetch(`http://127.0.0.1:${slowPort}/slow`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).late, true);
  assert.equal(r.status().failures, 0, 'no proxy failure for a slow body');
  await r.destroy();
  await closeServer(slow);
});

await t('wrong auth (407 on CONNECT): router moves to #2', async () => {
  const r = mk([entryOf(p1Port, 'u1', 'wrong'), entryOf(p2Port, 'u2', 'p2-fake')]);
  await assert.rejects(r.fetch(urlOk));
  assert.equal(r.status().active, 2);
  assert.ok(logs.some((l) => /Proxy response \(407\)/.test(l)));
  assert.equal((await r.fetch(urlOk)).status, 200);
  await r.destroy();
});

await t('rotateOn: a reason from the callback moves the router; the response still reaches the caller', async () => {
  const r = mk(healthy(), {
    rotateOn: (res, url) => (res.status === 405 && url.startsWith(`http://127.0.0.1:${upBlockedPort}`) ? 'HTTP 405 from test' : null),
  });
  const res = await r.fetch(urlBlocked, { method: 'POST', body: '{}' });
  assert.equal(res.status, 405);
  assert.equal(r.status().active, 2);
  const p1Before = p1.hits.length;
  const p2Before = p2.hits.length;
  await r.fetch(urlOk);
  assert.equal(p2.hits.length, p2Before + 1);
  assert.equal(p1.hits.length, p1Before);
  await r.destroy();
});

await t('rotateOn returning null keeps the proxy', async () => {
  const r = mk(healthy(), { rotateOn: () => null });
  assert.equal((await r.fetch(urlBlocked, { method: 'POST', body: '{}' })).status, 405);
  assert.equal(r.status().active, 1);
  assert.equal(r.status().failures, 0);
  await r.destroy();
});

await t('abort from the caller does not count against the proxy', async () => {
  const r = mk(healthy());
  await assert.rejects(r.fetch(urlOk, { signal: AbortSignal.abort() }));
  assert.equal(r.status().failures, 0);
  assert.equal(r.status().active, 1);
  await r.destroy();
});

console.log('createAliyunCaptcha wiring');

const aliyunCfg = { accessKey: 'AK', secretKey: 'SK', sceneId: 'scene1', prefix: 'no8xfe' };

await t('with proxy: Init goes through proxy.fetch, not global fetch', async () => {
  const seen = [];
  const fakeProxy = {
    fetch: async (url) => {
      seen.push(String(url));
      return new Response('{}', { status: 200 });
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('global fetch must not be used when a proxy is set');
  };
  try {
    const c = createAliyunCaptcha({ ...aliyunCfg, proxy: fakeProxy });
    await assert.rejects(c.initCaptchaRaw(), /InitCaptchaV3 failed/);
    assert.deepStrictEqual(seen, [c.initUrl]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await t('without proxy: Init uses global fetch, as before', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response('{}', { status: 200 });
  };
  try {
    const c = createAliyunCaptcha(aliyunCfg);
    await assert.rejects(c.initCaptchaRaw(), /InitCaptchaV3 failed/);
    assert.deepStrictEqual(seen, [c.initUrl]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await t('destroy closes the proxies and the servers shut down cleanly', async () => {
  const r = mk(healthy());
  await r.fetch(urlOk);
  await r.destroy();
  for (const s of servers) await closeServer(s);
});

console.log(`\n${passed} passed`);
