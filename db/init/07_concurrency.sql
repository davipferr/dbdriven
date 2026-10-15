-- =============================================================================
-- 07_concurrency.sql: the Concurrency Lab (a flash sale)
--
-- 10 people click "Buy" on the last 3 pairs of sneakers at the same moment.
-- Each click is its own transaction on its own connection. How many orders do
-- we end up with, and what does the stock column say afterwards?
--
-- Every buy function below has the same shape:
--   1. read the stock
--   2. "think" for delay_ms  (stands in for real latency: an HTTP call to a
--      payment provider, a slow ORM, a busy server...)
--   3. write the new stock and insert an order
-- and they differ only in HOW they protect the gap between 1 and 3:
--
--   strategy       function                 what protects the gap
--   naive          api.lab_buy_naive        nothing (READ COMMITTED)
--   for_update     api.lab_buy_for_update   a row lock taken at the read
--   atomic         api.lab_buy_atomic       there is no gap: one UPDATE reads and writes
--   optimistic     api.lab_buy_optimistic   a version column; the client retries if it changed
--   serializable   api.lab_buy_naive        the SAME naive code, run at SERIALIZABLE
--                                           isolation; the client retries on 40001
--
-- Each user gets their own product (RLS), so two people racing in two
-- browsers never interfere with each other.
-- =============================================================================

create table app.lab_products (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid() references app.users (id) on delete cascade,
  name          text not null default 'Limited sneakers',
  initial_stock int  not null check (initial_stock between 1 and 100),
  -- The safety net. It stops the stock from going negative, but notice that it
  -- can't catch a LOST update: "stock = 2 after selling 10" is a valid number.
  stock         int  not null check (stock >= 0),
  version       int  not null default 0, -- only the optimistic strategy uses it
  created_at    timestamptz not null default now()
);

create table app.lab_orders (
  id         bigint generated always as identity primary key,
  product_id bigint not null references app.lab_products (id) on delete cascade,
  user_id    uuid not null default auth.uid() references app.users (id) on delete cascade,
  buyer      int  not null,
  strategy   text not null,
  attempts   int  not null default 1,
  created_at timestamptz not null default clock_timestamp() -- now() is the tx start, not the insert
);

create index on app.lab_products (user_id);
create index on app.lab_orders (product_id);

alter table app.lab_products enable row level security;
alter table app.lab_orders enable row level security;

create policy lab_products_owner_only on app.lab_products
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy lab_orders_owner_only on app.lab_orders
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Which try this is (1, 2, ...). The gateway retries transactions that fail
-- with 40001/40P01 and says so in a transaction-local setting, like the token.
create function app.lab_attempt() returns int
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.attempt', true), '')::int, 1);
$$;

-- ---------- Setup and results ----------

-- args: { stock }. Throws away your previous product (and its orders) and
-- puts a fresh one on sale.
create function api.lab_reset(args jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_stock   int := coalesce((args->>'stock')::int, 3);
  v_product app.lab_products;
begin
  perform auth.require_uid();
  delete from app.lab_products; -- RLS: only yours
  insert into app.lab_products (initial_stock, stock) values (v_stock, v_stock)
  returning * into v_product;
  return to_jsonb(v_product);
exception
  when check_violation then
    raise exception 'Stock must be between 1 and 100' using errcode = '22023';
end $$;

-- What actually ended up in the database after the race.
create function api.lab_state(args jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_product app.lab_products;
begin
  perform auth.require_uid();
  select * into v_product from app.lab_products order by id desc limit 1;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'product', to_jsonb(v_product),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object('buyer', o.buyer, 'attempts', o.attempts, 'created_at', o.created_at)
                       order by o.created_at)
      from app.lab_orders o where o.product_id = v_product.id
    ), '[]'::jsonb)
  );
end $$;

-- ---------- The buy functions ----------
-- All take { product_id, buyer, delay_ms, strategy } and return
-- { buyer, status: 'bought' | 'sold_out', seen_stock, attempts, isolation }.

