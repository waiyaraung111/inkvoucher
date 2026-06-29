#!/usr/bin/env node
// ============================================================
// Quick access-control test for the Dashboard (get_dashboard_summary).
//
// What it checks:
//   1. A `staff` account is REJECTED by the RPC directly over HTTP --
//      bypassing the app's UI entirely, the same way a direct API call
//      from outside the browser would. This is the actual security
//      boundary; the UI hiding the Dashboard button is just UX on top
//      of it (see openDashboard()/openDashboardBtn.hidden in app.js).
//   2. (Optional) An `owner_admin` account can still call it successfully
//      -- without this, a passing test could just mean the RPC is broken
//      for everyone, not that the permission check specifically works.
//
// This talks to the real Supabase project directly via fetch (no SDK
// dependency, no test framework) -- it exercises the live database, not a
// mock, so it needs a real `staff`-role test account to exist already
// (Supabase Dashboard -> Authentication -> add a user, then in the SQL
// Editor: update public.profiles set role = 'staff' where id = '<uuid>';
// -- 'staff' is the default, so this is usually already true).
//
// Usage:
//   STAFF_EMAIL=staff@example.com STAFF_PASSWORD=••••••• node tests/dashboard-access.js
//
// Optionally also pass OWNER_EMAIL/OWNER_PASSWORD (an owner_admin account)
// to additionally verify legitimate access still works:
//   STAFF_EMAIL=... STAFF_PASSWORD=... OWNER_EMAIL=... OWNER_PASSWORD=... \
//     node tests/dashboard-access.js
//
// Requires Node 18+ (built-in fetch). Exits non-zero if any check fails.
// ============================================================

const SUPABASE_URL = 'https://ookzskcxumxeydbnackh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9va3pza2N4dW14ZXlkYm5hY2toIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MzgyNzIsImV4cCI6MjA5ODAxNDI3Mn0.NfbxuAw5eAG9Zd6ZSyzS_f7wuvTduEj33INoA25xe28';

async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Sign-in failed for ${email}: ${data.error_description || data.msg || res.status}`);
  }
  return data.access_token;
}

// Direct REST call to the RPC -- this is what "a direct API call" actually
// means: no app.js, no supabase-js, just the same HTTP endpoint the app's
// JS hits, called with a real staff session token.
async function callDashboard(accessToken) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_dashboard_summary`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ p_date_from: '2020-01-01', p_date_to: '2030-01-01' }),
  });
  const data = await res.json();
  return { status: res.status, ok: res.ok, data };
}

async function main() {
  const staffEmail = process.env.STAFF_EMAIL;
  const staffPassword = process.env.STAFF_PASSWORD;
  if (!staffEmail || !staffPassword) {
    console.error('Set STAFF_EMAIL and STAFF_PASSWORD (a real, role=staff account) to run this test.');
    process.exit(1);
  }

  let failed = false;

  console.log(`Signing in as staff (${staffEmail})...`);
  const staffToken = await signIn(staffEmail, staffPassword);

  console.log('Calling get_dashboard_summary as staff...');
  const staffResult = await callDashboard(staffToken);

  if (staffResult.ok) {
    console.error('FAIL: staff account was able to read Dashboard data. Response:', JSON.stringify(staffResult.data));
    failed = true;
  } else if (staffResult.data && staffResult.data.code === '42501') {
    console.log('PASS: staff account correctly denied (42501 insufficient_privilege).');
  } else {
    console.error(
      `FAIL: staff call was rejected (HTTP ${staffResult.status}) but not with the expected 42501 code -- got:`,
      JSON.stringify(staffResult.data)
    );
    failed = true;
  }

  const ownerEmail = process.env.OWNER_EMAIL;
  const ownerPassword = process.env.OWNER_PASSWORD;
  if (ownerEmail && ownerPassword) {
    console.log(`Signing in as owner_admin (${ownerEmail})...`);
    const ownerToken = await signIn(ownerEmail, ownerPassword);

    console.log('Calling get_dashboard_summary as owner_admin...');
    const ownerResult = await callDashboard(ownerToken);

    if (ownerResult.ok && ownerResult.data && typeof ownerResult.data === 'object' && 'summary' in ownerResult.data) {
      console.log('PASS: owner_admin account can still read Dashboard data.');
    } else {
      console.error('FAIL: owner_admin account was unexpectedly denied/broken. Response:', JSON.stringify(ownerResult.data));
      failed = true;
    }
  } else {
    console.log('(Skipping owner_admin positive check -- set OWNER_EMAIL/OWNER_PASSWORD to also verify legitimate access still works.)');
  }

  if (failed) {
    console.error('\nRESULT: FAIL');
    process.exit(1);
  }
  console.log('\nRESULT: PASS');
}

main().catch((err) => {
  console.error('Test errored:', err.message);
  process.exit(1);
});
