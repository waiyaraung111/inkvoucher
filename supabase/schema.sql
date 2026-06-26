-- ============================================================
-- InkVoucher — Supabase schema
-- Run this once in the Supabase Dashboard: SQL Editor > New query > paste > Run
-- ============================================================

-- ---------- Sequence (atomic, race-free voucher numbering) ----------
create sequence if not exists public.voucher_sequence_number_seq;

-- ---------- Storage bucket (private -- voucher images + company logo) ----------
insert into storage.buckets (id, name, public)
values ('voucher-images', 'voucher-images', false)
on conflict (id) do nothing;

-- ---------- profiles (staff display names; auth.users holds the actual login) ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', new.email));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- company_settings (single shared shop profile -- config, not per-voucher) ----------
create table public.company_settings (
  id int primary key default 1,
  company_name text not null,
  address text,
  phone text,
  logo_path text,
  updated_at timestamptz not null default now(),
  constraint company_settings_singleton check (id = 1)
);

-- Placeholder row -- edit these values (or update later from the app) before going live.
insert into public.company_settings (id, company_name, address, phone)
values (1, 'Your Company Name', 'Your Company Address', 'Your Phone Number')
on conflict (id) do nothing;

-- ---------- vouchers ----------
create table public.vouchers (
  id uuid primary key default gen_random_uuid(),
  sequence_number integer not null unique default nextval('public.voucher_sequence_number_seq'),
  created_by uuid not null references auth.users(id),
  customer_name text not null,
  customer_phone text,
  date date not null,
  payment_method text not null check (payment_method in ('Cash','Transfer','PayNow')),
  voucher_status text not null default 'Active' check (voucher_status in ('Active','Void')),
  payment_status text not null default 'Unpaid' check (payment_status in ('Unpaid','Paid')),
  paid_at timestamptz,
  total_amount numeric(12,2) not null default 0,
  items jsonb not null,
  drawing_data jsonb not null,      -- vector strokes per canvas: the source of truth for regenerating/redesigning the voucher
  image_path text not null,         -- rendered PNG cache (storage path, not a public URL) -- for fast thumbnails/printing only
  printed_at timestamptz,
  print_count integer not null default 0,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references auth.users(id)
);

create index vouchers_created_at_idx on public.vouchers (created_at desc);
create index vouchers_payment_status_idx on public.vouchers (payment_status);
create index vouchers_voucher_status_idx on public.vouchers (voucher_status);
create index vouchers_customer_phone_idx on public.vouchers (customer_phone);
create index vouchers_date_idx on public.vouchers (date);

-- ---------- print_events (audit trail behind print_count/printed_at) ----------
create table public.print_events (
  id uuid primary key default gen_random_uuid(),
  voucher_id uuid not null references public.vouchers(id) on delete cascade,
  printed_by uuid not null references auth.users(id),
  printed_at timestamptz not null default now()
);
create index print_events_voucher_id_idx on public.print_events (voucher_id);

-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.profiles enable row level security;
alter table public.company_settings enable row level security;
alter table public.vouchers enable row level security;
alter table public.print_events enable row level security;

create policy "Staff can view profiles" on public.profiles
  for select to authenticated using (true);
create policy "Staff can update own profile" on public.profiles
  for update to authenticated using (id = auth.uid());

create policy "Staff can view company settings" on public.company_settings
  for select to authenticated using (true);
create policy "Staff can update company settings" on public.company_settings
  for update to authenticated using (true);
create policy "Staff can insert company settings" on public.company_settings
  for insert to authenticated with check (true);

create policy "Staff can view vouchers" on public.vouchers
  for select to authenticated using (true);
-- Deliberately no insert/update/delete policy here -- every mutation goes through
-- the SECURITY DEFINER functions below, which is what actually enforces the
-- business rules (void guard, server-computed totals, atomic print logging).

create policy "Staff can view print events" on public.print_events
  for select to authenticated using (true);
-- No insert policy -- rows are only ever created via log_voucher_print().

create policy "Staff can upload voucher images" on storage.objects
  for insert to authenticated with check (bucket_id = 'voucher-images');
create policy "Staff can view voucher images" on storage.objects
  for select to authenticated using (bucket_id = 'voucher-images');

-- ============================================================
-- RPC functions
-- ============================================================

-- Reserves a voucher number before the client renders the printed PNG, so
-- the number baked into the image always matches what create_voucher will
-- actually store. (Sequences don't roll back in Postgres -- a failed save
-- still burns a number -- so the number can't be safely guessed client-side
-- in advance; it has to come from here first.)
create or replace function public.reserve_voucher_sequence_number()
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  return nextval('public.voucher_sequence_number_seq');
end;
$$;
grant execute on function public.reserve_voucher_sequence_number to authenticated;

