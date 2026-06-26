-- ============================================================
-- Patch: reserve the real voucher sequence number before rendering
-- the printed PNG, instead of guessing it client-side.
--
-- Why: end-to-end testing found the printed voucher number could
-- not match the number the database actually assigned. Postgres
-- sequences don't roll back -- a failed/aborted create_voucher
-- attempt still permanently consumes a number -- so guessing
-- "next number = current count + 1" client-side can be wrong
-- (it was off by one in testing, after an earlier failed insert
-- during security testing had already burned number 1). The fix:
-- reserve the number from the database FIRST, render the PNG with
-- that confirmed number, then create the voucher using it.
--
-- This changes create_voucher's signature (adds p_sequence_number)
-- and adds a new function, reserve_voucher_sequence_number().
-- Run this once in the Supabase SQL Editor.
-- ============================================================

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

-- CREATE OR REPLACE only replaces a function whose argument list matches
-- exactly. Adding p_sequence_number below would otherwise create a second,
-- separate overload alongside the old 7-argument version instead of
-- replacing it -- drop the old signature explicitly first.
drop function if exists public.create_voucher(text, text, date, text, jsonb, jsonb, text);

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
    sequence_number, created_by, customer_name, customer_phone, date,
    payment_method, items, drawing_data, total_amount, image_path
  ) values (
    p_sequence_number, auth.uid(), trim(p_customer_name), p_customer_phone, p_date,
    p_payment_method, v_sanitized_items, p_drawing_data, v_total, p_image_path
  )
  returning * into v_voucher;

  return v_voucher;
end;
$$;
grant execute on function public.create_voucher to authenticated;
