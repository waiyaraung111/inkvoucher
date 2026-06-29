-- ============================================================
-- Patch: Per-item Handwriting/Typing name mode.
--
-- Each voucher item row can now be either handwritten (the existing
-- canvas/stroke system, unchanged) or typed (a plain text item name).
-- This is a body-only change to create_voucher -- its signature doesn't
-- change, p_items already carries arbitrary per-item JSON, so this just
-- teaches the existing sanitization loop to also pick up and store
-- nameMode/typedName alongside qty/price/amount.
--
-- No new column, no new table: nameMode/typedName live inside the existing
-- vouchers.items jsonb array, right next to the fields already there.
-- drawing_data (the handwriting stroke structure) is completely untouched
-- by this patch -- a row keeps whatever strokes it has regardless of mode,
-- per the "never delete data on mode switch" rule enforced client-side.
--
-- Run this once in the Supabase SQL Editor. Safe to re-run (CREATE OR
-- REPLACE, same signature).
-- ============================================================

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
  v_name_mode text;
  v_typed_name text;
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

  -- Recompute every row's amount server-side -- never trust a client-sent
  -- total. nameMode/typedName are sanitized the same defensive way: an
  -- unrecognized or missing mode always falls back to 'handwriting', and a
  -- handwriting row's typedName is forced to null regardless of what the
  -- client sent, so a row's stored shape always matches its actual mode.
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := coalesce((v_item->>'qty')::numeric, 0);
    v_price := coalesce((v_item->>'price')::numeric, 0);
    v_amount := round(v_qty * v_price, 2);
    v_total := v_total + v_amount;

    v_name_mode := case when v_item->>'nameMode' = 'typing' then 'typing' else 'handwriting' end;
    v_typed_name := case when v_name_mode = 'typing' then trim(coalesce(v_item->>'typedName', '')) else null end;

    v_sanitized_items := v_sanitized_items || jsonb_build_object(
      'rowIndex', (v_item->>'rowIndex')::int,
      'qty', v_qty, 'price', v_price, 'amount', v_amount,
      'nameMode', v_name_mode, 'typedName', v_typed_name
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
