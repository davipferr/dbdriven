# DB-Driven Todos

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
