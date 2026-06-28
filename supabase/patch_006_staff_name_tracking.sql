-- ============================================================
-- Patch: Internal Staff Name Tracking.
--
-- Several staff may share one login account, so the login (auth.users/
-- profiles, via vouchers.created_by) doesn't tell you who actually made a
-- voucher. This adds a separate staff_members roster (Staff Management:
-- add/edit/disable, never delete) and records which one made each voucher,
-- independent of who was logged in.
--
-- Run this once in the Supabase SQL Editor. Safe to re-run (uses
-- IF NOT EXISTS / CREATE OR REPLACE throughout).
-- ============================================================

-- ---------- staff_members (the actual person who made a voucher --
-- distinct from auth.users/profiles, which is the shared login) ----------
create table if not exists public.staff_members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.staff_members enable row level security;

drop policy if exists "Staff can view staff members" on public.staff_members;
create policy "Staff can view staff members" on public.staff_members
  for select to authenticated using (true);
-- Deliberately no insert/update/delete policy -- mutations only via
-- add_staff_member/update_staff_member/set_staff_member_active below,
-- which enforce Owner/Admin (reuses is_owner_admin() from patch_005).

-- ---------- vouchers: who actually made it ----------
-- made_by_staff_name is a snapshot taken at creation time (not a live join)
-- -- so renaming a staff_members row later never rewrites history on
-- already-saved vouchers, the same reasoning as customer_name being stored
-- directly rather than looked up. Nullable: existing vouchers predate this
-- feature and have no staff to attribute; "required" is enforced by
-- create_voucher below for every NEW voucher, not by a NOT NULL constraint
-- that would break on historical rows.
alter table public.vouchers
  add column if not exists made_by_staff_id uuid references public.staff_members(id),
  add column if not exists made_by_staff_name text;

create index if not exists vouchers_made_by_staff_id_idx on public.vouchers (made_by_staff_id);

-- ============================================================
-- Staff Management RPCs (Owner/Admin only -- never a hard delete)
-- ============================================================
create or replace function public.add_staff_member(p_name text)
returns public.staff_members
language plpgsql
security definer
set search_path = public
as $$
declare v_staff public.staff_members;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.is_owner_admin() then
    raise exception 'Only Owner/Admin can manage staff names' using errcode = '42501';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception 'name is required';
  end if;

  insert into public.staff_members (name, created_by)
  values (trim(p_name), auth.uid())
  returning * into v_staff;

  return v_staff;
end;
$$;
grant execute on function public.add_staff_member to authenticated;

create or replace function public.update_staff_member(p_staff_id uuid, p_name text)
returns public.staff_members
language plpgsql
security definer
set search_path = public
as $$
declare v_staff public.staff_members;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.is_owner_admin() then
    raise exception 'Only Owner/Admin can manage staff names' using errcode = '42501';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception 'name is required';
  end if;

  update public.staff_members set name = trim(p_name)
  where id = p_staff_id
  returning * into v_staff;

  if not found then
    raise exception 'Staff member not found' using errcode = 'P0002';
  end if;

  return v_staff;
end;
$$;
grant execute on function public.update_staff_member to authenticated;

-- Disable/re-enable -- staff names are never permanently deleted, since
-- past vouchers' made_by_staff_id references them historically.
create or replace function public.set_staff_member_active(p_staff_id uuid, p_active boolean)
returns public.staff_members
language plpgsql
security definer
set search_path = public
as $$
declare v_staff public.staff_members;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.is_owner_admin() then
    raise exception 'Only Owner/Admin can manage staff names' using errcode = '42501';
  end if;

  update public.staff_members set active = p_active
  where id = p_staff_id
  returning * into v_staff;

  if not found then
    raise exception 'Staff member not found' using errcode = 'P0002';
  end if;

  return v_staff;
end;
$$;
grant execute on function public.set_staff_member_active to authenticated;

-- ============================================================
-- create_voucher: Made By / Staff Name is now a required field. Same
-- signature-replace problem as previous patches -- the old 8-argument
-- overload must be dropped explicitly before CREATE OR REPLACE can install
-- the 9-argument version in its place.
-- ============================================================
drop function if exists public.create_voucher(text, text, date, text, jsonb, jsonb, text, integer);

create or replace function public.create_voucher(
  p_customer_name text,
  p_customer_phone text,
  p_date date,
  p_payment_method text,
  p_items jsonb,
  p_drawing_data jsonb,
  p_image_path text,
  p_sequence_number integer,
  p_made_by_staff_id uuid default null
)
returns public.vouchers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_sanitized_items jsonb := '[]'::jsonb;
  v_total numeric(12,2) := 0;
  v_qty numeric;
  v_price numeric;
  v_amount numeric;
  v_voucher public.vouchers;
  v_initial_payment_status text;
  v_initial_paid_at timestamptz;
  v_staff public.staff_members;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_customer_name is null or trim(p_customer_name) = '' then
    raise exception 'customer_name is required' using errcode = '23514';
  end if;

  if p_made_by_staff_id is null then
    raise exception 'Made By staff name is required';
  end if;
  select * into v_staff from public.staff_members where id = p_made_by_staff_id;
  if not found then
    raise exception 'Staff member not found' using errcode = 'P0002';
  end if;
  if not v_staff.active then
    raise exception 'Staff member is disabled';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := coalesce((v_item->>'qty')::numeric, 0);
    v_price := coalesce((v_item->>'price')::numeric, 0);
    v_amount := round(v_qty * v_price, 2);
    v_total := v_total + v_amount;
    v_sanitized_items := v_sanitized_items || jsonb_build_object(
      'rowIndex', (v_item->>'rowIndex')::int,
      'qty', v_qty, 'price', v_price, 'amount', v_amount
    );
  end loop;

  if p_payment_method = 'Cash' then
    v_initial_payment_status := 'Paid';
    v_initial_paid_at := now();
  else
    v_initial_payment_status := 'Unpaid';
    v_initial_paid_at := null;
  end if;

  insert into public.vouchers (
    sequence_number, created_by, customer_name, customer_phone, date,
    payment_method, items, drawing_data, total_amount, image_path,
    payment_status, paid_at, made_by_staff_id, made_by_staff_name
  ) values (
    p_sequence_number, auth.uid(), trim(p_customer_name), p_customer_phone, p_date,
    p_payment_method, v_sanitized_items, p_drawing_data, v_total, p_image_path,
    v_initial_payment_status, v_initial_paid_at, p_made_by_staff_id, v_staff.name
  )
  returning * into v_voucher;

  return v_voucher;
end;
$$;
grant execute on function public.create_voucher to authenticated;

-- ============================================================
-- search_vouchers: add a Staff Name filter (made_by_staff_id -- the actual
-- person, not the login) and return the columns the Ledger/detail view need.
-- ============================================================
drop function if exists public.search_vouchers(text, text, text, text, text, text, date, date, date, text, uuid, uuid, int, int);

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
  p_made_by_staff_id uuid default null,
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
  made_by_staff_id uuid, made_by_staff_name text,
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
    v.made_by_staff_id, v.made_by_staff_name,
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
    and (p_made_by_staff_id is null or v.made_by_staff_id = p_made_by_staff_id)
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
