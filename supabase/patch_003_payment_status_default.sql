-- ============================================================
-- Patch: Cash vouchers default to Paid; Transfer/PayNow default
-- to Unpaid. Staff can still change either manually afterward --
-- this only sets the initial value at creation time.
--
-- Same signature as the version from patch_002, so this is a
-- straight CREATE OR REPLACE -- no DROP needed.
-- Run this once in the Supabase SQL Editor.
-- ============================================================

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
