-- =============================================================================
-- 08_bank_transfer.sql: the Concurrency Lab, part 2 (bank transfers)
--
-- Alice pays Bob and Bob pays Alice, many times, all at the same moment.
-- The flash sale (07_concurrency.sql) touched ONE row per transaction. A
-- transfer touches TWO, and that brings a new failure: the DEADLOCK.
--
--   T1 (Alice -> Bob)            T2 (Bob -> Alice)
--   lock Alice                   lock Bob
--   ...think...                  ...think...
--   lock Bob    -- waits for T2  lock Alice  -- waits for T1   => stuck forever
--
-- Postgres notices after `deadlock_timeout` (1 s by default), kills one of the
-- two with SQLSTATE 40P01 (deadlock_detected), and the other goes on. The
-- client has to retry the victim, and everyone lost a second.
--
--   strategy       function                  what happens
--   naive          api.lab_transfer_naive    reads both balances, writes what it read:
--                                            money appears or vanishes (lost updates)
--   for_update     api.lab_transfer_for_update  locks FROM, then TO: correct, but deadlocks
--   atomic         api.lab_transfer_atomic   two relative UPDATEs: correct, still deadlocks
--   ordered        api.lab_transfer_ordered  locks the LOWER id first, whatever the
--                                            direction: correct, no deadlocks
--   serializable   api.lab_transfer_naive    the naive code at SERIALIZABLE + client retry
--
-- The invariant to watch: money is only moved, never made. The total across
-- all accounts must be the same before and after.
-- =============================================================================

create table app.lab_accounts (
  id              bigint generated always as identity primary key,
  user_id         uuid not null default auth.uid() references app.users (id) on delete cascade,
  name            text not null,
  initial_balance int  not null check (initial_balance between 0 and 100000),
  balance         int  not null check (balance >= 0), -- no overdrafts, whatever the code does
  created_at      timestamptz not null default now()
);

create table app.lab_transfers (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references app.users (id) on delete cascade,
  from_id    bigint not null references app.lab_accounts (id) on delete cascade,
  to_id      bigint not null references app.lab_accounts (id) on delete cascade,
  amount     int  not null check (amount > 0),
  transfer   int  not null, -- the client's number for this transfer (1..N)
  strategy   text not null,
  attempts   int  not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  check (from_id <> to_id)
);

create index on app.lab_accounts (user_id);
create index on app.lab_transfers (from_id);
create index on app.lab_transfers (to_id);

alter table app.lab_accounts enable row level security;
alter table app.lab_transfers enable row level security;

create policy lab_accounts_owner_only on app.lab_accounts
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy lab_transfers_owner_only on app.lab_transfers
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------- Setup and results ----------

-- args: { accounts: 2-4, balance }. Throws away your previous accounts (and
-- their transfers) and opens new ones: Alice, Bob, Carol, Dave.
create function api.lab_bank_reset(args jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_count   int := coalesce((args->>'accounts')::int, 2);
  v_balance int := coalesce((args->>'balance')::int, 100);
begin
  perform auth.require_uid();
  if v_count not between 2 and 4 then
    raise exception 'Use 2 to 4 accounts' using errcode = '22023';
  end if;

  delete from app.lab_accounts; -- RLS: only yours
  insert into app.lab_accounts (name, initial_balance, balance)
  select name, v_balance, v_balance
  from unnest((array['Alice', 'Bob', 'Carol', 'Dave'])[1:v_count]) with ordinality as t (name, n)
  order by n; -- ids follow the names, so "lower id first" means Alice before Bob

  return (select jsonb_agg(to_jsonb(a) order by a.id) from app.lab_accounts a);
exception
  when check_violation then
    raise exception 'Balance must be between 0 and 100000' using errcode = '22023';
end $$;

-- Each account's balance next to what its recorded transfers say it should be.
create function api.lab_bank_state(args jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  perform auth.require_uid();
  return jsonb_build_object(
    'deadlock_timeout', current_setting('deadlock_timeout'),
    'transfers', (select count(*) from app.lab_transfers),
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id,
               'name', a.name,
               'initial', a.initial_balance,
               'balance', a.balance,
               'expected', a.initial_balance
                           - coalesce((select sum(t.amount) from app.lab_transfers t where t.from_id = a.id), 0)
                           + coalesce((select sum(t.amount) from app.lab_transfers t where t.to_id = a.id), 0)
             ) order by a.id)
      from app.lab_accounts a
    ), '[]'::jsonb)
  );
