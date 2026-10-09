-- =============================================================================
-- 05_jobs.sql: a background job queue (a mini BullMQ / Sidekiq) inside Postgres
--
-- The pieces:
--   app.jobs      one row per job; its `status` is a small state machine
--   app.job_runs  one row per ATTEMPT (history: who ran it, when, what happened)
--   app.workers   worker processes that are alive (they heartbeat every few seconds)
--
-- The life of a job:
--
--   enqueue ──► queued ──claim──► running ──complete──► succeeded
--                 ▲   │              │
--                 │   cancel         ├──fail (attempts left)──► queued (run_at = now + backoff)
--                 │   ▼              ├──fail (no attempts left / permanent)──► failed
--                 │ cancelled        └──lease expired (worker died)──► queued / failed
--                 └───── retry (from failed / cancelled) ─────┘
--
-- The three ideas this file teaches:
--
--   1. CONCURRENCY with  SELECT ... FOR UPDATE SKIP LOCKED
--      Many workers run the same "give me the next job" query at the same time.
--      FOR UPDATE locks the rows it picks; SKIP LOCKED makes the other workers
--      silently step over those rows instead of waiting for them. Result: every
--      worker gets DIFFERENT jobs, nobody blocks, and no job is handed out twice.
--
--   2. LOCKING with leases
--      The row lock only lasts for the claim transaction (milliseconds). The
--      worker then runs the job OUTSIDE any transaction (it could take minutes),
--      so instead it holds a *lease*: `lease_expires_at`. A live worker keeps
--      extending it (heartbeat). A crashed worker can't, the lease runs out and
--      the job goes back to the queue.
--
--   3. AT-LEAST-ONCE delivery
--      Because of (2), a job can run more than once: e.g. the worker finished the
--      work but crashed before reporting "done". The queue guarantees a job is
--      never LOST, not that it runs exactly once. So handlers must be idempotent
--      (safe to run twice), e.g. by using the job id as an idempotency key.
--      Late reports from a worker that lost its lease are rejected ("fencing").
--
-- Who can do what:
--   app_api    (the web backend): enqueue/list/retry/cancel its user's jobs via api.*
--   app_worker (the worker processes): ONLY the worker.* functions below
-- =============================================================================

create schema worker;

-- A second login role, for the worker processes. Like app_api it owns nothing
-- and gets nothing but EXECUTE on its own functions (granted at the bottom).
create role app_worker login password 'app_worker_dev_password';

-- ---------- Tables ----------

create table app.jobs (
  id               bigint generated always as identity primary key,
  user_id          uuid not null references app.users (id) on delete cascade,
  queue            text not null default 'default' check (queue ~ '^[a-z][a-z0-9_-]{0,30}$'),
  kind             text not null check (kind ~ '^[a-z][a-z0-9_]{0,40}$'), -- which handler runs it
  payload          jsonb not null default '{}'
                   check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 10000),
  status           text not null default 'queued'
                   check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  priority         int not null default 0 check (priority between -10 and 10), -- higher runs first
  attempts         int not null default 0 check (attempts >= 0),               -- how many times it was claimed
  max_attempts     int not null default 5 check (max_attempts between 1 and 20),
  run_at           timestamptz not null default now(), -- not before this (delays & retry backoff)
  locked_by        text,        -- worker id holding the lease
  locked_at        timestamptz,
  lease_expires_at timestamptz,
  last_error       text,
  result           jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  finished_at      timestamptz,

  -- Invariant: a job has an owner (worker + lease) if and only if it is running.
  constraint running_jobs_have_a_lease check (
    (status = 'running') = (locked_by is not null and lease_expires_at is not null)
  )
);

-- The hot path. A *partial* index containing only the jobs waiting to run, already
-- sorted the way workers want them. Finished jobs (the vast majority, eventually)
-- aren't in it at all, so it stays tiny and the claim query stays fast.
create index jobs_ready_idx on app.jobs (queue, priority desc, run_at, id) where status = 'queued';
-- For finding expired leases.
create index jobs_running_idx on app.jobs (lease_expires_at) where status = 'running';
-- For the dashboard.
create index jobs_user_idx on app.jobs (user_id, id desc);

