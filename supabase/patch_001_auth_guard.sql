-- ============================================================
-- Patch: require an authenticated caller inside every mutating
-- RPC function. Run this once in the Supabase SQL Editor.
--
-- Why: testing against the live project found that anonymous
-- callers (anyone with the public anon key -- which is meant to
-- be embedded in frontend code) could invoke create_voucher,
-- mark_voucher_paid, mark_voucher_unpaid, void_voucher, and
-- log_voucher_print. GRANT EXECUTE alone didn't block this --
-- this project's default privileges already make functions in
-- the public schema callable by anon. create_voucher happened to
-- fail safely on a NOT NULL constraint; mark_voucher_paid did not
-- -- it ran cleanly through to "voucher not found" for a bogus id,
-- meaning a real id would have succeeded with zero authentication.
-- This patch adds an explicit auth.uid() check to the top of each
-- function so they reject unauthenticated calls outright.
-- ============================================================

create or replace function public.create_voucher(
  p_customer_name text,
  p_customer_phone text,
  p_date date,
  p_payment_method text,
  p_items jsonb,
  p_drawing_data jsonb,
  p_image_path text
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
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_customer_name is null or trim(p_customer_name) = '' then
    raise exception 'customer_name is required' using errcode = '23514';
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

  insert into public.vouchers (
    created_by, customer_name, customer_phone, date,
    payment_method, items, drawing_data, total_amount, image_path
  ) values (
    auth.uid(), trim(p_customer_name), p_customer_phone, p_date,
    p_payment_method, v_sanitized_items, p_drawing_data, v_total, p_image_path
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
    return v_voucher;
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
    return v_voucher;
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
    return v_voucher;
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
