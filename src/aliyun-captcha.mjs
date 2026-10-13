// aliyun-captcha.mjs — Browserless Aliyun Captcha 2.0 param generator.
//
// Platform-agnostic. A single tenant is described by one config object:
//   { accessKey, secretKey, sceneId, region, endpointRegion, prefix }
// SceneIds are public values found in the target site's JS
// (window.AliyunCaptchaConfig / initAliyunCaptcha call).
//
// Flow: InitCaptchaV3 -> certifyId
//       generateArg(certifyId)          RC4-like KSA+PRGA over 64-entry perm table
//       track JSON + aliHash + zlib + b64 + encrypt -> "data"
//       VerifyCaptchaV3(certifyId, data, deviceToken) -> securityToken
//       final = base64(JSON{certifyId,isSign:true,sceneId,securityToken})
//
// The ONLY external input is the one-time deviceToken, harvested from a real
// browser tab via window.z_um.getToken() (see token-farm.mjs).

import crypto from 'node:crypto';
import zlib from 'node:zlib';

// --- SDK-global constants ----------------------------------------------------
// These come from the FeiLin (阿里云验证码) frontend bundle, not from any one
// tenant. Verified across scenes on the same tenant; if Aliyun ever rotates
// them, test/test-solver.mjs fails first. Pass your own overrides only if you
// have observed a different SDK build.
const ARG_CONSTANT = '4xrihv8zb8tf1mfj';
const ENCRYPT_KEY = '3e627e1b4c63f913';

const ARG_PERM_TABLE = [
  32, 50, 10, 51, 6, 44, 37, 16, 46, 11, 62, 19, 43, 25, 23, 30,
  60, 33, 53, 34, 7, 26, 12, 48, 5, 2, 20, 4, 61, 13, 47, 49,
  18, 29, 27, 22, 1, 17, 39, 56, 41, 38, 55, 31, 15, 58, 52, 40,
  8, 57, 45, 35, 59, 36, 42, 54, 63, 3, 24, 28, 14, 9, 0, 21,
];

// --- Primitives (pure, exported for the rotation canary) ---------------------

const _SAFE = new Set(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_.~'
    .split('')
    .map((c) => c.charCodeAt(0))
);

function urlEncode(s) {
  let out = '';
  for (const b of Buffer.from(s, 'utf-8')) {
    if (_SAFE.has(b)) out += String.fromCharCode(b);
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function hmacSha1B64(key, msg) {
  return crypto.createHmac('sha1', key).update(msg).digest('base64');
}

function aliyunSignature(params, secKey) {
  const keys = Object.keys(params).sort();
  const canonical = keys.map((k) => `${urlEncode(k)}=${urlEncode(params[k])}`).join('&');
  const stringToSign = `POST&${urlEncode('/')}&${urlEncode(canonical)}`;
  return hmacSha1B64(Buffer.from(secKey + '&'), Buffer.from(stringToSign));
}

function buildQueryString(params) {
  const keys = Object.keys(params).sort();
  return keys.map((k) => `${urlEncode(k)}=${urlEncode(params[k])}`).join('&');
}

// Aliyun wants ISO-8601 to the second: 2026-10-13T12:23:19Z.
// The "." before the milliseconds MUST be part of the match — stripping only
// the digits leaves "2026-10-13T12:23:19.Z", which the service rejects with
// `Timestamp is illegal!` / Code 400 (signature never even evaluated).
function utcTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function uuid() {
  return crypto.randomUUID();
}

async function httpPost(url, body, extraHeaders = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'okhttp/4.9.0',
        ...extraHeaders,
      },
      body,
      signal: controller.signal,
    });
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// --- RC4-like cipher (shared by arg generation and encrypt) -----------------