create table app.job_runs (
  id          bigint generated always as identity primary key,
  job_id      bigint not null references app.jobs (id) on delete cascade,
  user_id     uuid not null, -- copied from the job so the RLS policy is a simple comparison
  attempt     int not null,
  worker_id   text not null,
  outcome     text not null default 'running'
              check (outcome in ('running', 'succeeded', 'failed', 'lost')),
  error       text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  unique (job_id, attempt)
);

create index job_runs_finished_idx on app.job_runs (user_id, finished_at) where finished_at is not null;

create table app.workers (
  id           text primary key, -- "<hostname>:<pid>"
  queues       text[] not null,
  concurrency  int not null,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  processed    bigint not null default 0,
  failed       bigint not null default 0
);

-- Users can READ their own jobs and runs. All writes go through the functions
-- below, so nobody can e.g. flip a job to 'succeeded' with a raw UPDATE.
alter table app.jobs enable row level security;
alter table app.job_runs enable row level security;

create policy jobs_owner_read on app.jobs for select
  using (user_id = (select auth.uid()));
create policy job_runs_owner_read on app.job_runs for select
  using (user_id = (select auth.uid()));

-- ---------- Rules (triggers) ----------

-- Rule: status only moves along the arrows of the diagram at the top.
-- Even a buggy SECURITY DEFINER function can't make an illegal jump.
create function app.jobs_check_transition() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status
     and old.status || ' -> ' || new.status not in (
       'queued -> running',    -- claimed by a worker
       'queued -> cancelled',  -- cancelled before it started
       'running -> succeeded', -- worker reported success
       'running -> queued',    -- failed, will retry (or its lease expired)
       'running -> failed',    -- failed for good
       'failed -> queued',     -- manual retry
       'cancelled -> queued'   -- manual retry
     ) then
    raise exception 'Job % cannot go from % to %', old.id, old.status, new.status
      using errcode = 'P0001';
  end if;

  new.updated_at  := now();
  new.finished_at := case when new.status in ('succeeded', 'failed', 'cancelled') then now() end;
  return new;
end $$;

create trigger jobs_check_transition
  before update on app.jobs
  for each row execute function app.jobs_check_transition();

-- Realtime, two channels (both only delivered on COMMIT):
--   job_changes:    the backend forwards it to the owner's dashboard (like todo_changes)
--   jobs_available: wakes idle workers up immediately, so they don't have to wait
--                   for their next poll. Postgres merges identical notifications
--                   within one transaction, so enqueueing 500 jobs sends ONE wake-up.
-- `update of status`: heartbeats only touch lease_expires_at and don't spam this.
create function app.jobs_notify() returns trigger
language plpgsql as $$
declare
  r app.jobs := coalesce(new, old);
begin
  perform pg_notify('job_changes', json_build_object(
    'op', tg_op, 'id', r.id, 'user_id', r.user_id, 'status', r.status
  )::text);

  if tg_op <> 'DELETE' and new.status = 'queued' and new.run_at <= now() then
    perform pg_notify('jobs_available', new.queue);
  end if;
  return null;
end $$;

create trigger jobs_notify
  after insert or update of status or delete on app.jobs
  for each row execute function app.jobs_notify();

-- ---------- Internal helpers ----------

-- How long a claim is valid without a heartbeat. Workers heartbeat every 5s.
create function private.job_lease() returns interval
language sql immutable as $$ select interval '15 seconds' $$;

-- Exponential backoff: ~2s, 4s, 8s, 16s, 32s ... capped at 5 minutes.
-- The ±25% random "jitter" spreads out retries, so 500 jobs that failed together
-- (say, the email server was down) don't all retry at the exact same instant
-- and knock it over again (the "thundering herd").
-- (Sidekiq uses attempts^4 + 15 + random, which grows much slower at first.)
create function private.job_backoff(attempt int) returns interval
language sql volatile as $$
  select make_interval(secs => least(power(2, attempt), 300) * (0.75 + random() * 0.5));
$$;

-- An attempt failed: re-queue with backoff, or bury it if it's out of attempts
-- (or the error is permanent). The caller must already hold the row lock.
create function private.fail_attempt(
  p_job_id bigint, p_error text, p_retryable boolean, p_outcome text
) returns app.jobs
language plpgsql as $$
declare
  v_job app.jobs;
