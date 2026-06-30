// Cloudflare build step, run via `npm run build` before deploy. Does three
// independent things -- each guarded separately so one being skippable
// never disables the others:
//
// 1. Regenerates supabase-client.js from the SUPABASE_URL/SUPABASE_ANON_KEY
//    environment variables if they're set in the deploy environment,
//    otherwise leaves the committed file as-is (local dev keeps working
//    with no build step required).
//
// 2. Cache busting: injects a content-hash query string into index.html's
//    references to app.js/index.css/supabase-client.js, so a browser that
//    already cached an old version fetches the new one on its very next
//    visit -- no hard refresh needed. The hash comes from each file's own
//    contents, so it updates automatically on every build; there is no
//    version number to remember to bump by hand. This pairs with the
//    _headers file (same directory), which lets these specific URLs be
//    cached aggressively (a year, immutable) precisely because the URL
//    itself changes whenever the content does -- while index.html stays on
//    a "no-cache" (always revalidate) policy so clients actually discover
//    the new URLs promptly after a deploy.
//
// 3. Build/version indicator: stamps a human-readable timestamp + the git
//    commit this was built from into the two .build-version-badge elements
//    in index.html (login screen, sidebar header). For support: ask what
//    a user sees there to immediately tell "you're on an old cached build"
//    apart from "this is a real bug in the latest release," instead of
//    guessing. Also carries an Environment field -- see APP_ENV below.
//
//    Steps 2 and 3 always run, regardless of whether the Supabase env vars
//    above are set -- they have nothing to do with them.
//
// Environment: APP_ENV is OPTIONAL and unset today, by design -- there's
// only one real deploy target right now (this Worker). Setting it
// explicitly (e.g. `APP_ENV=Testing npm run deploy`) bakes that exact
// label into data-app-env. Left unset, it stays "auto," and app.js decides
// at runtime instead by checking the actual hostname the page loaded from
// (see detectEnvironmentFromHostname() there) -- Development for
// localhost/127.0.0.1, Testing for any hostname with "staging"/"test" in
// it, Production otherwise. Adding a future staging/testing deployment
// needs no changes to either file: name its Worker/domain with "staging"
// or "test" in it and detection just works, or set APP_ENV explicitly in
// that deploy's command/script for guaranteed precision either way.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// SUPABASE_URL / SUPABASE_ANON_KEY  →  update the PRODUCTION config
// DEMO_SUPABASE_URL / DEMO_SUPABASE_ANON_KEY  →  update the DEMO config
// Either or both may be set; the other keeps whatever is already in the file.
// If neither is set, supabase-client.js is left as-is (local dev workflow).
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const DEMO_SUPABASE_URL = process.env.DEMO_SUPABASE_URL;
const DEMO_SUPABASE_ANON_KEY = process.env.DEMO_SUPABASE_ANON_KEY;

const clientPath = path.join(__dirname, 'supabase-client.js');

if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  let clientJs = fs.readFileSync(clientPath, 'utf8');
  clientJs = clientJs.replace(
    /(SUPABASE_PRODUCTION\s*=\s*\{[^}]*?url:\s*')[^']*(')/s,
    `$1${SUPABASE_URL}$2`
  );
  clientJs = clientJs.replace(
    /(SUPABASE_PRODUCTION\s*=\s*\{[^}]*?anonKey:\s*')[^']*(')/s,
    `$1${SUPABASE_ANON_KEY}$2`
  );
  fs.writeFileSync(clientPath, clientJs);
  console.log('Updated SUPABASE_PRODUCTION config in supabase-client.js.');
}

if (DEMO_SUPABASE_URL && DEMO_SUPABASE_ANON_KEY) {
  let clientJs = fs.readFileSync(clientPath, 'utf8');
  clientJs = clientJs.replace(
    /(SUPABASE_DEMO\s*=\s*\{[^}]*?url:\s*')[^']*(')/s,
    `$1${DEMO_SUPABASE_URL}$2`
  );
  clientJs = clientJs.replace(
    /(SUPABASE_DEMO\s*=\s*\{[^}]*?anonKey:\s*')[^']*(')/s,
    `$1${DEMO_SUPABASE_ANON_KEY}$2`
  );
  fs.writeFileSync(clientPath, clientJs);
  console.log('Updated SUPABASE_DEMO config in supabase-client.js.');
}

if (!SUPABASE_URL && !DEMO_SUPABASE_URL) {
  console.log('No SUPABASE_URL / DEMO_SUPABASE_URL set -- leaving supabase-client.js as-is.');
}

const VERSIONED_ASSETS = ['app.js', 'index.css', 'supabase-client.js'];
const htmlPath = path.join(__dirname, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');

for (const asset of VERSIONED_ASSETS) {
  const fileContent = fs.readFileSync(path.join(__dirname, asset));
  const hash = crypto.createHash('sha256').update(fileContent).digest('hex').slice(0, 10);

  // Matches src="app.js" / href="index.css", optionally already carrying a
  // ?v=... from a previous build -- replacing (not appending) keeps this
  // idempotent no matter how many times it runs against the same index.html.
  const pattern = new RegExp(`((?:src|href)=["'])${asset.replace('.', '\\.')}(?:\\?v=[a-f0-9]+)?(["'])`, 'g');
  html = html.replace(pattern, `$1${asset}?v=${hash}$2`);
}

// "2026.06.29-1542" -- local time of the machine running the build (the
// deployer's own clock, since deploys here are run manually, not via CI).
function formatBuildVersion(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

// Short git commit hash, with "-dirty" appended if the working tree has
// uncommitted changes at build time -- so a support report can tell
// "this build doesn't exactly match a clean commit" instead of assuming it
// does. Falls back to a content hash (reusing the same per-file hashes
// already computed above) if git itself isn't available in the build
// environment, so this never blocks a build.
function getBuildHash() {
  try {
    const hash = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const isDirty = execSync('git status --porcelain', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
    return isDirty ? `${hash}-dirty` : hash;
  } catch (err) {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'app.js'))).digest('hex').slice(0, 7);
  }
}

const buildVersion = formatBuildVersion(new Date());
const buildHash = getBuildHash();
const APP_ENV = (process.env.APP_ENV || '').trim();

// Matches by class regardless of tag name (the login screen uses <p>, the
// sidebar uses <div>) and regardless of current text (the committed
// default "dev / local", or a previously-injected real value) -- so this
// is safe to run repeatedly, same as the cache-busting loop above. Stops
// at the nested <span class="build-env-value">, which this never touches
// directly -- only its data-app-env attribute, below.
const versionPattern = /(class="build-version-badge"[^>]*>)[^<]*(<)/g;
html = html.replace(versionPattern, `$1Version: ${buildVersion} · Build: ${buildHash} · Environment: $2`);

if (APP_ENV) {
  const envPattern = /(class="build-env-value" data-app-env=")[^"]*(")/g;
  html = html.replace(envPattern, `$1${APP_ENV}$2`);
}

fs.writeFileSync(htmlPath, html);
console.log('Cache-busted index.html ->', VERSIONED_ASSETS.map((a) => `${a}?v=<hash>`).join(', '));
console.log(`Build version stamped: ${buildVersion} · Build: ${buildHash} · Environment: ${APP_ENV || 'auto (detected at runtime from hostname)'}`);