end $$;

-- ---------- The transfer functions ----------
-- All take { from, to, amount, delay_ms, transfer, strategy } and
-- return { transfer, status: 'transferred' | 'insufficient_funds', seen_balance }.

-- 1. NAIVE: read both balances, think, write what we read +/- the amount.
-- Alice -> Bob and Bob -> Alice both read (100, 100). One writes (70, 130),
-- the other writes (130, 70), and whichever commits last wins: two transfers
-- recorded, but the balances show only one. Money was created or destroyed.
-- With 2 accounts the TOTAL still adds up (every write moves money between the
-- same two rows), but the balances no longer match the recorded transfers.
-- With 3+ accounts (Alice -> Bob -> Carol -> Alice) even the total breaks.
create function api.lab_transfer_naive(args jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_from         bigint := (args->>'from')::bigint;
  v_to           bigint := (args->>'to')::bigint;
  v_amount       int    := (args->>'amount')::int;
  v_from_balance int;
  v_to_balance   int;
begin
  perform auth.require_uid();

  select balance into v_from_balance from app.lab_accounts where id = v_from;  -- 1. read both
  select balance into v_to_balance   from app.lab_accounts where id = v_to;
  if v_from_balance is null or v_to_balance is null then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;

  perform pg_sleep(least(greatest(coalesce((args->>'delay_ms')::int, 0), 0), 2000) / 1000.0); -- 2. think

  if v_from_balance < v_amount then
    return jsonb_build_object('transfer', args->'transfer', 'status', 'insufficient_funds', 'seen_balance', v_from_balance);
  end if;

  -- 3. write what we read, both rows in ONE statement. (Two UPDATEs would lock
  -- the rows in opposite orders for opposite directions and deadlock, which
  -- would accidentally serialize the transfers and hide the bug. See #2.)
  update app.lab_accounts
  set balance = case id when v_from then v_from_balance - v_amount
                        else v_to_balance + v_amount end
  where id in (v_from, v_to);
  insert into app.lab_transfers (from_id, to_id, amount, transfer, strategy, attempts)
  values (v_from, v_to, v_amount, (args->>'transfer')::int, coalesce(args->>'strategy', 'naive'),
          app.lab_attempt());

  return jsonb_build_object('transfer', args->'transfer', 'status', 'transferred', 'seen_balance', v_from_balance);
end $$;

-- 2. FOR UPDATE, in request order: lock the account we pay FROM, think, then
-- lock the account we pay TO. Balances are now always right, but Alice -> Bob
-- holds Alice and waits for Bob while Bob -> Alice holds Bob and waits for
-- Alice: a deadlock, every time the two directions overlap.
create function api.lab_transfer_for_update(args jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_from         bigint := (args->>'from')::bigint;
  v_to           bigint := (args->>'to')::bigint;
  v_amount       int    := (args->>'amount')::int;
  v_from_balance int;
  v_to_balance   int;
begin
  perform auth.require_uid();

  select balance into v_from_balance from app.lab_accounts where id = v_from for update; -- lock #1: FROM

  perform pg_sleep(least(greatest(coalesce((args->>'delay_ms')::int, 0), 0), 2000) / 1000.0); -- think, holding #1

  select balance into v_to_balance from app.lab_accounts where id = v_to for update;     -- lock #2: TO
  if v_from_balance is null or v_to_balance is null then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;

  if v_from_balance < v_amount then
    return jsonb_build_object('transfer', args->'transfer', 'status', 'insufficient_funds', 'seen_balance', v_from_balance);
  end if;

  update app.lab_accounts set balance = v_from_balance - v_amount where id = v_from;
  update app.lab_accounts set balance = v_to_balance + v_amount where id = v_to;
  insert into app.lab_transfers (from_id, to_id, amount, transfer, strategy, attempts)
  values (v_from, v_to, v_amount, (args->>'transfer')::int, 'for_update', app.lab_attempt());

  return jsonb_build_object('transfer', args->'transfer', 'status', 'transferred', 'seen_balance', v_from_balance);
end $$;

-- 3. ATOMIC UPDATEs: no reads at all, so no lost updates (the flash-sale fix).
-- But each UPDATE still locks its row until COMMIT, and a transfer runs two of
-- them, debit first. So this deadlocks exactly like FOR UPDATE: atomic
-- statements don't help once a transaction touches several rows.
-- (The think time sits between debit and credit: say, a fraud check.)
create function api.lab_transfer_atomic(args jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_from         bigint := (args->>'from')::bigint;
  v_to           bigint := (args->>'to')::bigint;
  v_amount       int    := (args->>'amount')::int;
  v_from_balance int;
begin
  perform auth.require_uid();

  update app.lab_accounts set balance = balance - v_amount                  -- debit = lock #1
  where id = v_from and balance >= v_amount
  returning balance + v_amount into v_from_balance;
  if not found then
    select balance into v_from_balance from app.lab_accounts where id = v_from;
    if not found then
      raise exception 'Account not found' using errcode = 'P0002';
    end if;
    return jsonb_build_object('transfer', args->'transfer', 'status', 'insufficient_funds', 'seen_balance', v_from_balance);
  end if;

  perform pg_sleep(least(greatest(coalesce((args->>'delay_ms')::int, 0), 0), 2000) / 1000.0); -- think, holding #1

  update app.lab_accounts set balance = balance + v_amount where id = v_to; -- credit = lock #2
  if not found then
    raise exception 'Account not found' using errcode = 'P0002'; -- rolls the debit back too
  end if;

  insert into app.lab_transfers (from_id, to_id, amount, transfer, strategy, attempts)
  values (v_from, v_to, v_amount, (args->>'transfer')::int, 'atomic', app.lab_attempt());

  return jsonb_build_object('transfer', args->'transfer', 'status', 'transferred', 'seen_balance', v_from_balance);
end $$;

-- 4. LOCK ORDERING: the same locks as FOR UPDATE, but always the LOWER id
-- first, whichever way the money goes. Alice -> Bob and Bob -> Alice now both
-- start by locking Alice, so one simply waits for the other: a queue, never a
-- cycle. This is THE standard fix: every code path that locks several rows
-- agrees on one global order.
create function api.lab_transfer_ordered(args jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_from         bigint := (args->>'from')::bigint;
  v_to           bigint := (args->>'to')::bigint;
  v_amount       int    := (args->>'amount')::int;
  v_from_balance int;
begin
  perform auth.require_uid();

  perform 1 from app.lab_accounts where id = least(v_from, v_to) for update;    -- lock #1: lower id

  perform pg_sleep(least(greatest(coalesce((args->>'delay_ms')::int, 0), 0), 2000) / 1000.0); -- think, holding #1

  perform 1 from app.lab_accounts where id = greatest(v_from, v_to) for update; -- lock #2: higher id

  select balance into v_from_balance from app.lab_accounts where id = v_from;   -- both locked: safe to read
  if not found then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;
  if v_from_balance < v_amount then
    return jsonb_build_object('transfer', args->'transfer', 'status', 'insufficient_funds', 'seen_balance', v_from_balance);
  end if;

  update app.lab_accounts set balance = balance - v_amount where id = v_from;
  update app.lab_accounts set balance = balance + v_amount where id = v_to;
  if not found then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;
  insert into app.lab_transfers (from_id, to_id, amount, transfer, strategy, attempts)
  values (v_from, v_to, v_amount, (args->>'transfer')::int, 'ordered', app.lab_attempt());

  return jsonb_build_object('transfer', args->'transfer', 'status', 'transferred', 'seen_balance', v_from_balance);
end $$;

-- 5. SERIALIZABLE: the client calls api.lab_transfer_naive at SERIALIZABLE
-- isolation and the gateway retries it on 40001.

-- ---------- Deadlock detection ----------
-- Checking for deadlocks is expensive, so Postgres first just waits
-- `deadlock_timeout` (default 1 s) and only then looks for a cycle. Every
-- deadlock in the lab would cost a full second, and a 10-transfer race can hit
-- 30+ of them. For the lab's role only, check after 200 ms instead. (Takes
-- effect on new connections. In production, keep the default and fix the lock
-- order instead.)
alter role app_api set deadlock_timeout = '200ms';

-- ---------- Privileges ----------

grant select, insert, update, delete on app.lab_accounts to app_api;
grant select, insert, delete on app.lab_transfers to app_api;
grant execute on function
  api.lab_bank_reset(jsonb), api.lab_bank_state(jsonb),
  api.lab_transfer_naive(jsonb), api.lab_transfer_for_update(jsonb),
  api.lab_transfer_atomic(jsonb), api.lab_transfer_ordered(jsonb)
to app_api;