begin
  update app.jobs set
    status = case when p_retryable and attempts < max_attempts then 'queued' else 'failed' end,
    run_at = case when p_retryable and attempts < max_attempts
                  then now() + private.job_backoff(attempts) else run_at end,
    last_error       = left(p_error, 2000),
    locked_by        = null,
    locked_at        = null,
    lease_expires_at = null
  where id = p_job_id
  returning * into v_job;

  update app.job_runs
  set outcome = p_outcome, error = left(p_error, 2000), finished_at = now()
  where job_id = p_job_id and attempt = v_job.attempts;

  return v_job;
end $$;

-- Jobs whose worker stopped heartbeating (crashed, killed, network gone, frozen).
-- This is where AT-LEAST-ONCE comes from: the job may have been half done (or
-- even fully done!) but we can't know, so it runs again.
-- SKIP LOCKED again: if two workers reap at the same time they split the work.
create function private.reap_expired_jobs() returns int
language plpgsql as $$
declare
  v_id bigint;
  n    int := 0;
begin
  for v_id in
    select id from app.jobs
    where status = 'running' and lease_expires_at < now()
    for update skip locked
  loop
    perform private.fail_attempt(
      v_id, 'Lease expired: the worker stopped heartbeating (crashed or hung?)', true, 'lost');
    n := n + 1;
  end loop;
  return n;
end $$;

-- =============================================================================
-- The worker API. SECURITY DEFINER: runs as the table owner, so it bypasses RLS
-- and sees every user's jobs. app_worker can call these and nothing else.
-- =============================================================================

