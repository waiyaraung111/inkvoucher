// Production Supabase project.
const SUPABASE_PRODUCTION = {
  url: 'https://ookzskcxumxeydbnackh.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9va3pza2N4dW14ZXlkYm5hY2toIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MzgyNzIsImV4cCI6MjA5ODAxNDI3Mn0.NfbxuAw5eAG9Zd6ZSyzS_f7wuvTduEj33INoA25xe28',
};

// Demo Supabase project — completely separate, isolated from production.
// Fill in url and anonKey after creating the project at supabase.com.
// See supabase/schema.sql + supabase/demo_seed.sql to set it up.
const SUPABASE_DEMO = {
  url: 'REPLACE_WITH_DEMO_SUPABASE_URL',
  anonKey: 'REPLACE_WITH_DEMO_SUPABASE_ANON_KEY',
};

// Pick the right project based on the hostname the page loaded from.
// Any hostname containing "-demo" (e.g. inkvoucher-demo.workers.dev) uses
// the demo project. Everything else (production, localhost) uses production.
function pickSupabaseConfig() {
  const host = window.location.hostname;
  if (/(?:^|[.-])demo(?:[.-]|$)/i.test(host)) return SUPABASE_DEMO;
  return SUPABASE_PRODUCTION;
}

const { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY } = pickSupabaseConfig();
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
