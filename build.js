// Cloudflare Pages build step. Regenerates supabase-client.js from the
// SUPABASE_URL / SUPABASE_ANON_KEY environment variables set in the Pages
// project's dashboard, so those values live in Cloudflare's config rather
// than only as a hardcoded file in the repo.
//
// If the env vars aren't set (e.g. running locally without a build step),
// this leaves the existing supabase-client.js untouched -- local dev keeps
// working exactly as before, no build step required.
const fs = require('fs');
const path = require('path');

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.log('SUPABASE_URL/SUPABASE_ANON_KEY not set -- leaving existing supabase-client.js as-is.');
  process.exit(0);
}

const outPath = path.join(__dirname, 'supabase-client.js');
const content = `const SUPABASE_URL = '${url}';
const SUPABASE_ANON_KEY = '${anonKey}';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
`;

fs.writeFileSync(outPath, content);
console.log('Generated supabase-client.js from environment variables.');
