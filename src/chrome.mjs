// chrome.mjs — locate a Chrome/Chromium binary and describe the host platform.
//
// TokenFarm used to hardcode /usr/bin/google-chrome-stable, which breaks the
// moment the project runs on macOS or Windows. Resolution order:
//
//   1. opts.executablePath (caller)
//   2. CHROME_PATH (env)
//   3. per-platform well-known locations
//   4. null — let Playwright try its own resolution
//
// The user agent is derived from the browser's real major version (and the
// host OS), so the UA never contradicts the fingerprint the browser reports.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

const DARWIN_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

function windowsCandidates(env = process.env) {
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  // Explicit platform probing (or a bare CI host) may have no Windows env vars.
  if (!roots.length) roots.push('C:\\Program Files', 'C:\\Program Files (x86)');
  const rel = [
    'Google/Chrome/Application/chrome.exe',
    'Google/Chrome Beta/Application/chrome.exe',
    'Chromium/Application/chrome.exe',
    'Microsoft/Edge/Application/msedge.exe',
  ];
  return roots.flatMap((root) => rel.map((r) => path.win32.join(root, ...r.split('/'))));
}

/** Well-known browser locations for a platform (defaults to the host). */
export function chromeCandidates(platform = process.platform) {
  if (platform === 'darwin') return DARWIN_CANDIDATES;
  if (platform === 'win32') return windowsCandidates();
  return LINUX_CANDIDATES;
}

/**
 * Resolve a Chrome/Chromium executable. An explicit value is returned as-is
 * (even if it does not exist) so Playwright can report the real launch error.
 * Returns null when nothing was found; the caller then lets Playwright decide.
 */
export function resolveChromeExecutable(explicit = null) {
  if (explicit) return explicit;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const candidate of chromeCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // unreadable path: keep looking
    }
  }
  return null;
}

/** Major version reported by `<chrome> --version`, or null. */
export function chromeMajorVersion(executablePath) {
  if (process.env.CHROME_MAJOR_VERSION) return process.env.CHROME_MAJOR_VERSION;
  if (!executablePath) return null;
  try {
    const out = execFileSync(executablePath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = String(out).match(/(\d+)\.\d+\.\d+/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * A Chrome user agent for the host platform. `major` should come from
 * chromeMajorVersion(); the fallback is deliberately conservative so a failed
 * version probe never produces an obviously ancient browser.
 */
export function platformUserAgent(major = null, platform = process.platform) {
  const version = major || '130';
  const os =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;
}