-- Claim up to p_limit jobs. THE core query of the whole queue.
create function worker.claim_jobs(p_worker_id text, p_queues text[], p_limit int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_jobs jsonb;
begin
  -- Housekeeping first: put jobs of dead workers back in the queue.
  perform private.reap_expired_jobs();

  with next_jobs as (
    -- Pick the best ready jobs and lock them. Rows another worker locked a
    -- moment ago are skipped, not waited for. (Without SKIP LOCKED, every worker
    -- would queue up behind the first one's locks on the same top rows.)
    select id from app.jobs
    where status = 'queued' and run_at <= now() and queue = any (p_queues)
    order by priority desc, run_at, id
    limit least(greatest(p_limit, 0), 50)
    for update skip locked
  ), claimed as (
    -- Still in the same transaction, so we still hold the locks: take ownership.
    update app.jobs j set
      status           = 'running',
      attempts         = j.attempts + 1,
      locked_by        = p_worker_id,
      locked_at        = now(),
      lease_expires_at = now() + private.job_lease()
    from next_jobs
    where j.id = next_jobs.id
    returning j.*
  ), history as (
    insert into app.job_runs (job_id, user_id, attempt, worker_id)
    select id, user_id, attempts, p_worker_id from claimed
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'kind', kind, 'queue', queue, 'payload', payload,
    'attempt', attempts, 'max_attempts', max_attempts
  ) order by priority desc, id), '[]'::jsonb)
  into v_jobs
  from claimed;

  update app.workers set last_seen_at = now() where id = p_worker_id;
  return v_jobs;
  -- COMMIT happens here (the caller's autocommit): row locks are released.
  -- From now on the lease, not the lock, says who owns these jobs.
end $$;

-- Report success. Returns false if this worker no longer owns the job (its lease
-- expired and the job was re-queued or even claimed by another worker). That's
-- "fencing": a slow worker coming back from the dead can't overwrite the outcome.
create function worker.complete_job(p_worker_id text, p_job_id bigint, p_result jsonb)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_attempt int;
begin
  update app.jobs set
    status = 'succeeded', result = p_result,
    locked_by = null, locked_at = null, lease_expires_at = null
  where id = p_job_id and status = 'running' and locked_by = p_worker_id
  returning attempts into v_attempt;

  if not found then
    return false;
  end if;

  update app.job_runs set outcome = 'succeeded', finished_at = now()
  where job_id = p_job_id and attempt = v_attempt;
  update app.workers set processed = processed + 1, last_seen_at = now()
  where id = p_worker_id;
  return true;
end $$;

-- Report failure. p_retryable = false for errors that will never succeed
-- (bad input, unknown job kind): skip the remaining attempts.
create function worker.fail_job(
  p_worker_id text, p_job_id bigint, p_error text, p_retryable boolean default true
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from app.jobs
  where id = p_job_id and status = 'running' and locked_by = p_worker_id
  for update;

  if not found then
    return false; -- fenced: we lost the lease
  end if;

  perform private.fail_attempt(p_job_id, p_error, p_retryable, 'failed');
  update app.workers set failed = failed + 1, last_seen_at = now()
  where id = p_worker_id;
  return true;
end $$;

-- "I'm alive": registers the worker and extends the lease of every job it holds.
-- Returns how many leases were extended.
create function worker.heartbeat(p_worker_id text, p_queues text[], p_concurrency int)
returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  insert into app.workers (id, queues, concurrency)
  values (p_worker_id, p_queues, p_concurrency)
  on conflict (id) do update
    set last_seen_at = now(), queues = excluded.queues, concurrency = excluded.concurrency;

  update app.jobs set lease_expires_at = now() + private.job_lease()
  where status = 'running' and locked_by = p_worker_id;
  get diagnostics n = row_count;

  -- Forget workers that have been gone for a while.
  delete from app.workers where last_seen_at < now() - interval '5 minutes';
  return n;
end $$;

-- Graceful shutdown: hand back any jobs we're still holding right away
-- (instead of making them wait for the lease to expire), then deregister.
create function worker.unregister(p_worker_id text) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint;
  n    int := 0;
begin
  for v_id in
    select id from app.jobs
    where status = 'running' and locked_by = p_worker_id
    for update
  loop
    update app.jobs set status = 'queued', run_at = now(), last_error = 'Worker shut down mid-job',
      locked_by = null, locked_at = null, lease_expires_at = null
    where id = v_id;
    update app.job_runs set outcome = 'lost', error = 'Worker shut down mid-job', finished_at = now()
    where job_id = v_id and outcome = 'running';
    n := n + 1;
  end loop;

  delete from app.workers where id = p_worker_id;
  return n;
end $$;

-- =============================================================================
-- The dashboard API (called by the web backend as app_api)
-- =============================================================================

-- args: { kind, payload?, queue?, priority?, max_attempts?, delay_seconds?, count? }
create function api.enqueue_job(args jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.require_uid();
  v_count int  := coalesce((args->>'count')::int, 1);
  v_ids   bigint[];
begin
  if v_count not between 1 and 500 then
    raise exception 'count must be between 1 and 500' using errcode = '22023';
  end if;

  with inserted as (
    insert into app.jobs (user_id, queue, kind, payload, priority, max_attempts, run_at)
    select v_uid,
           coalesce(args->>'queue', 'default'),
           args->>'kind',
           coalesce(args->'payload', '{}'::jsonb),
           coalesce((args->>'priority')::int, 0),
           coalesce((args->>'max_attempts')::int, 5),
           now() + make_interval(secs => coalesce((args->>'delay_seconds')::float8, 0))
    from generate_series(1, v_count)
    returning id
  )
  select array_agg(id order by id) into v_ids from inserted;

  return jsonb_build_object('enqueued', v_count, 'ids', to_jsonb(v_ids));
exception
  when check_violation or not_null_violation then
    raise exception 'Invalid job: %', sqlerrm using errcode = '22023';
end $$;

-- args: { status?, limit? }. SECURITY INVOKER: RLS shows only your jobs.
create function api.list_jobs(args jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_limit int := least(coalesce((args->>'limit')::int, 50), 200);
begin
  perform auth.require_uid();
  return coalesce((
    select jsonb_agg(to_jsonb(j) - 'user_id' order by j.id desc)
    from (
      select * from app.jobs
      where args->>'status' is null or status = args->>'status'
      order by id desc
      limit v_limit
    ) j
  ), '[]'::jsonb);
end $$;

-- args: { id }. The job plus every attempt it took.
create function api.get_job(args jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_job jsonb;
begin
  perform auth.require_uid();
  select to_jsonb(j) - 'user_id' into v_job from app.jobs j where id = (args->>'id')::bigint;
  if v_job is null then
    raise exception 'Job not found' using errcode = 'P0002';
  end if;
  return v_job || jsonb_build_object('runs', coalesce((
    select jsonb_agg(to_jsonb(r) - 'user_id' order by r.attempt)
    from app.job_runs r where r.job_id = (args->>'id')::bigint
  ), '[]'::jsonb));
end $$;

-- Everything the dashboard's header needs, in one round trip.
-- SECURITY DEFINER because it also reads app.workers (infrastructure, not user
-- data), so it must filter by user explicitly.
create function api.job_stats(args jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.require_uid();
begin
  return jsonb_build_object(
    'server_time', now(),
    'counts', (
      select jsonb_build_object(
        'ready',     count(*) filter (where status = 'queued' and run_at <= now()),
        'scheduled', count(*) filter (where status = 'queued' and run_at > now()),
        'running',   count(*) filter (where status = 'running'),
        'succeeded', count(*) filter (where status = 'succeeded'),
        'failed',    count(*) filter (where status = 'failed'),
        'cancelled', count(*) filter (where status = 'cancelled')
      )
      from app.jobs where user_id = v_uid
    ),
    -- Finished attempts per minute, last 15 minutes.
    'throughput', (
      select jsonb_agg(to_jsonb(per_minute) order by per_minute.minute)
      from (
        select m.minute,
               count(r.id) filter (where r.outcome = 'succeeded')        as succeeded,
               count(r.id) filter (where r.outcome in ('failed', 'lost')) as failed
        from generate_series(date_trunc('minute', now()) - interval '14 minutes',
                             date_trunc('minute', now()), interval '1 minute') as m(minute)
        left join app.job_runs r
          on r.user_id = v_uid
         and r.finished_at >= m.minute and r.finished_at < m.minute + interval '1 minute'
        group by m.minute
      ) per_minute
    ),
    'workers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', w.id, 'queues', w.queues, 'concurrency', w.concurrency,
        'started_at', w.started_at, 'last_seen_at', w.last_seen_at,
        'online', w.last_seen_at > now() - private.job_lease(),
        'processed', w.processed, 'failed', w.failed,
        'running', (select count(*) from app.jobs j where j.status = 'running' and j.locked_by = w.id)
      ) order by w.last_seen_at > now() - private.job_lease() desc, w.started_at)
      from app.workers w
    ), '[]'::jsonb)
  );
end $$;

-- args: { id }. "Run it again now": a failed/cancelled job, or a queued one that
-- is waiting out its backoff. A job that used up its attempts gets one more.
create function api.retry_job(args jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job app.jobs;
begin
  update app.jobs set status = 'queued', run_at = now()
  where id = (args->>'id')::bigint
    and user_id = auth.require_uid()
    and status in ('failed', 'cancelled', 'queued')
  returning * into v_job;

  if not found then
    raise exception 'Job not found or not retryable' using errcode = 'P0002';
  end if;
  return to_jsonb(v_job) - 'user_id';
end $$;

-- args: { id }. Only jobs that haven't started. (Cancelling a RUNNING job would
-- need the worker's cooperation: the database can't stop code running elsewhere.)
create function api.cancel_job(args jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job app.jobs;
begin
  update app.jobs set status = 'cancelled'
  where id = (args->>'id')::bigint and user_id = auth.require_uid() and status = 'queued'
  returning * into v_job;

  if not found then
    raise exception 'Job not found or already started' using errcode = 'P0002';
  end if;
  return to_jsonb(v_job) - 'user_id';
end $$;

-- Delete your finished jobs (succeeded, failed, cancelled).
create function api.purge_jobs(args jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  delete from app.jobs
  where user_id = auth.require_uid() and status in ('succeeded', 'failed', 'cancelled');
  get diagnostics n = row_count;
  return jsonb_build_object('deleted', n);
end $$;

-- ---------- Privileges ----------

-- `grant ... on all functions` in 04_api.sql only covered functions that
-- existed back then, so grant the new api functions explicitly.
grant execute on function
  api.enqueue_job(jsonb), api.list_jobs(jsonb), api.get_job(jsonb), api.job_stats(jsonb),
  api.retry_job(jsonb), api.cancel_job(jsonb), api.purge_jobs(jsonb)
to app_api;

-- Read-only, and RLS limits it to the caller's own rows.
grant select on app.jobs, app.job_runs to app_api;

-- The worker role: its schema's functions, and that's all.
grant usage on schema worker to app_worker;
grant execute on all functions in schema worker to app_worker;
