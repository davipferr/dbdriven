# DB-Driven Todos (+ a job queue)

A learning project where **PostgreSQL holds all the business logic**: auth, permissions,
validation, rules and realtime. The backend is a ~100-line gateway that doesn't
know what a "user" or a "todo" is.

```
┌────────────┐  HTTP   ┌──────────────┐   SQL    ┌──────────────────────────┐
│ React      │ ──────► │ api (Node)   │ ───────► │ PostgreSQL               │
│ (web:5173) │ ◄────── │ dumb gateway │ ◄─────── │ tables, RLS, triggers,   │
│            │   SSE   │ (api:4000)   │  NOTIFY  │ JWT, functions (db:5432) │
└────────────┘         └──────────────┘          └──────────────────────────┘
```

## Run it

```bash
docker compose up --build
```

Then open http://localhost:5173 and sign up. Open a second tab to see realtime updates.

The SQL in `db/init/` only runs when the database volume is **empty**. After changing it, reset:

```bash
docker compose down -v
```

## Where each responsibility lives

| Responsibility        | Where                                                     | File |
|-----------------------|-----------------------------------------------------------|------|
| Persistence           | `app.users`, `app.todos` tables                           | `db/init/02_schema.sql` |
| Password hashing      | `crypt()` + `gen_salt('bf')` (bcrypt) from pgcrypto        | `db/init/04_api.sql` |
| Tokens (JWT)          | Signed/verified **in SQL** with `hmac()`                  | `db/init/01_auth.sql` |
| "Who is calling?"     | `auth.uid()` reads the token from `request.jwt` setting   | `db/init/01_auth.sql` |
| Row permissions       | Row Level Security policy on `app.todos`                  | `db/init/02_schema.sql` |
| What the backend may do | `GRANT`s to the `app_api` role                          | `db/init/04_api.sql` |
| Validation            | `CHECK` constraints                                       | `db/init/02_schema.sql` |
| Business rules        | Triggers (timestamps, max 20 open todos)                  | `db/init/03_rules.sql` |
| Queries / mutations   | Functions in the `api` schema                             | `db/init/04_api.sql` |
| Realtime              | Trigger → `pg_notify` → backend `LISTEN` → SSE → browser   | `03_rules.sql`, `api/src/server.js` |
| Background jobs       | `app.jobs` + `SKIP LOCKED` workers, leases, retries        | `db/init/05_jobs.sql`, `worker/` |

## Life of a request: adding a todo

1. React calls `rpc("add_todo", { title: "Buy milk" }, token)` → `POST /api/rpc/add_todo`
2. Vite's dev proxy forwards `/api/*` to the `api` container.
3. The backend, connected as the low-privilege role `app_api`, runs:
   ```sql
   begin;
   select set_config('request.jwt', '<token>', true);   -- only for this transaction
   select api."add_todo"('{"title":"Buy milk"}'::jsonb);
   commit;
   ```
4. `api.add_todo` calls `auth.require_uid()`, which verifies the token's signature and expiry
   and returns the user id (or raises SQLSTATE `28000`, which becomes HTTP 401).
