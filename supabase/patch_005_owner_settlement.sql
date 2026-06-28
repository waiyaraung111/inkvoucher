-- ============================================================
-- Patch: Internal Owner Settlement -- completely separate from
-- Customer Payment Status (payment_status/paid_at, untouched by
-- this patch). Adds:
--   - profiles.role ('staff' | 'owner_admin')
--   - owners table (Owner Management: add/edit/disable, never delete)
--   - vouchers.settlement_status / settlement_received_by /
--     settlement_at / settlement_recorded_by
--   - settlement_audit_log (one row per settlement change)
--   - RPCs enforcing "only Owner/Admin can update Owner Settlement"
--     on the backend, not just hidden in the UI
--   - search_vouchers gains settlement/owner/staff filters
--
-- Run this once in the Supabase SQL Editor. Safe to re-run (uses
-- IF NOT EXISTS / CREATE OR REPLACE throughout).
-- ============================================================

-- ---------- profiles.role ----------
alter table public.profiles
  add column if not exists role text not null default 'staff' check (role in ('staff', 'owner_admin'));

-- SECURITY FIX: "Staff can update own profile" (schema.sql) has no column
-- restriction -- as written, any authenticated user could currently run
-- `.from('profiles').update({ role: 'owner_admin' }).eq('id', auth.uid())`
-- from the browser and grant themselves Owner/Admin, bypassing every
-- permission check this patch adds below. RLS policies restrict which ROWS
-- a user can touch, not which COLUMNS -- closing this requires a
-- column-level privilege grant instead. After this, staff can still update
-- their own display name, but role changes are only possible through
-- set_owner_active-style SECURITY DEFINER functions (none are exposed for
-- self-promotion -- role is intentionally only settable by editing the
-- profiles row directly in the Supabase Dashboard).
revoke update on public.profiles from authenticated;
grant update (name) on public.profiles to authenticated;

-- ---------- owners (Owner Management: distinct from app user accounts --
-- these are the people credited with receiving a settlement, not logins) ----------
create table if not exists public.owners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.owners enable row level security;

drop policy if exists "Staff can view owners" on public.owners;
create policy "Staff can view owners" on public.owners
  for select to authenticated using (true);
-- Deliberately no insert/update/delete policy -- mutations only via
-- add_owner/update_owner/set_owner_active below, which enforce Owner/Admin.

-- ---------- vouchers: Owner Settlement columns ----------
alter table public.vouchers
  add column if not exists settlement_status text not null default 'Not Received' check (settlement_status in ('Not Received', 'Received')),
  add column if not exists settlement_received_by uuid references public.owners(id),
  add column if not exists settlement_at timestamptz,
  add column if not exists settlement_recorded_by uuid references auth.users(id);

create index if not exists vouchers_settlement_status_idx on public.vouchers (settlement_status);
create index if not exists vouchers_settlement_received_by_idx on public.vouchers (settlement_received_by);

-- ---------- settlement_audit_log (every settlement action, append-only) ----------
create table if not exists public.settlement_audit_log (
  id uuid primary key default gen_random_uuid(),
  voucher_id uuid not null references public.vouchers(id) on delete cascade,
  action text not null check (action in ('Received', 'Not Received')),
  owner_id uuid references public.owners(id),
  performed_by uuid not null references auth.users(id),
  performed_at timestamptz not null default now()
);
create index if not exists settlement_audit_log_voucher_id_idx on public.settlement_audit_log (voucher_id);

alter table public.settlement_audit_log enable row level security;

drop policy if exists "Staff can view settlement audit log" on public.settlement_audit_log;
create policy "Staff can view settlement audit log" on public.settlement_audit_log
  for select to authenticated using (true);
-- No insert policy -- rows are only ever created via the settlement RPCs below.

-- ============================================================
-- Permission helper
-- ============================================================
create or replace function public.is_owner_admin()
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'owner_admin'
  );
$$;
grant execute on function public.is_owner_admin to authenticated;

