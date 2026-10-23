// Type definitions for aliyun-captcha-solver.
// The package is plain ESM JavaScript; these declarations cover the root entry.

export interface InitResponse {
  CertifyId: string;
  /** Challenge Aliyun issued to this device; 'TRACELESS' means no slider. */
  CaptchaType?: string;
  [key: string]: unknown;
}

export interface AliyunCaptchaError extends Error {
  /** Aliyun VerifyCode, e.g. 'F001' (risk control) or 'F011' (frequency). */
  verifyCode?: string;
  /** Raw Verify response body, when it parsed as JSON. */
  response?: unknown;
  /** Challenge type carried over from Init. */
  captchaType?: string;
  code?: string;
  proxyFailure?: string;
}

export interface AliyunCaptchaConfig {
  accessKey: string;
  secretKey: string;
  /** Public value from the target site's JS. */
  sceneId: string;
  /** Tenant prefix, e.g. 'abc123'. */
  prefix: string;
  /** SDK region token, e.g. 'sgp'. Defaults to endpointRegion. */
  region?: string;
  /** DNS region token, e.g. 'southeast'. */
  endpointRegion?: string;
  /** Override cipher constants (last resort; they are per SDK build). */
  constants?: { argConstant?: string; encryptKey?: string };
  timeoutMs?: number;
  proxy?: ProxyRouter | null;
  /**
   * What to do when Init issues a non-traceless challenge. 'warn' (default) logs
   * and continues; 'throw' fails fast with code CHALLENGE_NOT_TRACELESS.
   */
  challengePolicy?: 'warn' | 'throw';
  log?: ((message: string) => void) | null;
}

export interface AliyunCaptchaClient {
  readonly accessKey: string;
  readonly secretKey: string;
  readonly sceneId: string;
  readonly prefix: string;
  readonly region: string;
  readonly endpointRegion: string;
  readonly initUrl: string;
  readonly verifyUrl: string;
  /** Most recent raw Init response, or null before the first call. */
  readonly lastInit: InitResponse | null;
  initCaptcha(): Promise<string>;
  initCaptchaRaw(): Promise<InitResponse>;
  verifyCaptcha(certifyId: string, dataValue: string, deviceToken: string): Promise<string>;
  /** Full mint: returns a `captcha_verify_param` value. */
  computeCaptchaParam(deviceToken: string): Promise<string>;
}

export function createAliyunCaptcha(cfg: AliyunCaptchaConfig): AliyunCaptchaClient;

export function generateArg(certifyId: string): string;
export function encrypt(plaintext: string): string;
export function aliHash(input: string, salt: string): string;

export interface PoolTiming {
  PARAM_TTL_MS?: number;
  MAX_PARAMS?: number;
  MIN_GEN_INTERVAL_MS?: number;
  F001_PAUSE_MS?: number;
  F011_PAUSE_MS?: number;
  FAIL_BACKOFF_MS?: number;
  IDLE_PAUSE_MS?: number;
  DEVICE_TOKEN_TTL_MS?: number;
  DEVICE_LOW?: number;
  REFILL_RETRY_MS?: number;
  MAX_CONSUMED?: number;
}

export interface PoolStats {
  warmParams: number;
  deviceTokens: number;
  minting: boolean;
  paused: { f001: number; f011: number; backoff: number };
  lastError: { code: string; message: string; captchaType: string | null; ageSec: number } | null;
}

export class CaptchaPool {
  constructor(opts: {
    captcha: Pick<AliyunCaptchaClient, 'computeCaptchaParam'>;
    deviceTokens?: string[];
    timing?: PoolTiming;
    verbose?: boolean;
  });

  farmNeedsRestart: boolean;
  start(): void;
  stop(): void;
  /** Collector returning device tokens; called by the background refill. */
  setCollector(fn: (() => Promise<string[]>) | null): void;
  /** True when the farm must be rebuilt (e.g. its proxy moved on). */
  setStaleCheck(fn: (() => boolean) | null): void;
  addDeviceTokens(tokens: string[]): number;
  popDeviceToken(): string | null;
  refillDeviceTokens(): Promise<string[]>;
  get(timeoutMs?: number): Promise<string | null>;
  stats(): PoolStats;
}