5. `insert into app.todos (title) ...` fires:
   - the column default `user_id = auth.uid()` (the client can't choose the owner)
   - the `CHECK` on title length
   - the trigger `todos_set_timestamps` (trims the title, sets timestamps)
   - the trigger `todos_enforce_open_limit` (raises an error if you already have 20 open)
   - the RLS `WITH CHECK` policy (the row must belong to you)
   - after commit, `todos_notify` publishes `{"op":"INSERT","id":..,"user_id":..}`
6. The backend's `LISTEN` connection receives it and pushes it to that user's open
   browser tabs over Server-Sent Events, and React reloads the list.

## Explore the database yourself

```bash
docker compose exec db psql -U postgres -d app
```

Then try these:

```sql
\dn                         -- schemas
\df api.*                   -- the public API
\dp app.todos               -- privileges
select * from app.todos;    -- as postgres (table owner): RLS is bypassed, you see everyone's

-- Pretend to be the backend:
set role app_api;
select * from app.todos;    -- no token -> RLS shows nothing
select * from app.users;    -- permission denied: app_api has no access
select api.login('{"email":"you@example.com","password":"yourpassword"}');
-- copy the token, then:
begin;
select set_config('request.jwt', '<paste token>', true);
select api.list_todos('{}');
select * from app.todos;    -- now you see only YOUR rows
commit;
reset role;
```

## Background jobs: a job queue in Postgres

A mini BullMQ / Sidekiq. The queue *is* a table (`app.jobs`); the workers are
plain Node processes (`worker/`) that log in as `app_worker`, a role that can
only call the `worker.*` functions. Everything lives in `db/init/05_jobs.sql`.
Open the **Jobs** tab to enqueue jobs and watch them move.

```
            api.enqueue_job                 worker.claim_jobs
React ─────► (app_api) ─────► app.jobs ◄─────────────────────── worker × 2
  ▲                             │  NOTIFY jobs_available ─────►  (app_worker)
  └──── SSE ◄── api ◄── NOTIFY job_changes                 complete_job / fail_job / heartbeat
```

| Concept | How | Where |
|---|---|---|
| Hand each job to exactly one worker | `SELECT ... FOR UPDATE SKIP LOCKED` | `worker.claim_jobs` |
| Fast "next job" query | partial index `where status = 'queued'` | `jobs_ready_idx` |
| Who owns a running job | a **lease** (`lease_expires_at`), not a long transaction | `worker.claim_jobs` |
| Long jobs stay owned | heartbeat every 5s extends the 15s lease | `worker.heartbeat` |
| Crashed worker's jobs come back | expired leases are reaped (`outcome = 'lost'`) | `private.reap_expired_jobs` |
| Retries with backoff | `run_at = now() + 2^attempt s ± 25% jitter` | `private.job_backoff` |
| Errors that retrying won't fix | `PermanentError` → straight to `failed` | `worker/src/handlers.js` |
| A slow worker can't overwrite a newer outcome | "fencing": report only if `locked_by = me` | `worker.complete_job` |
| Only legal status changes | `BEFORE UPDATE` trigger state machine | `app.jobs_check_transition` |
| Idle workers wake instantly | `NOTIFY jobs_available` (+ 1s poll fallback) | `app.jobs_notify` |
| Graceful shutdown | SIGTERM → finish, hand back the rest | `worker.unregister` |

### Why SKIP LOCKED?

Ten workers all run "give me the top 5 queued jobs" at the same instant. Without
locking, they'd all get the *same* 5. With plain `FOR UPDATE`, nine of them would
wait in line behind the first one's locks. With `SKIP LOCKED`, each one locks the
first rows nobody else holds and moves on, so they get different jobs, without waiting.

### Why at-least-once (and not exactly-once)?

A worker can finish the work (email sent!) and crash before it reports "done".
The queue can't tell this apart from "crashed before sending", so when the lease
expires it runs the job again. Jobs are never **lost**, but they can run **twice**.
So handlers must be **idempotent**: e.g. pass `job.id` as an idempotency key to
the email provider. (Exactly-once is only possible when the work and the "done"
mark commit in the same database transaction.)

### Try it

In the Jobs tab, enqueue:

- `flaky` × 10: watch attempts climb and "runs in 4s… 8s…" (backoff)
- `always_fails` with 3 attempts: ends in **failed**; click **Retry** for one more try
- `slow` (30s): outlives the 15s lease because of the heartbeat
- `crash`: kills a worker mid-job. Docker restarts it, and ~15s later the job's
  lease expires and it runs again (attempt history shows `lost`). It crashes every
  time, so it's a "poison pill" that ends in `failed` after its max attempts.
- `send_email` × 500 with 2 workers, then `docker compose up -d --scale worker=5`

```bash
docker compose logs -f worker
```

```sql
-- Watch the queue from psql (as postgres, RLS doesn't apply):
select status, count(*) from app.jobs group by 1;
select id, kind, status, attempts, locked_by, lease_expires_at - now() as lease_left
from app.jobs where status = 'running';
-- See SKIP LOCKED yourself: in two psql windows, run this in each (don't commit yet):
begin;
select id from app.jobs where status = 'queued' order by id limit 3 for update skip locked;
```

## Exercises to deepen understanding

1. Add a `priority` column with a `CHECK (priority between 1 and 3)` and expose it in `api.add_todo`.
2. Add todo sharing: a `app.todo_shares` table and a second RLS policy allowing `select` for shared users.
3. Add an `api.change_password` function (SECURITY DEFINER; verify the old password first).
4. Write tests for your RLS policies with [pgTAP](https://pgtap.org/).
5. Replace `db/init` with a real migration tool (dbmate or Sqitch), so you can change the
   schema without wiping data.

## Not production-ready (on purpose)

The following were left out to keep this a learning project:

- Hard-coded passwords in `docker-compose.yml`
- Token in the SSE query string
- No refresh tokens
- No rate limiting on login
- The Vite dev server instead of a static build