function ksaAndPrga(data, key) {
  const r = [...ARG_PERM_TABLE];
  const rlen = 64;
  const n = key;

  let i = 0,
    j = 0;
  while (i < rlen) {
    j = (((i + j + r[i] + r[j]) >> 1) + n.charCodeAt(i % n.length)) & (rlen - 1);
    if (i !== j) {
      const tmp = r[i];
      r[i] = r[j];
      r[j] = tmp;
    }
    i++;
  }

  const t = Buffer.alloc(data.length);
  let e = 0,
    a = 0;
  for (let idx = 0; idx < data.length; idx++) {
    a = ((e ^ a) + (r[e] ^ r[a])) & (rlen - 1);
    if (e !== a) {
      const tmp = r[e];
      r[e] = r[a];
      r[a] = tmp;
    }
    let m = data[idx] + e + r[e] - a - r[a];
    m ^= r[e] + r[a];
    m ^= r[(r[e] + r[a]) & (rlen - 1)];
    m &= 255;
    t[idx] = m;
    e = (e + 1) & (rlen - 1);
  }
  return t;
}

export function generateArg(certifyId) {
  const encrypted = ksaAndPrga(Buffer.from(certifyId, 'utf-8'), ARG_CONSTANT);
  return encrypted.toString('base64');
}

export function encrypt(plaintext) {
  return ksaAndPrga(Buffer.from(plaintext, 'utf-8'), ENCRYPT_KEY).toString('base64');
}

// --- ali_hash (custom 16-byte-state hash) -----------------------------------

const HEX_LOWER = '0123456789abcdef';

export function aliHash(inputStr, saltStr) {
  const o = inputStr;
  const r = saltStr;
  const aLen = o.length;
  const m = r.length;

  const e = new Array(16);
  for (let i = 0; i < 16; i++) e[i] = (i << 4) + (i % 16);
  const f = 16;

  let i = 0,
    j = 0;
  while (i < f) {
    j = (((i + j + e[i] + e[j]) >> 1) + r.charCodeAt(i % m)) & (f - 1);
    const tmp = e[i];
    e[i] = e[j];
    e[j] = tmp;
    i++;
  }

  let idx = 0,
    p = 0,
    q = 0;
  while (idx < aLen) {
    q = ((p ^ q) + (e[p] ^ e[q])) & (f - 1);
    const tmp = e[p];
    e[p] = e[q];
    e[q] = tmp;
    let c = (o.charCodeAt(idx) + p + q) ^ e[p] ^ e[q];
    c &= 255;
    e[p] = c;
    p = (p + 1) & (f - 1);
    idx++;
  }

  for (let step = 0; step < 2 * f; step++) {
    const pos = step % f;
    if (pos !== 0) e[pos] ^= e[pos - 1];
    else e[0] ^= e[f - 1];
  }

  let result = '';
  for (const b of e) result += HEX_LOWER[(b >> 4) & 0xf] + HEX_LOWER[b & 0xf];
  return result;
}

// --- Tenant-configured client ------------------------------------------------

/**
 * Build a client for one Aliyun Captcha tenant.
 *
 * @param {object} cfg
 * @param {string} cfg.accessKey      AccessKeyId used to sign the RPC calls
 * @param {string} cfg.secretKey      AccessKeySecret (HMAC-SHA1 signing key)
 * @param {string} cfg.sceneId        SceneId for the target site (public value)
 * @param {string} [cfg.region]       SDK region token, e.g. 'sgp' (defaults to endpointRegion)
 * @param {string} [cfg.endpointRegion] DNS region token, e.g. 'southeast'
 * @param {string} [cfg.prefix]       Tenant prefix, e.g. 'no8xfe'
 * @param {object} [cfg.constants]    Override cipher constants (last resort)
 * @param {number} [cfg.timeoutMs]    Per-HTTP-request timeout
 */
