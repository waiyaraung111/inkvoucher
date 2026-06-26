-- ============================================================
-- Pre-deployment cleanup: removes ALL voucher/print-event test
-- data created during development (the app has no delete
-- capability by design -- this is the only way to clear it).
--
-- Safe to run only because every voucher currently in the
-- database is from development/testing -- no real customer
-- transactions have happened yet. Also resets the voucher
-- number sequence so the first real voucher is #V-0001.
--
-- Run this ONCE in the Supabase SQL Editor, right before
-- deploying publicly. Do NOT run this after real vouchers exist.
-- ============================================================

-- Both tables must be truncated together in one statement -- print_events
-- has a foreign key to vouchers, and Postgres blocks truncating a
-- referenced table unless the referencing table is truncated in the same
-- statement (it checks the constraint's existence, not current row counts).
truncate table public.print_events, public.vouchers;
alter sequence public.voucher_sequence_number_seq restart with 1;

-- Optional: the voucher-images storage bucket also has test PNGs
-- in it. They're harmless (just unused storage, well within free
-- tier limits) but if you want a fully clean slate, clear them
-- manually via Dashboard -> Storage -> voucher-images -> select all -> delete.
