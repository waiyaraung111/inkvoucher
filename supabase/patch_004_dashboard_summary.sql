-- ============================================================
-- Patch: Dashboard view -- one aggregation RPC backing all of it.
--
-- Adds get_dashboard_summary(date_from, date_to), returning a single
-- jsonb object: summary totals, payment-method breakdown, latest/highest
-- voucher, and an outstanding-customers list. All read-only aggregation
-- over the existing vouchers table -- no new tables, no changes to
-- create_voucher or any other existing function.
--
-- summary/payment_breakdown/latest_voucher/highest_voucher are scoped to
-- Active vouchers dated within [date_from, date_to]. outstanding_customers
-- is deliberately NOT date-scoped -- a customer who still owes money from
-- last month is still outstanding today, regardless of which range the
-- staff has selected on the Dashboard.
--
-- Read-only, so (like search_vouchers) this relies on the existing
-- "Staff can view vouchers" RLS policy rather than a manual auth.uid()
-- check -- no security definer needed.
-- Run this once in the Supabase SQL Editor.
-- ============================================================

create or replace function public.get_dashboard_summary(
  p_date_from date,
  p_date_to date
)
returns jsonb
language sql stable
set search_path = public
as $$
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
  );
$$;
grant execute on function public.get_dashboard_summary to authenticated;