create or replace function public.create_voucher(
  p_customer_name text,
  p_customer_phone text,
  p_date date,
  p_payment_method text,
  p_items jsonb,
  p_drawing_data jsonb,
  p_image_path text,
  p_sequence_number integer
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
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_customer_name is null or trim(p_customer_name) = '' then
    raise exception 'customer_name is required' using errcode = '23514';
  end if;

  -- Recompute every row's amount server-side -- never trust a client-sent total.
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

  -- Cash is typically settled at the counter; Transfer/PayNow often settle
  -- later. This is just the initial default -- staff can still change it.
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
    payment_status, paid_at
  ) values (
    p_sequence_number, auth.uid(), trim(p_customer_name), p_customer_phone, p_date,
    p_payment_method, v_sanitized_items, p_drawing_data, v_total, p_image_path,
    v_initial_payment_status, v_initial_paid_at
  )
  returning * into v_voucher;

  return v_voucher;
end;
$$;
grant execute on function public.create_voucher to authenticated;

create or replace function public.mark_voucher_paid(p_voucher_id uuid)
returns public.vouchers
language plpgsql security definer set search_path = public
as $$
declare v_voucher public.vouchers;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select * into v_voucher from public.vouchers where id = p_voucher_id;
  if not found then
    raise exception 'Voucher not found' using errcode = 'P0002';
  end if;
  if v_voucher.voucher_status = 'Void' then
    raise exception 'Cannot change payment status on a voided voucher' using errcode = '23514';
  end if;
  if v_voucher.payment_status = 'Paid' then
    return v_voucher; -- idempotent no-op
  end if;

  update public.vouchers set payment_status = 'Paid', paid_at = now()
  where id = p_voucher_id returning * into v_voucher;
  return v_voucher;
end;
$$;
grant execute on function public.mark_voucher_paid to authenticated;

create or replace function public.mark_voucher_unpaid(p_voucher_id uuid)
returns public.vouchers
language plpgsql security definer set search_path = public
as $$
declare v_voucher public.vouchers;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select * into v_voucher from public.vouchers where id = p_voucher_id;
  if not found then
    raise exception 'Voucher not found' using errcode = 'P0002';
  end if;
  if v_voucher.voucher_status = 'Void' then
    raise exception 'Cannot change payment status on a voided voucher' using errcode = '23514';
  end if;
  if v_voucher.payment_status = 'Unpaid' then
    return v_voucher; -- idempotent no-op
  end if;

  update public.vouchers set payment_status = 'Unpaid', paid_at = null
  where id = p_voucher_id returning * into v_voucher;
  return v_voucher;
end;
$$;
grant execute on function public.mark_voucher_unpaid to authenticated;

create or replace function public.void_voucher(p_voucher_id uuid)
returns public.vouchers
language plpgsql security definer set search_path = public
as $$
declare v_voucher public.vouchers;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select * into v_voucher from public.vouchers where id = p_voucher_id;
  if not found then
    raise exception 'Voucher not found' using errcode = 'P0002';
  end if;
  if v_voucher.voucher_status = 'Void' then
    return v_voucher; -- voiding is one-way; already-void is a no-op
  end if;

  update public.vouchers
  set voucher_status = 'Void', voided_at = now(), voided_by = auth.uid()
  where id = p_voucher_id returning * into v_voucher;
  return v_voucher;
end;
$$;
grant execute on function public.void_voucher to authenticated;

create or replace function public.log_voucher_print(p_voucher_id uuid)
returns public.vouchers
language plpgsql security definer set search_path = public
as $$
declare v_voucher public.vouchers;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select * into v_voucher from public.vouchers where id = p_voucher_id;
  if not found then
    raise exception 'Voucher not found' using errcode = 'P0002';
  end if;

  insert into public.print_events (voucher_id, printed_by) values (p_voucher_id, auth.uid());

  update public.vouchers set print_count = print_count + 1, printed_at = now()
  where id = p_voucher_id returning * into v_voucher;
  return v_voucher;
end;
$$;
grant execute on function public.log_voucher_print to authenticated;

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
  p_limit int default 25,
  p_offset int default 0
)
returns table (
  id uuid, sequence_number integer, customer_name text, customer_phone text,
  date date, payment_method text, voucher_status text, payment_status text,
  paid_at timestamptz, total_amount numeric, items jsonb, image_path text,
  printed_at timestamptz, print_count integer, created_at timestamptz,
  voided_at timestamptz, total_count bigint
)
language sql stable
set search_path = public
as $$
  select
    v.id, v.sequence_number, v.customer_name, v.customer_phone, v.date,
    v.payment_method, v.voucher_status, v.payment_status, v.paid_at,
    v.total_amount, v.items, v.image_path, v.printed_at, v.print_count,
    v.created_at, v.voided_at,
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