export function createAliyunCaptcha(cfg) {
  const {
    accessKey,
    secretKey,
    sceneId,
    prefix,
    region = 'southeast',
    endpointRegion = region,
    constants = {},
    timeoutMs = 15000,
  } = cfg || {};

  if (!accessKey) throw new Error('createAliyunCaptcha: accessKey is required');
  if (!secretKey) throw new Error('createAliyunCaptcha: secretKey is required');
  if (!sceneId) throw new Error('createAliyunCaptcha: sceneId is required');
  if (!prefix) throw new Error('createAliyunCaptcha: prefix is required');

  const argConstant = constants.argConstant || ARG_CONSTANT;
  const encryptKey = constants.encryptKey || ENCRYPT_KEY;

  const initUrl = `https://${prefix}.captcha-open-${endpointRegion}.aliyuncs.com/`;
  const verifyUrl = `https://${prefix}-verify.captcha-open-${endpointRegion}.aliyuncs.com/`;

  const arg = (certifyId) =>
    ksaAndPrga(Buffer.from(certifyId, 'utf-8'), argConstant).toString('base64');
  const enc = (plaintext) =>
    ksaAndPrga(Buffer.from(plaintext, 'utf-8'), encryptKey).toString('base64');

  async function initCaptchaRaw() {
    const params = {
      AccessKeyId: accessKey,
      Action: 'InitCaptchaV3',
      Format: 'JSON',
      Language: 'en',
      Mode: 'popup',
      SceneId: sceneId,
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: uuid(),
      SignatureVersion: '1.0',
      Timestamp: utcTimestamp(),
      UpLang: 'true',
      Version: '2023-03-05',
    };
    params.Signature = aliyunSignature(params, secretKey);
    const resp = await httpPost(initUrl, buildQueryString(params), {}, timeoutMs);
    const data = JSON.parse(resp);
    if (!data.CertifyId) {
      throw new Error(`InitCaptchaV3 failed: ${resp.slice(0, 400)}`);
    }
    return data;
  }

  async function initCaptcha() {
    return (await initCaptchaRaw()).CertifyId;
  }

  async function verifyCaptcha(certifyId, dataValue, deviceToken) {
    const cvp = JSON.stringify({ certifyId, data: dataValue, deviceToken, sceneId });

    const params = {
      AccessKeyId: accessKey,
      Action: 'VerifyCaptchaV3',
      Format: 'JSON',
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      Timestamp: utcTimestamp(),
      Version: '2023-03-05',
      SceneId: sceneId,
      CertifyId: certifyId,
      CaptchaVerifyParam: cvp,
      SignatureNonce: uuid(),
    };
    params.Signature = aliyunSignature(params, secretKey);
    const resp = await httpPost(verifyUrl, buildQueryString(params), { Referer: '' }, timeoutMs);
    let data;
    try {
      data = JSON.parse(resp);
    } catch {
      throw new Error(`VerifyCaptchaV3 non-JSON response: ${resp.slice(0, 400)}`);
    }

    if (!data.Success || !(data.Result || {}).VerifyResult) {
      const vcode = (data.Result || {}).VerifyCode || data.VerifyCode;
      const err = new Error(`VerifyCaptchaV3 rejected (code=${vcode}): ${resp.slice(0, 400)}`);
      err.verifyCode = vcode;
      err.response = data;
      throw err;
    }

    const result = data.Result || {};
    const securityToken = result.securityToken;
    const resultCertify = result.certifyId;
    if (!securityToken || !resultCertify) {
      throw new Error(`VerifyCaptchaV3 missing securityToken/certifyId: ${resp.slice(0, 400)}`);
    }
    const final = JSON.stringify({
      certifyId: resultCertify,
      isSign: true,
      sceneId,
      securityToken,
    });
    return Buffer.from(final, 'utf-8').toString('base64');
  }

  /** Full mint: Init -> arg -> track -> Verify. Returns captcha_verify_param. */
  async function computeCaptchaParam(deviceToken) {
    const certifyId = await initCaptcha();
    const argValue = arg(certifyId);
    const ct = Date.now();

    const track = JSON.stringify({
      TrackList: {
        fi: '',
        ks: '',
        mc: '',
        mp: '',
        mu: '',
        startTime: ct,
        tc: '',
        te: '',
        tmv: '',
      },
      TrackStartTime: ct,
      VerifyTime: ct + 300,
      arg: argValue,
    });

    const h = aliHash(track, '0000');
    const combined = Buffer.from(h + track, 'utf-8');
    const compressed = zlib.deflateSync(combined); // zlib format (w/ header)
    const fb64 = compressed.toString('base64');
    const finalVal = enc(fb64);

    return verifyCaptcha(certifyId, finalVal, deviceToken);
  }

  return {
    accessKey,
    secretKey,
    sceneId,
    prefix,
    region,
    endpointRegion,
    initUrl,
    verifyUrl,
    initCaptcha,
    initCaptchaRaw,
    verifyCaptcha,
    computeCaptchaParam,
  };
}