-- ============================================================
-- Owner Management RPCs (Owner/Admin only -- never a hard delete)
-- ============================================================
create or replace function public.add_owner(p_name text)
returns public.owners
language plpgsql
security definer
set search_path = public
as $$
declare v_owner public.owners;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.is_owner_admin() then
    raise exception 'Only Owner/Admin can manage owners' using errcode = '42501';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception 'name is required';
  end if;

  insert into public.owners (name, created_by)
  values (trim(p_name), auth.uid())
  returning * into v_owner;

  return v_owner;
end;
$$;
grant execute on function public.add_owner to authenticated;

create or replace function public.update_owner(p_owner_id uuid, p_name text)
returns public.owners
language plpgsql
security definer
set search_path = public
as $$
declare v_owner public.owners;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.is_owner_admin() then
    raise exception 'Only Owner/Admin can manage owners' using errcode = '42501';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception 'name is required';
  end if;

  update public.owners set name = trim(p_name)
  where id = p_owner_id
  returning * into v_owner;

  if not found then
    raise exception 'Owner not found' using errcode = 'P0002';
  end if;

  return v_owner;
end;
$$;
grant execute on function public.update_owner to authenticated;

-- Disable/re-enable -- owners are never permanently deleted, since past
-- vouchers' settlement_received_by references them historically.
create or replace function public.set_owner_active(p_owner_id uuid, p_active boolean)
returns public.owners
language plpgsql
security definer
set search_path = public
as $$
declare v_owner public.owners;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.is_owner_admin() then
    raise exception 'Only Owner/Admin can manage owners' using errcode = '42501';
  end if;

  update public.owners set active = p_active
  where id = p_owner_id
  returning * into v_owner;

  if not found then
    raise exception 'Owner not found' using errcode = 'P0002';
  end if;

  return v_owner;
end;
$$;
grant execute on function public.set_owner_active to authenticated;

-- ============================================================
-- Owner Settlement RPCs (Owner/Admin only)
-- ============================================================
create or replace function public.mark_voucher_settlement_received(p_voucher_id uuid, p_owner_id uuid)
returns public.vouchers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_voucher public.vouchers;
  v_owner public.owners;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.is_owner_admin() then
    raise exception 'Only Owner/Admin can update Owner Settlement' using errcode = '42501';
  end if;

  select * into v_voucher from public.vouchers where id = p_voucher_id;
  if not found then
    raise exception 'Voucher not found' using errcode = 'P0002';
  end if;
  if v_voucher.voucher_status = 'Void' then
    raise exception 'Cannot change settlement status on a voided voucher' using errcode = '23514';
  end if;

  select * into v_owner from public.owners where id = p_owner_id;
  if not found then
    raise exception 'Owner not found' using errcode = 'P0002';
  end if;
  if not v_owner.active then
    raise exception 'Owner is disabled';
  end if;

  update public.vouchers
  set settlement_status = 'Received',
      settlement_received_by = p_owner_id,
      settlement_at = now(),
      settlement_recorded_by = auth.uid()
  where id = p_voucher_id
  returning * into v_voucher;

  insert into public.settlement_audit_log (voucher_id, action, owner_id, performed_by)
  values (p_voucher_id, 'Received', p_owner_id, auth.uid());

  return v_voucher;
end;
$$;
grant execute on function public.mark_voucher_settlement_received to authenticated;

create or replace function public.mark_voucher_settlement_not_received(p_voucher_id uuid)
returns public.vouchers
language plpgsql
security definer
set search_path = public
as $$
declare v_voucher public.vouchers;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.is_owner_admin() then
    raise exception 'Only Owner/Admin can update Owner Settlement' using errcode = '42501';
  end if;

  select * into v_voucher from public.vouchers where id = p_voucher_id;
  if not found then
    raise exception 'Voucher not found' using errcode = 'P0002';
  end if;
  if v_voucher.voucher_status = 'Void' then
    raise exception 'Cannot change settlement status on a voided voucher' using errcode = '23514';
  end if;
  if v_voucher.settlement_status = 'Not Received' then
    return v_voucher; -- idempotent no-op
  end if;

  update public.vouchers
  set settlement_status = 'Not Received',
      settlement_received_by = null,
      settlement_at = null,
      settlement_recorded_by = auth.uid()
  where id = p_voucher_id
  returning * into v_voucher;

  insert into public.settlement_audit_log (voucher_id, action, owner_id, performed_by)
  values (p_voucher_id, 'Not Received', null, auth.uid());

  return v_voucher;
