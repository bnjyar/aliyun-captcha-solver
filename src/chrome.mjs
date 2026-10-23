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
  '/opt/google/chrome/chrome',
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

/** Parse the highest version-named sibling directory (Windows Chrome layout). */
export function versionFromVersionDirs(executablePath) {
  if (!executablePath) return null;
  try {
    const dir = path.dirname(executablePath);
    let best = null;
    for (const name of fs.readdirSync(dir)) {
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(name)) continue;
      if (!fs.statSync(path.join(dir, name)).isDirectory()) continue;
      const parts = name.split('.').map(Number);
      if (!best) {
        best = parts;
        continue;
      }
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === best[i]) continue;
        if (parts[i] > best[i]) best = parts;
        break;
      }
    }
    return best ? String(best[0]) : null;
  } catch {
    return null;
  }
}

/** Read CFBundleShortVersionString from Chrome.app/Contents/Info.plist (macOS layout). */
export function versionFromInfoPlist(executablePath) {
  if (!executablePath) return null;
  try {
    // <...>/Google Chrome.app/Contents/MacOS/Google Chrome -> <...>/Contents/Info.plist
    const plist = path.join(path.dirname(executablePath), '..', 'Info.plist');
    const text = fs.readFileSync(plist, 'utf8');
    const m = text.match(/<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)\./);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Major version of the browser. `--version` works on Linux and macOS, but not
 * reliably on Windows (chrome.exe is a GUI binary with no console), so fall back
 * to the version-named directory next to the executable, then to Info.plist.
 */
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
    if (m) return m[1];
  } catch {
    // GUI binaries on Windows, or an unreadable path: try the layout instead.
  }
  return versionFromVersionDirs(executablePath) || versionFromInfoPlist(executablePath) || null;
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
