// proxy.mjs — one shared egress for everything the solver sends out: the
// Init/Verify calls (fetch) and the farm's Chrome (Playwright).
//
// List format, one proxy per line (blank lines and '#' comments are skipped):
//   host:port:user:pass      Webshare export (the password may contain ':')
//   user:pass@host:port      URL form, optionally prefixed with http://
//   host:port                no auth
// HTTP proxies only (CONNECT). SOCKS is not supported.
//
// Strategy is sticky: one proxy is used until it fails, then the router moves to
// the next one and cools the failed one down. Init and Verify must leave from the
// same IP, so per-request rotation is deliberately not offered.
//
// Nothing here knows which hosts or statuses mean "blocked" for a given site.
// The caller passes `rotateOn(res, url)` and returns a reason string to rotate,
// or null to keep the current proxy.

import fs from 'node:fs';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

// Connection-level codes: the proxy itself could not be reached.
const PROXY_DOWN = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);
// undici's message when a CONNECT through the proxy is refused (407, 403, 5xx).
const PROXY_REJECTED = /^Proxy response \(\d+\)|^Proxy Authentication Required \(407\)/;
// Chrome's proxy-side failures, e.g. "net::ERR_TUNNEL_CONNECTION_FAILED".
const CHROME_PROXY_ERROR = /net::(ERR_(?:PROXY|TUNNEL)_[A-Z_]+)/;

// Error messages never include the line itself: it may contain a password.
export function parseProxyLine(raw, lineNo = 0) {
  const fail = (why) => {
    throw new Error(`proxy list line ${lineNo}: ${why}`);
  };
  let s = raw.trim().replace(/^http:\/\//i, '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) fail('only http:// proxies are supported');

  // URL form: user:pass@host:port. The last '@' splits, so the password may contain '@'.
  let userinfo = null;
  const at = s.lastIndexOf('@');
  if (at >= 0) {
    userinfo = s.slice(0, at);
    s = s.slice(at + 1);
  }
  s = s.replace(/\/+$/, '');
  const parts = s.split(':');

  let host;
  let port;
  let username = '';
  let password = '';
  if (userinfo !== null) {
    const colon = userinfo.indexOf(':');
    if (colon < 0) fail('user@host form needs a password (user:pass@host:port)');
    if (parts.length !== 2) fail('expected host:port after "@"');
    username = userinfo.slice(0, colon);
    password = userinfo.slice(colon + 1);
    [host, port] = parts;
  } else if (parts.length === 2) {
    [host, port] = parts;
  } else if (parts.length >= 4) {
    [host, port] = parts;
    username = parts[2];
    password = parts.slice(3).join(':');
  } else {
    fail('unrecognised format (host:port or host:port:user:pass)');
  }

  const portNum = Number(port);
  if (!host || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    fail('invalid host or port');
  }
  return { host, port: portNum, username, password };
}

export function parseProxyList(text) {
  const proxies = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    proxies.push(parseProxyLine(line, i + 1));
  });
  if (!proxies.length) throw new Error('proxy list has no proxy lines');
  return proxies;
}

// Reason if the error came from the proxy path, null otherwise. TLS or socket
// errors after the tunnel is up are not counted: they are not the proxy's fault,
// and rotating on them would discard a healthy proxy. Abort from the caller's own
// signal is checked by ProxyRouter.fetch, not here: undici also names its CONNECT
// refusal 'AbortError', and that case must count.
export function proxyFailureReason(err) {
  for (let e = err, depth = 0; e && depth < 6; e = e.cause, depth++) {
    if (PROXY_DOWN.has(e.code)) return e.code;
    if (PROXY_REJECTED.test(e.message ?? '')) return e.message;
  }
  return null;
}

// Playwright/Chrome counterpart of proxyFailureReason, from an error message.
export function chromeProxyFailureReason(message) {
  const m = CHROME_PROXY_ERROR.exec(String(message ?? ''));
  return m ? m[1] : null;
}

