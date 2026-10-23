// index.mjs — public entrypoint.
//
//   import { createAliyunCaptcha, CaptchaPool, TokenFarm, JsdomFarm } from 'aliyun-captcha-solver';

export { createAliyunCaptcha, generateArg, encrypt, aliHash } from './aliyun-captcha.mjs';
export { CaptchaPool } from './captcha-pool.mjs';
export { TokenFarm } from './token-farm.mjs';
export { JsdomFarm } from './jsdom-farm.mjs';
export { resolveChromeExecutable, chromeCandidates, chromeMajorVersion, platformUserAgent } from './chrome.mjs';
export { ProxyRouter, loadProxyRouter, parseProxyList, parseProxyLine, proxyFailureReason, transportFailureReason } from './proxy.mjs';
