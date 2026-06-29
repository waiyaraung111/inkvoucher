-- ============================================================
-- Patch: Restrict the Dashboard to Owner/Admin only.
--
-- get_dashboard_summary (patch_004) was a plain `language sql` function
-- relying only on the "Staff can view vouchers" RLS policy (select to
-- authenticated using (true)) -- meaning any logged-in staff account could
-- already call it directly today and get full totals/reports, with no
-- permission check at all. This converts it to plpgsql and adds the same
-- is_owner_admin() guard the Owner Settlement/Owner Management/Staff
-- Management RPCs already use (see patch_005/patch_006), so the backend
-- rejects a staff caller outright -- not just the UI hiding the button.
--
-- Run this once in the Supabase SQL Editor. Safe to re-run (CREATE OR
-- REPLACE).
-- ============================================================

create or replace function public.get_dashboard_summary(
  p_date_from date,
  p_date_to date
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.is_owner_admin() then
    raise exception 'Only Owner/Admin can view the Dashboard' using errcode = '42501';
  end if;

  with in_range as (
    select *
    from public.vouchers
    where voucher_status = 'Active'
      and date >= p_date_from
      and date <= p_date_to
  ),
  summary as (
    select
      count(*) as total_vouchers,
      coalesce(sum(total_amount), 0) as total_amount,
      coalesce(sum(total_amount) filter (where payment_status = 'Paid'), 0) as paid_amount,
      coalesce(sum(total_amount) filter (where payment_status = 'Unpaid'), 0) as unpaid_amount,
      coalesce(avg(total_amount), 0) as average_amount
    from in_range
  ),
  by_method as (
    select
      payment_method,
      count(*) as voucher_count,
      coalesce(sum(total_amount), 0) as amount
    from in_range
    group by payment_method
  ),
  latest as (
    select id, sequence_number, customer_name, customer_phone, date, total_amount, payment_method, payment_status
    from in_range
    order by created_at desc
    limit 1
  ),
  highest as (
    select id, sequence_number, customer_name, customer_phone, date, total_amount, payment_method, payment_status
    from in_range
    order by total_amount desc, created_at desc
    limit 1
  ),
  outstanding as (
    select
      customer_name,
      customer_phone,
      count(*) as voucher_count,
      coalesce(sum(total_amount), 0) as outstanding_amount
    from public.vouchers
    where voucher_status = 'Active' and payment_status = 'Unpaid'
    group by customer_name, customer_phone
  )
  select jsonb_build_object(
    'summary', (
      select jsonb_build_object(
        'total_vouchers', total_vouchers,
        'total_amount', total_amount,
        'paid_amount', paid_amount,
        'unpaid_amount', unpaid_amount,
        'average_amount', round(average_amount, 2)
      ) from summary
    ),
    'payment_breakdown', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'payment_method', payment_method,
        'voucher_count', voucher_count,
        'amount', amount
      )), '[]'::jsonb)
      from by_method
    ),
    'latest_voucher', (select to_jsonb(latest) from latest),
    'highest_voucher', (select to_jsonb(highest) from highest),
    'outstanding_customers', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'customer_name', customer_name,
        'customer_phone', customer_phone,
        'voucher_count', voucher_count,
        'outstanding_amount', outstanding_amount
      ) order by outstanding_amount desc), '[]'::jsonb)
      from outstanding
    )
  )
  into v_result;

  return v_result;
end;
$$;
grant execute on function public.get_dashboard_summary to authenticated;