export interface TokenFarmOptions {
  url: string;
  prefix: string;
  region?: string;
  profile?: string | null;
  /** Defaults to CHROME_PATH, then well-known platform locations. */
  executablePath?: string | null;
  /** Defaults to a UA derived from the browser version and the host OS. */
  userAgent?: string | null;
  /** Tokens shorter than this are rejected (default 500). */
  minTokenLen?: number;
  waitSelector?: string | null;
  warmMessage?: string | null;
  inputSelector?: string | null;
  verbose?: boolean;
  headless?: boolean;
  proxy?: ProxyRouter | null;
}

export class TokenFarm {
  constructor(opts: TokenFarmOptions);
  warmed: boolean;
  start(): Promise<void>;
  harvest(count?: number): Promise<string[]>;
  isStale(): boolean;
  ensureFresh(): Promise<void>;
  reheat(): Promise<void>;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

export interface JsdomFarmOptions {
  /** Page origin for the SDK. Defaults to https://example.com. */
  url?: string;
  prefix: string;
  region?: string;
  mode?: 'live' | 'replay';
  deviceConfig?: string | null;
  assetsDir?: string | null;
  cacheDir?: string | null;
  pinFeilin?: string | null;
  auditDir?: string | null;
  proxy?: ProxyRouter | null;
  fetchImpl?: ((url: string, init?: RequestInit) => Promise<Response>) | null;
  timeoutMs?: number;
  settleMs?: number;
  minTokenLen?: number;
  warmAttempts?: number;
  warmRetryDelayMs?: number;
  verbose?: boolean;
}

export interface JsdomWarmMarks {
  domCreatedMs?: number;
  sdkLoadMs?: number;
  zUmMs?: number;
  log1Ms?: number;
  readyMs?: number;
  attempt?: number;
  [key: string]: number | undefined;
}

export interface JsdomFarmStats {
  engine: 'jsdom';
  mode: 'live' | 'replay';
  state: string;
  warmed: boolean;
  warmFailures: number;
  lastWarmError: { attempt: number; ageSec: number; message: string } | null;
  feilin: { build: string; requested: string; source: string; pinned: boolean } | null;
  assetsDir: string | null;
  minTokenLen: number;
  liveRequests: Array<{ action: string | null; ok: boolean; status: number | null; code: string | null; ms: number | null }>;
  shims: string[];
}

export class JsdomFarm {
  constructor(opts: JsdomFarmOptions);
  warmed: boolean;
  start(): Promise<JsdomWarmMarks>;
  harvest(count?: number): Promise<string[]>;
  health(): Promise<{ ok: boolean; reason?: string; probeLen?: number; ms?: number }>;
  isStale(): boolean;
  ensureFresh(): Promise<void>;
  reheat(): Promise<void>;
  restart(): Promise<void>;
  stop(): Promise<void>;
  stats(): JsdomFarmStats;
}

export interface ProxyInput {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ProxyEntry {
  index: number;
  playwrightProxy: { server: string; username?: string; password?: string };
  cooldownUntil: number;
  failures: number;
}

export interface ProxyRouterOptions {
  cooldownMs?: number;
  timeoutMs?: number;
  rotateOn?: ((res: Response, url: string) => string | null) | null;
  rotateOnTransportErrors?: boolean;
  log?: (message: string) => void;
  now?: () => number;
}

export class ProxyRouter {
  constructor(proxies: ProxyInput[], opts?: ProxyRouterOptions);
  current(): ProxyEntry;
  fail(entry: ProxyEntry, reason: string): void;
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  status(): { total: number; active: number; cooling: number; failures: number; switches: number };
  destroy(): Promise<void>;
}

export function loadProxyRouter(file: string, opts?: ProxyRouterOptions): ProxyRouter;
export function parseProxyList(text: string): ProxyInput[];
export function parseProxyLine(raw: string, lineNo?: number): ProxyInput;
export function proxyFailureReason(err: unknown): string | null;
export function transportFailureReason(err: unknown): string | null;

export function resolveChromeExecutable(explicit?: string | null): string | null;
export function chromeCandidates(platform?: string): string[];
export function chromeMajorVersion(executablePath: string | null): string | null;
export function versionFromVersionDirs(executablePath: string | null): string | null;
export function versionFromInfoPlist(executablePath: string | null): string | null;
export function platformUserAgent(major?: string | null, platform?: string): string;