-- 1. NAIVE: read, think, write what we read minus one.
-- This is what `product.stock -= 1; product.save()` in most ORMs does.
-- Ten buyers all read stock = 3, all think, all write 2: ten orders, and the
-- stock column says 2. Nine of the ten writes were silently lost.
create function api.lab_buy_naive(args jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_id    bigint := (args->>'product_id')::bigint;
  v_stock int;
begin
  perform auth.require_uid();

  select stock into v_stock from app.lab_products where id = v_id;          -- 1. read
  if not found then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;

  perform pg_sleep(least(greatest(coalesce((args->>'delay_ms')::int, 0), 0), 2000) / 1000.0); -- 2. think

  if v_stock <= 0 then
    return jsonb_build_object('buyer', args->'buyer', 'status', 'sold_out', 'seen_stock', v_stock,
                              'attempts', 1, 'isolation', current_setting('transaction_isolation'));
  end if;

  update app.lab_products set stock = v_stock - 1 where id = v_id;          -- 3. write
  insert into app.lab_orders (product_id, buyer, strategy)
  values (v_id, (args->>'buyer')::int, coalesce(args->>'strategy', 'naive'));

  return jsonb_build_object('buyer', args->'buyer', 'status', 'bought', 'seen_stock', v_stock,
                            'attempts', 1, 'isolation', current_setting('transaction_isolation'));
end $$;

-- 2. FOR UPDATE (pessimistic locking): the naive code plus two words.
-- The first buyer to read the row locks it; everyone else's SELECT waits
-- until that transaction commits, then reads the NEW stock.
-- Correct, but buyers now go one at a time: the race takes buyers x delay_ms.
create function api.lab_buy_for_update(args jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_id    bigint := (args->>'product_id')::bigint;
  v_stock int;
begin
  perform auth.require_uid();

  select stock into v_stock from app.lab_products where id = v_id for update; -- 1. read + lock
  if not found then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;

  perform pg_sleep(least(greatest(coalesce((args->>'delay_ms')::int, 0), 0), 2000) / 1000.0); -- 2. think (holding the lock!)

  if v_stock <= 0 then
    return jsonb_build_object('buyer', args->'buyer', 'status', 'sold_out', 'seen_stock', v_stock,
                              'attempts', 1, 'isolation', current_setting('transaction_isolation'));
  end if;

  update app.lab_products set stock = v_stock - 1 where id = v_id;            -- 3. write
  insert into app.lab_orders (product_id, buyer, strategy)
  values (v_id, (args->>'buyer')::int, 'for_update');

  return jsonb_build_object('buyer', args->'buyer', 'status', 'bought', 'seen_stock', v_stock,
                            'attempts', 1, 'isolation', current_setting('transaction_isolation'));
end $$;

-- 3. ATOMIC UPDATE: don't read-then-write at all. Let ONE statement check and
-- decrement. If two run at once, the second waits for the first's row lock,
-- then re-checks `stock > 0` against the committed row (READ COMMITTED's
-- "re-evaluate the WHERE clause" rule), so it can never oversell.
-- The think time happens BEFORE the update, so buyers still think in parallel.
create function api.lab_buy_atomic(args jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_id    bigint := (args->>'product_id')::bigint;
  v_stock int;
begin
  perform auth.require_uid();

  perform pg_sleep(least(greatest(coalesce((args->>'delay_ms')::int, 0), 0), 2000) / 1000.0); -- think

  update app.lab_products set stock = stock - 1                             -- check + write, in one go
  where id = v_id and stock > 0
  returning stock + 1 into v_stock;

  if not found then
    select stock into v_stock from app.lab_products where id = v_id;
    if not found then
      raise exception 'Product not found' using errcode = 'P0002';
    end if;
    return jsonb_build_object('buyer', args->'buyer', 'status', 'sold_out', 'seen_stock', v_stock,
                              'attempts', 1, 'isolation', current_setting('transaction_isolation'));
  end if;

  insert into app.lab_orders (product_id, buyer, strategy)
  values (v_id, (args->>'buyer')::int, 'atomic');

  return jsonb_build_object('buyer', args->'buyer', 'status', 'bought', 'seen_stock', v_stock,
                            'attempts', 1, 'isolation', current_setting('transaction_isolation'));
end $$;

-- 4. OPTIMISTIC LOCKING: read the stock AND a version number, think without
-- holding any lock, then write only if the version is still the one we read.
-- If someone got there first, 0 rows are updated: we raise 40001 and the
-- caller retries in a new transaction (like an HTTP 409 + "reload and retry").
--
-- Why not just loop and retry right here? Try it: it stays correct but gets
-- slow. When our UPDATE waits for the winner's row lock and then finds the
-- version changed, Postgres has already LOCKED the new row version to re-check
-- it, and that lock is kept until OUR transaction ends, even though nothing
-- was updated. So a retry in the same transaction holds the row lock through
-- its next think time, and the other losers queue behind it.
create function api.lab_buy_optimistic(args jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_id      bigint := (args->>'product_id')::bigint;
  v_stock   int;
  v_version int;
begin
  perform auth.require_uid();

  select stock, version into v_stock, v_version from app.lab_products where id = v_id; -- 1. read
  if not found then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;

  perform pg_sleep(least(greatest(coalesce((args->>'delay_ms')::int, 0), 0), 2000) / 1000.0); -- 2. think

  if v_stock <= 0 then
    return jsonb_build_object('buyer', args->'buyer', 'status', 'sold_out', 'seen_stock', v_stock,
                              'attempts', 1, 'isolation', current_setting('transaction_isolation'));
  end if;

  update app.lab_products set stock = v_stock - 1, version = v_version + 1    -- 3. write, if nobody else did
  where id = v_id and version = v_version;
  if not found then
    raise exception 'Stock changed since you read it (version %): retry', v_version
      using errcode = '40001';
  end if;

  insert into app.lab_orders (product_id, buyer, strategy, attempts)
  values (v_id, (args->>'buyer')::int, 'optimistic', app.lab_attempt());

  return jsonb_build_object('buyer', args->'buyer', 'status', 'bought', 'seen_stock', v_stock,
                            'attempts', 1, 'isolation', current_setting('transaction_isolation'));
end $$;

-- 5. SERIALIZABLE has no function of its own: the client calls
-- api.lab_buy_naive with isolation = 'serializable' (see api/src/server.js).
-- Postgres then promises the result equals SOME one-at-a-time order of the
-- transactions. When it can't keep that promise, it aborts one with SQLSTATE
-- 40001 (serialization_failure) and the caller must run it again from the top
-- (here the gateway does, see `retry` in /api/rpc-batch).
-- A retry can't happen inside the function: the whole transaction is doomed.

-- ---------- Privileges ----------

grant select, insert, update, delete on app.lab_products to app_api;
grant select, insert, delete on app.lab_orders to app_api;
grant execute on function app.lab_attempt() to app_api;
grant execute on function
  api.lab_reset(jsonb), api.lab_state(jsonb),
  api.lab_buy_naive(jsonb), api.lab_buy_for_update(jsonb),
  api.lab_buy_atomic(jsonb), api.lab_buy_optimistic(jsonb)
to app_api;
