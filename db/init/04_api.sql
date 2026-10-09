-- =============================================================================
-- 04_api.sql: the public API. These are the ONLY things the backend can call.
--
-- Convention: every api function takes one `args jsonb` and returns jsonb.
-- The backend maps   POST /api/rpc/<name>  {json body}
--                to   select api.<name>('<json body>'::jsonb)
--
-- Two kinds of functions:
--   SECURITY DEFINER (signup/login/me): run as postgres, so they can touch
--     app.users, which app_api has no access to. Must validate carefully!
--   SECURITY INVOKER (the default; the todo functions): run as app_api,
--     so Row Level Security applies to everything they do.
-- =============================================================================

-- ---------- Auth ----------

create function api.signup(args jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_email    text := lower(trim(args->>'email'));
  v_password text := args->>'password';
  v_user     app.users;
begin
  if v_password is null or length(v_password) < 8 then
    raise exception 'Password must be at least 8 characters' using errcode = '22023';
  end if;

  insert into app.users (email, password_hash)
  values (v_email, public.crypt(v_password, public.gen_salt('bf'))) -- bcrypt
  returning * into v_user;

  return private.issue_token(v_user.id, v_user.email);
exception
  when unique_violation then
    raise exception 'Email already registered' using errcode = '23505';
  when check_violation or not_null_violation then
    raise exception 'Invalid email' using errcode = '22023';
end $$;

create function api.login(args jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user app.users;
begin
  select * into v_user from app.users where email = lower(trim(args->>'email'));

  -- `is distinct from` instead of `<>`: if password were NULL, crypt() returns
  -- NULL and `hash <> NULL` is NULL (not true), which would let the login through!
  if not found or v_user.password_hash is distinct from
                  public.crypt(args->>'password', v_user.password_hash) then
    raise exception 'Invalid email or password' using errcode = '28000';
  end if;

  return private.issue_token(v_user.id, v_user.email);
end $$;

create function api.me(args jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', id, 'email', email)
  from app.users
  where id = auth.require_uid();
$$;

-- ---------- Todos (SECURITY INVOKER: RLS does the filtering) ----------

create function api.list_todos(args jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  perform auth.require_uid();
  -- No "where user_id = ..." here: RLS adds it for us.
  return coalesce(
    (select jsonb_agg(to_jsonb(t) order by t.created_at desc) from app.todos t),
    '[]'::jsonb
  );
end $$;

create function api.add_todo(args jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_todo app.todos;
begin
  perform auth.require_uid();
  insert into app.todos (title) values (args->>'title') -- user_id defaults to auth.uid()
  returning * into v_todo;
  return to_jsonb(v_todo);
end $$;

create function api.set_todo_done(args jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_todo app.todos;
begin
  perform auth.require_uid();
  update app.todos
  set done = (args->>'done')::boolean
  where id = (args->>'id')::bigint
  returning * into v_todo;

  -- Someone else's todo looks exactly like a missing one (RLS hides it).
  if not found then
    raise exception 'Todo not found' using errcode = 'P0002';
  end if;
  return to_jsonb(v_todo);
end $$;

create function api.delete_todo(args jsonb) returns jsonb
language plpgsql set search_path = '' as $$
begin
  perform auth.require_uid();
  delete from app.todos where id = (args->>'id')::bigint;
  if not found then
    raise exception 'Todo not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('deleted', (args->>'id')::bigint);
end $$;

-- ---------- Query builder: user-built queries, run safely ----------
--
-- The browser never sends SQL. It sends a JSON description of the query (an AST):
--   { "from": "todos",
--     "select":  ["id", "title"],
--     "where":   [{ "column": "done", "op": "=", "value": "false" }],
--     "orderBy": { "column": "created_at", "dir": "desc" },
--     "limit":   20 }
-- and api.run_query rebuilds the SQL from it, here, behind two independent locks:
--   1. a WHITELIST decides what SHAPE of query is allowed (columns, operators);
--   2. RLS + GRANTs decide which ROWS and TABLES are reachable at all. The function
--      is SECURITY INVOKER, so even a bug in it only ever sees the caller's todos,
--      and app.users isn't granted to app_api, so password hashes are unreachable.

-- The whitelist, as data. The React builder fetches it too, so the dropdowns
-- and the server's checks can never disagree. Columns NOT listed (user_id) are
-- simply not queryable. `type` is used to cast values; `ops` per column means
-- you can't ask for `done ilike ...` (which Postgres would reject anyway).
create function api.query_schema(args jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'table',    'todos',
    'maxLimit', 100,
    'columns',  jsonb_build_array(
      jsonb_build_object('name', 'id',           'type', 'bigint',      'ops', '["=","<>","<",">","<=",">="]'::jsonb),
      jsonb_build_object('name', 'title',        'type', 'text',        'ops', '["=","<>","ilike","not ilike"]'::jsonb),
      jsonb_build_object('name', 'done',         'type', 'boolean',     'ops', '["=","<>"]'::jsonb),
      jsonb_build_object('name', 'completed_at', 'type', 'timestamptz', 'ops', '["<",">","<=",">=","is null","is not null"]'::jsonb),
      jsonb_build_object('name', 'created_at',   'type', 'timestamptz', 'ops', '["<",">","<=",">="]'::jsonb),
      jsonb_build_object('name', 'updated_at',   'type', 'timestamptz', 'ops', '["<",">","<=",">="]'::jsonb)
    )
  );
$$;

-- Returns { sql, rows }: the SQL Postgres actually ran (compare it with the
-- browser's preview) and the result rows.
--
-- How each piece reaches the SQL text, via format():
--   %I  identifiers (column names): quoted as ONE name, never two commands.
--   %L  values: quoted as ONE string literal. `'; delete from app.todos --`
--       becomes a harmless string to compare against.
--   %s  raw text: ONLY for things we chose ourselves (operators and types from
--       the whitelist above, 'asc'/'desc', an integer limit), never user text.
create function api.run_query(args jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_schema  jsonb := api.query_schema('{}');
  v_columns jsonb; -- { "<name>": { name, type, ops } } for O(1) lookups
  v_select  text[] := '{}';
  v_where   text[] := '{}';
  v_order   text   := '';
  v_limit   int;
  v_sql     text;
  v_rows    jsonb;
  c         text;
  f         jsonb;
  v_col     jsonb;
begin
  perform auth.require_uid();

  select jsonb_object_agg(col->>'name', col) into v_columns
  from jsonb_array_elements(v_schema->'columns') col;

  -- Reject anything we don't understand instead of silently ignoring it.
  if jsonb_typeof(args) is distinct from 'object' then
    raise exception 'Query must be a JSON object' using errcode = '22023';
  end if;
  select k into c from jsonb_object_keys(args) k
  where k not in ('from', 'select', 'where', 'orderBy', 'limit') limit 1;
  if c is not null then
    raise exception 'Unknown query key: %', c using errcode = '22023';
  end if;

  -- FROM: one table for now. It's still checked, not interpolated.
  if coalesce(args->>'from', 'todos') <> (v_schema->>'table') then
    raise exception 'Unknown table: %', args->>'from' using errcode = '22023';
  end if;

  -- SELECT: every column must be in the whitelist.
  -- Note `if (check) is not true` rather than `if not check`: comparisons with
  -- NULL return NULL, and `if NULL` counts as false. With `if not v_columns ? c`
  -- (or `if c <> all(allowed)`), a JSON null column would skip the error.
  if args ? 'select' then
    if jsonb_typeof(args->'select') <> 'array' then
      raise exception '"select" must be an array of column names' using errcode = '22023';
    end if;
    for c in select jsonb_array_elements_text(args->'select') loop
      if (v_columns ? c) is not true then
        raise exception 'Unknown column: %', c using errcode = '22023';
      end if;
      v_select := v_select || format('%I', c);
    end loop;
  end if;
  if cardinality(v_select) = 0 then
    -- Nothing picked = every whitelisted column (never `*`, which includes user_id).
    select array_agg(format('%I', col->>'name')) into v_select
    from jsonb_array_elements(v_schema->'columns') col;
  end if;

  -- WHERE: column and operator whitelisted, the value always a literal (%L) cast
  -- to the column's type. A bad value ("abc" for a bigint) fails the cast: 400.
  if args ? 'where' and jsonb_typeof(args->'where') <> 'array' then
    raise exception '"where" must be an array of filters' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(args->'where', '[]')) > 10 then
    raise exception 'At most 10 filters' using errcode = '22023';
  end if;
  for f in select jsonb_array_elements(coalesce(args->'where', '[]')) loop
    if jsonb_typeof(f) <> 'object' or (v_columns ? (f->>'column')) is not true then
      raise exception 'Unknown filter column: %', f->>'column' using errcode = '22023';
    end if;
    v_col := v_columns->(f->>'column');
    if ((v_col->'ops') ? (f->>'op')) is not true then
      raise exception 'Operator % is not allowed on %', f->>'op', f->>'column' using errcode = '22023';
    end if;

    if f->>'op' in ('is null', 'is not null') then
      v_where := v_where || format('%I %s', f->>'column', f->>'op');
    elsif f->>'value' is null then
      raise exception 'Filter on % needs a value', f->>'column' using errcode = '22023';
    else
      v_where := v_where || format('%I %s %L::%s', f->>'column', f->>'op', f->>'value', v_col->>'type');
    end if;
  end loop;

  -- ORDER BY: whitelisted column, direction is one of two words we type ourselves.
  if args->'orderBy' is not null and args->'orderBy' <> 'null' then
    if (v_columns ? (args->'orderBy'->>'column')) is not true then
      raise exception 'Unknown sort column: %', args->'orderBy'->>'column' using errcode = '22023';
    end if;
    if coalesce(args->'orderBy'->>'dir', 'asc') not in ('asc', 'desc') then
      raise exception 'Sort direction must be asc or desc' using errcode = '22023';
    end if;
    v_order := format(' order by %I %s', args->'orderBy'->>'column',
                      coalesce(args->'orderBy'->>'dir', 'asc'));
  end if;

  -- LIMIT: an int (a non-number fails the cast), clamped to 1..maxLimit.
  v_limit := least(greatest(coalesce((args->>'limit')::int, 50), 1), (v_schema->>'maxLimit')::int);

  v_sql := format('select %s from app.%I', array_to_string(v_select, ', '), v_schema->>'table')
        || case when cardinality(v_where) > 0
                then ' where ' || array_to_string(v_where, ' and ') else '' end
        || v_order
        || format(' limit %s', v_limit);

  -- Runs as app_api (SECURITY INVOKER): RLS adds "and user_id = <you>" on its own.
  execute format('select coalesce(jsonb_agg(to_jsonb(q)), ''[]'') from (%s) q', v_sql)
  into v_rows;

  return jsonb_build_object('sql', v_sql, 'rows', v_rows);
end $$;

-- ---------- Privileges for the backend role ----------
-- This list is the complete set of things app_api can do. Nothing else.

grant usage on schema api, auth, app to app_api;

grant execute on all functions in schema api to app_api;
grant execute on function auth.uid(), auth.require_uid() to app_api;

-- Needed because the todo functions are SECURITY INVOKER. RLS still limits the rows.
grant select, insert, update, delete on app.todos to app_api;

-- Deliberately NOT granted: anything on app.users, or anything in schema private.
