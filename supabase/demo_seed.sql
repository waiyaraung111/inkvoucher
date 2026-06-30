-- ============================================================
-- InkVoucher -- Demo Database Seed
--
-- Populates the demo Supabase project with realistic fake data
-- for workshop/assessor access. No real customer names, prices,
-- or voucher data from the production shop are included.
--
-- RUN ORDER:
--   1. Run schema.sql first (creates all tables + functions)
--   2. Create the demo login account via Supabase Auth dashboard:
--        Authentication > Users > Add user
--        Email:    demo@inkvoucher.app
--        Password: Demo2024!
--        (tick "Auto Confirm User" so it's immediately usable)
--   3. Run THIS file in the SQL Editor
--
-- The script self-checks for the demo user and raises a clear
-- error if step 2 was skipped -- safe to re-run after creating
-- the user.
-- ============================================================

do $$
declare
  v_uid          uuid;
  v_owner1_id    uuid;
  v_owner2_id    uuid;
  v_staff1_id    uuid;
  v_staff2_id    uuid;
  v_staff3_id    uuid;
begin

  -- ---- 0. Locate the demo user (must already exist in auth.users) ----
  select id into v_uid
  from auth.users
  where email = 'demo@inkvoucher.app';

  if v_uid is null then
    raise exception
      'Demo user not found. '
      'Create demo@inkvoucher.app (password: Demo2024!) in Supabase > '
      'Authentication > Users > Add user, then re-run this script.';
  end if;

  -- ---- 1. Promote demo user to Owner/Admin ----
  -- The handle_new_user() trigger already created the profile row with
  -- role=''staff''. We just rename and promote it.
  update public.profiles
  set name = 'Demo User',
      role = 'owner_admin'
  where id = v_uid;

  -- ---- 2. Demo shop letterhead (company_settings) ----
  update public.company_settings
  set company_name = 'InkVoucher Demo Shop',
      address      = 'No. 12, Merchant Street, Yangon',
      phone        = '09-777-888-999',
      updated_at   = now()
  where id = 1;

  -- ---- 3. Owners ----
  -- Insert only if not already seeded (safe to re-run).
  if not exists (select 1 from public.owners where name = 'Ko Kyaw Zin') then
    insert into public.owners (name, active, created_by)
    values ('Ko Kyaw Zin', true, v_uid)
    returning id into v_owner1_id;
  else
    select id into v_owner1_id from public.owners where name = 'Ko Kyaw Zin';
  end if;

  if not exists (select 1 from public.owners where name = 'Ma Aye Aye') then
    insert into public.owners (name, active, created_by)
    values ('Ma Aye Aye', true, v_uid)
    returning id into v_owner2_id;
  else
    select id into v_owner2_id from public.owners where name = 'Ma Aye Aye';
  end if;

  -- ---- 4. Staff members ----
  if not exists (select 1 from public.staff_members where name = 'Min Thu') then
    insert into public.staff_members (name, active, created_by)
    values ('Min Thu', true, v_uid)
    returning id into v_staff1_id;
  else
    select id into v_staff1_id from public.staff_members where name = 'Min Thu';
  end if;

  if not exists (select 1 from public.staff_members where name = 'Su Su Khin') then
    insert into public.staff_members (name, active, created_by)
    values ('Su Su Khin', true, v_uid)
    returning id into v_staff2_id;
  else
    select id into v_staff2_id from public.staff_members where name = 'Su Su Khin';
  end if;

  if not exists (select 1 from public.staff_members where name = 'Zaw Myo') then
    -- Zaw Myo is inactive (left the shop) -- demonstrates disabled staff
    insert into public.staff_members (name, active, created_by)
    values ('Zaw Myo', false, v_uid)
    returning id into v_staff3_id;
  else
    select id into v_staff3_id from public.staff_members where name = 'Zaw Myo';
  end if;

  -- ---- 5. Vouchers ----
  -- Skip if already seeded.
  if exists (select 1 from public.vouchers where sequence_number = 1) then
    raise notice 'Vouchers already seeded -- skipping voucher insert.';
  else

    -- V-0001  Cash · Paid · Settlement → Ko Kyaw Zin
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, paid_at, voucher_status,
      items, drawing_data, total_amount, image_path,
      settlement_status, settlement_received_by, settlement_at, settlement_recorded_by,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      1, v_uid, 'Khin Myo Oo', '09-111-222-333', '2026-05-15',
      'Cash', 'Paid', '2026-05-15 09:30:00+06:30', 'Active',
      '[{"rowIndex":0,"qty":2,"price":12000,"amount":24000,"nameMode":"typing","typedName":"HP 678 Black Ink Cartridge"},
        {"rowIndex":1,"qty":1,"price":4500,"amount":4500,"nameMode":"typing","typedName":"A4 Paper (500 sheets)"}]'::jsonb,
      '{}'::jsonb, 28500, 'demo/seed-placeholder.png',
      'Received', v_owner1_id, '2026-05-16 10:00:00+06:30', v_uid,
      v_staff1_id, 'Min Thu', '2026-05-15 09:30:00+06:30'
    );

    -- V-0002  Transfer · Unpaid · No settlement
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, voucher_status,
      items, drawing_data, total_amount, image_path,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      2, v_uid, 'Aung Ko', '09-222-333-444', '2026-05-16',
      'Transfer', 'Unpaid', 'Active',
      '[{"rowIndex":0,"qty":3,"price":4500,"amount":13500,"nameMode":"typing","typedName":"A4 Paper (500 sheets)"},
        {"rowIndex":1,"qty":2,"price":1800,"amount":3600,"nameMode":"typing","typedName":"Ballpoint Pen Set (10pcs)"}]'::jsonb,
      '{}'::jsonb, 17100, 'demo/seed-placeholder.png',
      v_staff2_id, 'Su Su Khin', '2026-05-16 11:00:00+06:30'
    );

    -- V-0003  Cash · Paid · Settlement → Ma Aye Aye
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, paid_at, voucher_status,
      items, drawing_data, total_amount, image_path,
      settlement_status, settlement_received_by, settlement_at, settlement_recorded_by,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      3, v_uid, 'Ma Ei Ei', null, '2026-05-18',
      'Cash', 'Paid', '2026-05-18 10:15:00+06:30', 'Active',
      '[{"rowIndex":0,"qty":1,"price":5000,"amount":5000,"nameMode":"typing","typedName":"Thermal Paper Roll (80mm)"},
        {"rowIndex":1,"qty":2,"price":900,"amount":1800,"nameMode":"typing","typedName":"Clear Tape (3-roll pack)"}]'::jsonb,
      '{}'::jsonb, 6800, 'demo/seed-placeholder.png',
      'Received', v_owner2_id, '2026-05-19 09:00:00+06:30', v_uid,
      v_staff1_id, 'Min Thu', '2026-05-18 10:15:00+06:30'
    );

    -- V-0004  PayNow · Paid · No settlement
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, paid_at, voucher_status,
      items, drawing_data, total_amount, image_path,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      4, v_uid, 'Pyae Pyae Aung', '09-444-555-666', '2026-05-20',
      'PayNow', 'Paid', '2026-05-20 14:00:00+06:30', 'Active',
      '[{"rowIndex":0,"qty":2,"price":15000,"amount":30000,"nameMode":"typing","typedName":"HP 678 Color Ink Cartridge"},
        {"rowIndex":1,"qty":1,"price":12000,"amount":12000,"nameMode":"typing","typedName":"HP 678 Black Ink Cartridge"}]'::jsonb,
      '{}'::jsonb, 42000, 'demo/seed-placeholder.png',
      v_staff3_id, 'Zaw Myo', '2026-05-20 14:00:00+06:30'
    );

    -- V-0005  Transfer · Paid · Settlement → Ko Kyaw Zin
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, paid_at, voucher_status,
      items, drawing_data, total_amount, image_path,
      settlement_status, settlement_received_by, settlement_at, settlement_recorded_by,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      5, v_uid, 'Htet Htet', '09-555-666-777', '2026-05-21',
      'Transfer', 'Paid', '2026-05-22 09:30:00+06:30', 'Active',
      '[{"rowIndex":0,"qty":4,"price":2200,"amount":8800,"nameMode":"typing","typedName":"A5 Notebook"},
        {"rowIndex":1,"qty":3,"price":1800,"amount":5400,"nameMode":"typing","typedName":"Ballpoint Pen Set (10pcs)"}]'::jsonb,
      '{}'::jsonb, 14200, 'demo/seed-placeholder.png',
      'Received', v_owner1_id, '2026-05-23 10:00:00+06:30', v_uid,
      v_staff2_id, 'Su Su Khin', '2026-05-21 15:30:00+06:30'
    );

    -- V-0006  Cash · Paid · No settlement
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, paid_at, voucher_status,
      items, drawing_data, total_amount, image_path,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      6, v_uid, 'Kyaw Zin', null, '2026-05-22',
      'Cash', 'Paid', '2026-05-22 11:00:00+06:30', 'Active',
      '[{"rowIndex":0,"qty":1,"price":3500,"amount":3500,"nameMode":"typing","typedName":"Stapler"},
        {"rowIndex":1,"qty":2,"price":500,"amount":1000,"nameMode":"typing","typedName":"Staple Refill (Box)"}]'::jsonb,
      '{}'::jsonb, 4500, 'demo/seed-placeholder.png',
      v_staff1_id, 'Min Thu', '2026-05-22 11:00:00+06:30'
    );

    -- V-0007  PayNow · Unpaid · No settlement (large outstanding)
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, voucher_status,
      items, drawing_data, total_amount, image_path,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      7, v_uid, 'Wai Lin', '09-777-888-111', '2026-05-25',
      'PayNow', 'Unpaid', 'Active',
      '[{"rowIndex":0,"qty":5,"price":4500,"amount":22500,"nameMode":"typing","typedName":"A4 Paper (500 sheets)"},
        {"rowIndex":1,"qty":2,"price":12000,"amount":24000,"nameMode":"typing","typedName":"HP 678 Black Ink Cartridge"}]'::jsonb,
      '{}'::jsonb, 46500, 'demo/seed-placeholder.png',
      v_staff2_id, 'Su Su Khin', '2026-05-25 13:00:00+06:30'
    );

    -- V-0008  Cash · Paid · Settlement → Ma Aye Aye
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, paid_at, voucher_status,
      items, drawing_data, total_amount, image_path,
      settlement_status, settlement_received_by, settlement_at, settlement_recorded_by,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      8, v_uid, 'Moe Moe', '09-888-111-222', '2026-05-26',
      'Cash', 'Paid', '2026-05-26 10:00:00+06:30', 'Active',
      '[{"rowIndex":0,"qty":1,"price":2500,"amount":2500,"nameMode":"typing","typedName":"File Folder Set (10pcs)"},
        {"rowIndex":1,"qty":1,"price":1500,"amount":1500,"nameMode":"typing","typedName":"Scissors"}]'::jsonb,
      '{}'::jsonb, 4000, 'demo/seed-placeholder.png',
      'Received', v_owner2_id, '2026-05-27 09:30:00+06:30', v_uid,
      v_staff3_id, 'Zaw Myo', '2026-05-26 10:00:00+06:30'
    );

    -- V-0009  Transfer · Paid · Settlement → Ko Kyaw Zin
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, paid_at, voucher_status,
      items, drawing_data, total_amount, image_path,
      settlement_status, settlement_received_by, settlement_at, settlement_recorded_by,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      9, v_uid, 'Thiha Zaw', '09-999-111-333', '2026-05-28',
      'Transfer', 'Paid', '2026-05-29 08:30:00+06:30', 'Active',
      '[{"rowIndex":0,"qty":2,"price":15000,"amount":30000,"nameMode":"typing","typedName":"HP 678 Color Ink Cartridge"},
        {"rowIndex":1,"qty":3,"price":4500,"amount":13500,"nameMode":"typing","typedName":"A4 Paper (500 sheets)"}]'::jsonb,
      '{}'::jsonb, 43500, 'demo/seed-placeholder.png',
      'Received', v_owner1_id, '2026-05-30 10:00:00+06:30', v_uid,
      v_staff1_id, 'Min Thu', '2026-05-28 14:00:00+06:30'
    );

    -- V-0010  VOID (Cash)
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, voucher_status, voided_at, voided_by,
      items, drawing_data, total_amount, image_path,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      10, v_uid, 'Test Customer', null, '2026-05-29',
      'Cash', 'Paid', 'Void', '2026-05-29 15:00:00+06:30', v_uid,
      '[{"rowIndex":0,"qty":1,"price":12000,"amount":12000,"nameMode":"typing","typedName":"HP 678 Black Ink Cartridge"}]'::jsonb,
      '{}'::jsonb, 12000, 'demo/seed-placeholder.png',
      v_staff2_id, 'Su Su Khin', '2026-05-29 12:00:00+06:30'
    );

    -- V-0011  Transfer · Unpaid · No settlement
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, voucher_status,
      items, drawing_data, total_amount, image_path,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      11, v_uid, 'Nay Lin', '09-111-444-777', '2026-05-30',
      'Transfer', 'Unpaid', 'Active',
      '[{"rowIndex":0,"qty":1,"price":2000,"amount":2000,"nameMode":"typing","typedName":"Tape Dispenser"},
        {"rowIndex":1,"qty":3,"price":900,"amount":2700,"nameMode":"typing","typedName":"Clear Tape (3-roll pack)"}]'::jsonb,
      '{}'::jsonb, 4700, 'demo/seed-placeholder.png',
      v_staff1_id, 'Min Thu', '2026-05-30 09:00:00+06:30'
    );

    -- V-0012  Cash · Paid · Settlement → Ko Kyaw Zin
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, paid_at, voucher_status,
      items, drawing_data, total_amount, image_path,
      settlement_status, settlement_received_by, settlement_at, settlement_recorded_by,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      12, v_uid, 'Aye Aye Khin', '09-222-555-888', '2026-06-02',
      'Cash', 'Paid', '2026-06-02 10:30:00+06:30', 'Active',
      '[{"rowIndex":0,"qty":3,"price":12000,"amount":36000,"nameMode":"typing","typedName":"HP 678 Black Ink Cartridge"},
        {"rowIndex":1,"qty":1,"price":4500,"amount":4500,"nameMode":"typing","typedName":"A4 Paper (500 sheets)"}]'::jsonb,
      '{}'::jsonb, 40500, 'demo/seed-placeholder.png',
      'Received', v_owner1_id, '2026-06-03 09:00:00+06:30', v_uid,
      v_staff2_id, 'Su Su Khin', '2026-06-02 10:30:00+06:30'
    );

    -- V-0013  PayNow · Paid · Settlement → Ma Aye Aye
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, paid_at, voucher_status,
      items, drawing_data, total_amount, image_path,
      settlement_status, settlement_received_by, settlement_at, settlement_recorded_by,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      13, v_uid, 'Soe Moe', null, '2026-06-04',
      'PayNow', 'Paid', '2026-06-04 14:30:00+06:30', 'Active',
      '[{"rowIndex":0,"qty":2,"price":3000,"amount":6000,"nameMode":"typing","typedName":"Highlighter Set (5 colors)"},
        {"rowIndex":1,"qty":4,"price":1800,"amount":7200,"nameMode":"typing","typedName":"Ballpoint Pen Set (10pcs)"}]'::jsonb,
      '{}'::jsonb, 13200, 'demo/seed-placeholder.png',
      'Received', v_owner2_id, '2026-06-05 09:30:00+06:30', v_uid,
      v_staff3_id, 'Zaw Myo', '2026-06-04 14:30:00+06:30'
    );

    -- V-0014  Transfer · Unpaid · No settlement (large outstanding)
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, voucher_status,
      items, drawing_data, total_amount, image_path,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      14, v_uid, 'Cho Cho Win', '09-444-777-222', '2026-06-05',
      'Transfer', 'Unpaid', 'Active',
      '[{"rowIndex":0,"qty":5,"price":4500,"amount":22500,"nameMode":"typing","typedName":"A4 Paper (500 sheets)"},
        {"rowIndex":1,"qty":2,"price":12000,"amount":24000,"nameMode":"typing","typedName":"HP 678 Black Ink Cartridge"}]'::jsonb,
      '{}'::jsonb, 46500, 'demo/seed-placeholder.png',
      v_staff1_id, 'Min Thu', '2026-06-05 11:00:00+06:30'
    );

    -- V-0015  Cash · Paid · Settlement → Ko Kyaw Zin
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, paid_at, voucher_status,
      items, drawing_data, total_amount, image_path,
      settlement_status, settlement_received_by, settlement_at, settlement_recorded_by,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      15, v_uid, 'Win Naing', '09-555-888-111', '2026-06-08',
      'Cash', 'Paid', '2026-06-08 09:45:00+06:30', 'Active',
      '[{"rowIndex":0,"qty":1,"price":3500,"amount":3500,"nameMode":"typing","typedName":"Stapler"},
        {"rowIndex":1,"qty":1,"price":2500,"amount":2500,"nameMode":"typing","typedName":"File Folder Set (10pcs)"},
        {"rowIndex":2,"qty":2,"price":1800,"amount":3600,"nameMode":"typing","typedName":"Ballpoint Pen Set (10pcs)"}]'::jsonb,
      '{}'::jsonb, 9600, 'demo/seed-placeholder.png',
      'Received', v_owner1_id, '2026-06-09 09:00:00+06:30', v_uid,
      v_staff2_id, 'Su Su Khin', '2026-06-08 09:45:00+06:30'
    );

    -- V-0016  VOID (Transfer)
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, voucher_status, voided_at, voided_by,
      items, drawing_data, total_amount, image_path,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      16, v_uid, 'Sample Customer', null, '2026-06-10',
      'Transfer', 'Unpaid', 'Void', '2026-06-10 16:30:00+06:30', v_uid,
      '[{"rowIndex":0,"qty":2,"price":15000,"amount":30000,"nameMode":"typing","typedName":"HP 678 Color Ink Cartridge"}]'::jsonb,
      '{}'::jsonb, 30000, 'demo/seed-placeholder.png',
      v_staff3_id, 'Zaw Myo', '2026-06-10 11:00:00+06:30'
    );

    -- V-0017  PayNow · Paid · Settlement → Ma Aye Aye
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, paid_at, voucher_status,
      items, drawing_data, total_amount, image_path,
      settlement_status, settlement_received_by, settlement_at, settlement_recorded_by,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      17, v_uid, 'Phyu Phyu Khin', '09-666-999-333', '2026-06-12',
      'PayNow', 'Paid', '2026-06-12 10:00:00+06:30', 'Active',
      '[{"rowIndex":0,"qty":4,"price":5000,"amount":20000,"nameMode":"typing","typedName":"Thermal Paper Roll (80mm)"},
        {"rowIndex":1,"qty":2,"price":4500,"amount":9000,"nameMode":"typing","typedName":"A4 Paper (500 sheets)"}]'::jsonb,
      '{}'::jsonb, 29000, 'demo/seed-placeholder.png',
      'Received', v_owner2_id, '2026-06-13 09:30:00+06:30', v_uid,
      v_staff1_id, 'Min Thu', '2026-06-12 10:00:00+06:30'
    );

    -- V-0018  Transfer · Paid · Settlement → Ko Kyaw Zin
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, paid_at, voucher_status,
      items, drawing_data, total_amount, image_path,
      settlement_status, settlement_received_by, settlement_at, settlement_recorded_by,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      18, v_uid, 'Kyaw San Oo', '09-777-111-444', '2026-06-15',
      'Transfer', 'Paid', '2026-06-16 09:00:00+06:30', 'Active',
      '[{"rowIndex":0,"qty":3,"price":12000,"amount":36000,"nameMode":"typing","typedName":"HP 678 Black Ink Cartridge"},
        {"rowIndex":1,"qty":2,"price":15000,"amount":30000,"nameMode":"typing","typedName":"HP 678 Color Ink Cartridge"}]'::jsonb,
      '{}'::jsonb, 66000, 'demo/seed-placeholder.png',
      'Received', v_owner1_id, '2026-06-17 10:00:00+06:30', v_uid,
      v_staff2_id, 'Su Su Khin', '2026-06-15 14:30:00+06:30'
    );

    -- V-0019  Cash · Paid · No settlement (small, recent)
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, paid_at, voucher_status,
      items, drawing_data, total_amount, image_path,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      19, v_uid, 'Ma Thida', null, '2026-06-20',
      'Cash', 'Paid', '2026-06-20 11:30:00+06:30', 'Active',
      '[{"rowIndex":0,"qty":2,"price":800,"amount":1600,"nameMode":"typing","typedName":"Correction Tape"},
        {"rowIndex":1,"qty":1,"price":1500,"amount":1500,"nameMode":"typing","typedName":"Scissors"}]'::jsonb,
      '{}'::jsonb, 3100, 'demo/seed-placeholder.png',
      v_staff1_id, 'Min Thu', '2026-06-20 11:30:00+06:30'
    );

    -- V-0020  PayNow · Unpaid · No settlement (largest single outstanding)
    insert into public.vouchers (
      sequence_number, created_by, customer_name, customer_phone, date,
      payment_method, payment_status, voucher_status,
      items, drawing_data, total_amount, image_path,
      made_by_staff_id, made_by_staff_name, created_at
    ) values (
      20, v_uid, 'Zin Mar Aung', '09-888-222-555', '2026-06-25',
      'PayNow', 'Unpaid', 'Active',
      '[{"rowIndex":0,"qty":5,"price":12000,"amount":60000,"nameMode":"typing","typedName":"HP 678 Black Ink Cartridge"},
        {"rowIndex":1,"qty":3,"price":15000,"amount":45000,"nameMode":"typing","typedName":"HP 678 Color Ink Cartridge"}]'::jsonb,
      '{}'::jsonb, 105000, 'demo/seed-placeholder.png',
      v_staff2_id, 'Su Su Khin', '2026-06-25 13:00:00+06:30'
    );

    -- Advance the sequence so the next real voucher is #21
    perform setval('public.voucher_sequence_number_seq', 20);

  end if; -- end voucher seed block

  -- ---- 6. Settlement audit log entries for settled vouchers ----
  -- Only insert if the log is empty (safe to re-run).
  if not exists (select 1 from public.settlement_audit_log limit 1) then
    insert into public.settlement_audit_log (voucher_id, action, owner_id, performed_by, performed_at)
    select v.id, 'Received', v.settlement_received_by, v_uid, v.settlement_at
    from public.vouchers v
    where v.settlement_status = 'Received'
    and v.settlement_at is not null;
  end if;

  raise notice 'Demo seed complete. Login: demo@inkvoucher.app / Demo2024!';
  raise notice 'Owners: Ko Kyaw Zin, Ma Aye Aye';
  raise notice 'Staff: Min Thu, Su Su Khin, Zaw Myo (inactive)';
  raise notice 'Vouchers: V-0001 to V-0020 (V-0010, V-0016 are Void)';

end;
$$;