end;
$$;
grant execute on function public.mark_voucher_settlement_not_received to authenticated;

-- ============================================================
-- search_vouchers: add Owner Settlement Status / Received By Owner /
-- Staff filters, and return the underlying columns the Ledger needs.
-- Same signature-replace problem as patch_002 -- CREATE OR REPLACE only
-- replaces a function whose argument list matches exactly, so the old
-- 11-argument overload has to be dropped explicitly first.
-- ============================================================
drop function if exists public.search_vouchers(text, text, text, text, text, text, date, date, date, int, int);

create or replace function public.search_vouchers(
  p_q text default null,
  p_voucher_status text default null,
  p_payment_status text default null,
  p_payment_method text default null,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_date date default null,
  p_date_from date default null,
  p_date_to date default null,
  p_settlement_status text default null,
  p_received_by_owner uuid default null,
  p_created_by uuid default null,
  p_limit int default 25,
  p_offset int default 0
)
returns table (
  id uuid, sequence_number integer, customer_name text, customer_phone text,
  date date, payment_method text, voucher_status text, payment_status text,
  paid_at timestamptz, total_amount numeric, items jsonb, image_path text,
  printed_at timestamptz, print_count integer, created_at timestamptz,
  voided_at timestamptz, created_by uuid,
  settlement_status text, settlement_received_by uuid,
  settlement_at timestamptz, settlement_recorded_by uuid,
  total_count bigint
)
language sql stable
set search_path = public
as $$
  select
    v.id, v.sequence_number, v.customer_name, v.customer_phone, v.date,
    v.payment_method, v.voucher_status, v.payment_status, v.paid_at,
    v.total_amount, v.items, v.image_path, v.printed_at, v.print_count,
    v.created_at, v.voided_at, v.created_by,
    v.settlement_status, v.settlement_received_by,
    v.settlement_at, v.settlement_recorded_by,
    count(*) over() as total_count
  from public.vouchers v
  where (p_voucher_status is null or v.voucher_status = p_voucher_status)
    and (p_payment_status is null or v.payment_status = p_payment_status)
    and (p_payment_method is null or v.payment_method = p_payment_method)
    and (p_customer_name is null or v.customer_name ilike '%' || p_customer_name || '%')
    and (p_customer_phone is null or v.customer_phone ilike '%' || p_customer_phone || '%')
    and (p_date is null or v.date = p_date)
    and (p_date_from is null or v.date >= p_date_from)
    and (p_date_to is null or v.date <= p_date_to)
    and (p_settlement_status is null or v.settlement_status = p_settlement_status)
    and (p_received_by_owner is null or v.settlement_received_by = p_received_by_owner)
    and (p_created_by is null or v.created_by = p_created_by)
    and (
      p_q is null
      or v.sequence_number::text = regexp_replace(p_q, '\D', '', 'g')
      or v.customer_name ilike '%' || p_q || '%'
      or v.customer_phone ilike '%' || p_q || '%'
    )
  order by v.created_at desc
  limit p_limit offset p_offset;
$$;
grant execute on function public.search_vouchers to authenticated;

-- ============================================================
-- After running this: promote at least one user to Owner/Admin manually,
-- e.g. in the Supabase Dashboard's Table Editor (profiles table) or via
-- SQL Editor:
--   update public.profiles set role = 'owner_admin' where id = '<auth.users.id>';
-- There is no in-app way to do this by design -- role is not self-service.
-- ============================================================