export class ProxyRouter {
  /**
   * @param {Array<{host:string, port:number, username?:string, password?:string}>} proxies
   * @param {object} [opts]
   * @param {number}   [opts.cooldownMs=300000]  how long a failed proxy sits out
   * @param {function} [opts.rotateOn]           (res, url) => reason | null; a string moves to the next proxy
   * @param {function} [opts.log]                receives one-line messages (never credentials)
   * @param {function} [opts.now=Date.now]       clock, injectable for tests
   */
  constructor(proxies, { cooldownMs = 300_000, rotateOn = null, log = () => {}, now = Date.now } = {}) {
    if (!proxies?.length) throw new Error('ProxyRouter needs at least one proxy');
    this.cooldownMs = cooldownMs;
    this.rotateOn = rotateOn;
    this.log = log;
    this.now = now;
    this.entries = proxies.map((p, i) => {
      const server = `http://${p.host}:${p.port}`;
      const hasAuth = Boolean(p.username);
      return {
        index: i + 1, // 1-based position in the list; the only identity that leaves this module
        // Option object for Playwright's launch `proxy`. Only TokenFarm reads it.
        playwrightProxy: hasAuth ? { server, username: p.username, password: p.password } : { server },
        agent: new ProxyAgent({
          uri: server,
          ...(hasAuth ? { token: `Basic ${Buffer.from(`${p.username}:${p.password}`).toString('base64')}` } : {}),
        }),
        cooldownUntil: 0,
        failures: 0,
      };
    });
    this.active = 0;
    this.switches = 0;
  }

  /** The entry the next request should use. */
  current() {
    if (this.entries[this.active].cooldownUntil > this.now()) this.advance(this.now());
    return this.entries[this.active];
  }

  /** Mark an entry as failed. If it is the active one, move on to another proxy. */
  fail(entry, reason) {
    const t = this.now();
    entry.cooldownUntil = t + this.cooldownMs;
    entry.failures++;
    this.log(`proxy #${entry.index} failed (${reason}), cooling down ${Math.round(this.cooldownMs / 1000)}s`);
    if (entry === this.entries[this.active]) {
      const before = this.active;
      this.advance(t);
      if (this.active !== before) this.log(`switched to proxy #${this.entries[this.active].index}`);
    }
  }

  advance(t) {
    const n = this.entries.length;
    for (let k = 1; k < n; k++) {
      const i = (this.active + k) % n;
      if (this.entries[i].cooldownUntil <= t) {
        this.active = i;
        this.switches++;
        return;
      }
    }
    // Everything is cooling: take the one that finishes cooling first.
    let best = this.active;
    for (let i = 0; i < n; i++) {
      if (this.entries[i].cooldownUntil < this.entries[best].cooldownUntil) best = i;
    }
    if (best !== this.active) {
      this.active = best;
      this.switches++;
    }
  }

  /**
   * fetch() through the active proxy. Proxy-level failures and rotateOn hits move
   * the router on. The request itself is not retried: the caller sees the error.
   */
  async fetch(input, init = {}) {
    const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const entry = this.current();
    let res;
    try {
      res = await undiciFetch(input, { ...init, dispatcher: entry.agent });
    } catch (err) {
      // An abort from the caller's own signal is not the proxy's fault.
      const reason = init.signal?.aborted ? null : proxyFailureReason(err);
      if (reason) this.fail(entry, reason);
      throw err;
    }
    const reason = this.rotateOn?.(res, href);
    if (reason) this.fail(entry, reason);
    return res;
  }

  status() {
    const t = this.now();
    return {
      total: this.entries.length,
      active: this.entries[this.active].index,
      cooling: this.entries.filter((e) => e.cooldownUntil > t).length,
      failures: this.entries.reduce((sum, e) => sum + e.failures, 0),
      switches: this.switches,
    };
  }

  /** Closes immediately. Does not wait for streams that are still running. */
  async destroy() {
    await Promise.all(this.entries.map((e) => e.agent.destroy()));
  }
}

export function loadProxyRouter(file, opts) {
  return new ProxyRouter(parseProxyList(fs.readFileSync(file, 'utf8')), opts);
}
