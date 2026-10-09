-- =============================================================================
-- 06_query_builder.sql: run user-built queries safely
--
-- The browser never sends SQL. It sends a JSON description of the query (an AST):
--
--   { "from":    "todos",
--     "join":    { "table": "tags", "type": "inner" },          -- optional
--     "select":  ["tags.name", { "fn": "count", "column": "*" }],
--     "where":   [{ "column": "todos.done", "op": "=", "value": "false" }],
--     "groupBy": ["tags.name"],
--     "orderBy": { "fn": "count", "column": "*", "dir": "desc" },
--     "limit":   20 }
--
-- and qb.build() turns it back into SQL here, behind two independent locks:
--   1. a WHITELIST (qb.schema) decides what SHAPE of query is allowed: which
--      tables, columns, operators, joins and aggregates;
--   2. RLS + GRANTs decide which ROWS and TABLES are reachable at all. The api
--      functions are SECURITY INVOKER, so even a bug in qb.build only ever sees
--      the caller's rows, and app.users isn't granted to app_api at all.
--
-- How each piece reaches the SQL text, via format():
--   %I  identifiers (column/table names): quoted as ONE name, never two commands.
--   %L  values: quoted as ONE string literal. `'; delete from app.todos --`
--       becomes a harmless string to compare against.
--   %s  raw text: ONLY for things that come from qb.schema() (operators, types,
--       aggregate names, join conditions), 'asc'/'desc', or fragments that were
--       themselves built with %I. Never text straight from the request.
-- =============================================================================

-- The compiler's internals. app_api can execute them (the api functions below
-- run as app_api), but the gateway only ever calls api.*, so they're not
-- reachable over HTTP.
create schema qb;

-- The whitelist, as data. The React builder fetches it (api.query_schema), so
-- its dropdowns offer exactly what qb.build accepts. Columns NOT listed (user_id)
-- can't be selected, filtered, grouped or sorted on.
create function qb.schema() returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'from',     'todos',
    'maxLimit', 100,
    -- Per column: its type (to cast filter values) and the operators that make sense.
    'tables', jsonb_build_object(
      'todos', jsonb_build_array(
        jsonb_build_object('name', 'id',           'type', 'bigint',      'ops', '["=","<>","<",">","<=",">="]'::jsonb),
        jsonb_build_object('name', 'title',        'type', 'text',        'ops', '["=","<>","ilike","not ilike"]'::jsonb),
        jsonb_build_object('name', 'done',         'type', 'boolean',     'ops', '["=","<>"]'::jsonb),
        jsonb_build_object('name', 'completed_at', 'type', 'timestamptz', 'ops', '["<",">","<=",">=","is null","is not null"]'::jsonb),
        jsonb_build_object('name', 'created_at',   'type', 'timestamptz', 'ops', '["<",">","<=",">="]'::jsonb),
        jsonb_build_object('name', 'updated_at',   'type', 'timestamptz', 'ops', '["<",">","<=",">="]'::jsonb)
      ),
      -- "is null" on tags.id: with a LEFT JOIN, that's "todos without tags".
      'tags', jsonb_build_array(
        jsonb_build_object('name', 'id',         'type', 'bigint',      'ops', '["=","<>","is null","is not null"]'::jsonb),
        jsonb_build_object('name', 'name',       'type', 'text',        'ops', '["=","<>","ilike","not ilike"]'::jsonb),
        jsonb_build_object('name', 'created_at', 'type', 'timestamptz', 'ops', '["<",">","<=",">="]'::jsonb)
      )
    ),
    -- The client picks a join by NAME. The ON conditions live here, never in the
    -- request: todos and tags meet through the link table app.todo_tags.
    'joins', jsonb_build_object(
      'tags', jsonb_build_object(
        'types', '["inner","left"]'::jsonb,
        'steps', jsonb_build_array(
          jsonb_build_object('table', 'todo_tags', 'on', 'todo_tags.todo_id = todos.id'),
          jsonb_build_object('table', 'tags',      'on', 'tags.id = todo_tags.tag_id')
        )
      )
    ),
    -- Aggregate -> what it accepts ("*" = count(*)). No min/max on booleans:
    -- Postgres has no max(boolean).
    'aggregates', jsonb_build_object(
      'count', '["*","bigint","text","boolean","timestamptz"]'::jsonb,
      'min',   '["bigint","text","timestamptz"]'::jsonb,
      'max',   '["bigint","text","timestamptz"]'::jsonb
    )
  );
$$;

-- Raises unless every key of p_obj is in p_allowed. Unknown keys are rejected
-- rather than ignored: `{"join": {"table": "tags", "on": "true"}}` should fail
-- loudly, not run a query that silently differs from what was asked.
create function qb.check_keys(p_obj jsonb, p_allowed text[], p_what text) returns void
language plpgsql immutable set search_path = '' as $$
declare
  k text;
begin
  if jsonb_typeof(p_obj) is distinct from 'object' then
    raise exception '% must be a JSON object', p_what using errcode = '22023';
  end if;
  select x into k from jsonb_object_keys(p_obj) x where x <> all (p_allowed) limit 1;
  if k is not null then
    raise exception 'Unknown key in %: %', p_what, k using errcode = '22023';
  end if;
end $$;

-- Resolves "table.column" against the whitelist, for the tables in this query.
-- Returns the column's whitelist entry plus:
--   key:   "todos.title" (canonical, used for the GROUP BY check)
--   sql:   how to write it: plain `title` with one table, `todos.title` with a join
--   label: the same, unquoted, for the results table header
--
-- Note `if (check) is not true` rather than `if not check`: comparisons with
-- NULL return NULL, and `if NULL` counts as false. `if not (x = any(allowed))`
-- would let a JSON null column straight through.
create function qb.column(p_schema jsonb, p_tables text[], p_ref text) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_table text := split_part(p_ref, '.', 1);
  v_name  text := split_part(p_ref, '.', 2);
  v_col   jsonb;
begin
  -- The second half rejects "todos.title.extra" and other near-misses.
  if (v_table = any (p_tables) and p_ref = v_table || '.' || v_name) is not true then
    raise exception 'Unknown column: % (write table.column, using: %)',
      coalesce(p_ref, 'null'), array_to_string(p_tables, ', ') using errcode = '22023';
  end if;

  select col into v_col
  from jsonb_array_elements(p_schema->'tables'->v_table) col
  where col->>'name' = v_name;
  if v_col is null then
    raise exception 'Unknown column: %', p_ref using errcode = '22023';
  end if;

  return v_col || jsonb_build_object(
    'key',   p_ref,
    'sql',   case when cardinality(p_tables) > 1 then format('%I.%I', v_table, v_name) else format('%I', v_name) end,
    'label', case when cardinality(p_tables) > 1 then p_ref else v_name end
  );
end $$;

-- One item of the SELECT list (or the ORDER BY): either "table.column" or an
-- aggregate { "fn": "count", "column": "*" | "table.column" }.
-- Returns { sql, label, aggregate, key? }.
create function qb.select_item(p_schema jsonb, p_tables text[], p_item jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_fn  text := p_item->>'fn';
  v_col jsonb;
begin
  if jsonb_typeof(p_item) = 'string' then
    return qb.column(p_schema, p_tables, p_item #>> '{}') || '{"aggregate": false}';
  end if;

  if (jsonb_typeof(p_item) = 'object' and p_item ? 'fn') is not true then
    raise exception 'Expected "table.column" or {"fn": ..., "column": ...}, got %',
      coalesce(p_item::text, 'nothing') using errcode = '22023';
  end if;
  perform qb.check_keys(p_item, array['fn', 'column'], 'aggregate');
  if (p_schema->'aggregates' ? v_fn) is not true then
    raise exception 'Unknown aggregate: %', v_fn using errcode = '22023';
  end if;

  if p_item->>'column' = '*' then
    if (p_schema->'aggregates'->v_fn ? '*') is not true then
      raise exception '%() needs a column, not *', v_fn using errcode = '22023';
    end if;
    return jsonb_build_object('sql', v_fn || '(*)', 'label', v_fn || '(*)', 'aggregate', true);
  end if;

  v_col := qb.column(p_schema, p_tables, p_item->>'column');
  if (p_schema->'aggregates'->v_fn ? (v_col->>'type')) is not true then
    raise exception '%() does not work on % (a %)', v_fn, v_col->>'key', v_col->>'type'
      using errcode = '22023';
  end if;
  -- v_fn is a whitelisted name, v_col->>'sql' was built with %I: both safe for %s.
  return jsonb_build_object(
    'sql',       format('%s(%s)', v_fn, v_col->>'sql'),
    'label',     format('%s(%s)', v_fn, v_col->>'label'),
    'aggregate', true
  );
end $$;

-- The compiler: AST in, { sql, columns } out. It validates everything and
-- runs nothing.
create function qb.build(args jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  s         jsonb  := qb.schema();
  v_from    text   := s->>'from';
  v_tables  text[];
  v_join    text   := '';
  v_jtype   text;
  v_items   jsonb  := '[]'; -- resolved SELECT items, in order
  v_where   text[] := '{}';
  v_groups  text[] := '{}'; -- GROUP BY, as SQL
  v_gkeys   text[] := '{}'; -- GROUP BY, as "table.column" keys
  v_order   jsonb;          -- resolved ORDER BY item
  v_dir     text;
  v_grouped boolean;
  v_limit   int;
  v_sql     text;
  k         text;
  f         jsonb;
  v_col     jsonb;
begin
  -- Reject anything we don't understand instead of silently ignoring it.
  perform qb.check_keys(args, array['from', 'join', 'select', 'where', 'groupBy', 'orderBy', 'limit'], 'query');
  foreach k in array array['select', 'where', 'groupBy'] loop
    if args ? k and jsonb_typeof(args->k) <> 'array' then
      raise exception '"%" must be an array', k using errcode = '22023';
    end if;
  end loop;

  -- FROM: checked, not interpolated.
  if coalesce(args->>'from', v_from) <> v_from then
    raise exception 'Unknown table: %', args->>'from' using errcode = '22023';
  end if;
  v_tables := array[v_from];

  -- JOIN: the client names a join from the whitelist and picks inner or left.
  if args->'join' is not null and args->'join' <> 'null' then
    perform qb.check_keys(args->'join', array['table', 'type'], 'join');
    if (s->'joins' ? (args->'join'->>'table')) is not true then
      raise exception 'Unknown join: %', args->'join' using errcode = '22023';
    end if;
    v_jtype := coalesce(args->'join'->>'type', 'inner');
    if (s->'joins'->(args->'join'->>'table')->'types' ? v_jtype) is not true then
      raise exception 'Join type must be inner or left' using errcode = '22023';
    end if;
    v_tables := v_tables || (args->'join'->>'table');
    for f in select jsonb_array_elements(s->'joins'->(args->'join'->>'table')->'steps') loop
      -- `on` comes from qb.schema(), never from the request: safe for %s.
      v_join := v_join || format(' %s join app.%I on %s', v_jtype, f->>'table', f->>'on');
    end loop;
  end if;

  -- GROUP BY
  for f in select jsonb_array_elements(coalesce(args->'groupBy', '[]')) loop
    v_col := qb.column(s, v_tables, f #>> '{}');
    v_groups := v_groups || (v_col->>'sql');
    v_gkeys  := v_gkeys  || (v_col->>'key');
  end loop;

  -- SELECT
  for f in select jsonb_array_elements(coalesce(args->'select', '[]')) loop
    v_items := v_items || jsonb_build_array(qb.select_item(s, v_tables, f));
  end loop;

  -- ORDER BY: a column, or an aggregate (e.g. count(*) desc).
  if args->'orderBy' is not null and args->'orderBy' <> 'null' then
    perform qb.check_keys(args->'orderBy', array['fn', 'column', 'dir'], 'orderBy');
    v_dir := coalesce(args->'orderBy'->>'dir', 'asc');
    if v_dir not in ('asc', 'desc') then
      raise exception 'Sort direction must be asc or desc' using errcode = '22023';
    end if;
    v_order := qb.select_item(s, v_tables,
      case when args->'orderBy' ? 'fn' then (args->'orderBy') - 'dir' -- parens: `-` binds tighter than `->`
           else coalesce(args->'orderBy'->'column', 'null') end);
  end if;

  -- Any GROUP BY or aggregate turns this into a grouped query: one result row
  -- per group instead of per todo.
  v_grouped := cardinality(v_groups) > 0
            or exists (select 1 from jsonb_array_elements(v_items) i where (i->>'aggregate')::boolean)
            or coalesce((v_order->>'aggregate')::boolean, false);

  -- Nothing picked: the group keys + count(*), or every column in scope (never
  -- `*`, which would include user_id).
  if jsonb_array_length(v_items) = 0 then
    if v_grouped then
      foreach k in array v_gkeys loop
        v_items := v_items || jsonb_build_array(qb.select_item(s, v_tables, to_jsonb(k)));
      end loop;
      v_items := v_items || jsonb_build_array(qb.select_item(s, v_tables, '{"fn": "count", "column": "*"}'));
    else
      for k in
        select t.name || '.' || (c.col->>'name')
        from unnest(v_tables) with ordinality t(name, n),
             jsonb_array_elements(s->'tables'->t.name) with ordinality c(col, m)
        order by t.n, c.m
      loop
        v_items := v_items || jsonb_build_array(qb.select_item(s, v_tables, to_jsonb(k)));
      end loop;
    end if;
  end if;

  -- In a grouped query every plain column must be a group key: "show the title"
  -- means nothing when one row stands for many todos. Postgres would raise the
  -- same error (42803), but checking here gives a clear 400 instead of a 500.
  -- (Postgres is a bit smarter: grouping by a primary key lets you select the
  -- rest of that table's columns. This check is deliberately simpler.)
  if v_grouped then
    for f in
      select i from jsonb_array_elements(
        v_items || case when v_order is null then '[]' else jsonb_build_array(v_order) end) i
    loop
      if not (f->>'aggregate')::boolean and (f->>'key' = any (v_gkeys)) is not true then
        raise exception '% must be in GROUP BY, or inside an aggregate like count()', f->>'key'
          using errcode = '22023';
      end if;
    end loop;
  end if;

  -- WHERE: column and operator whitelisted, the value always a literal (%L) cast
  -- to the column's type. A bad value ("abc" for a bigint) fails the cast: 400.
  -- (Filtering on an aggregate, like "count(*) > 2", would be HAVING, not WHERE.)
  if jsonb_array_length(coalesce(args->'where', '[]')) > 10 then
    raise exception 'At most 10 filters' using errcode = '22023';
  end if;
  for f in select jsonb_array_elements(coalesce(args->'where', '[]')) loop
    perform qb.check_keys(f, array['column', 'op', 'value'], 'filter');
    v_col := qb.column(s, v_tables, f->>'column');
    if ((v_col->'ops') ? (f->>'op')) is not true then
      raise exception 'Operator % is not allowed on %', coalesce(f->>'op', 'null'), v_col->>'key'
        using errcode = '22023';
    end if;

    if f->>'op' in ('is null', 'is not null') then
      v_where := v_where || format('%s %s', v_col->>'sql', f->>'op');
    elsif f->>'value' is null then
      raise exception 'Filter on % needs a value', v_col->>'key' using errcode = '22023';
    else
      v_where := v_where || format('%s %s %L::%s', v_col->>'sql', f->>'op', f->>'value', v_col->>'type');
    end if;
  end loop;

  -- LIMIT: an int (a non-number fails the cast), clamped to 1..maxLimit.
  v_limit := least(greatest(coalesce((args->>'limit')::int, 50), 1), (s->>'maxLimit')::int);

  -- Clause order: SELECT, FROM, JOIN, WHERE, GROUP BY, ORDER BY, LIMIT.
  v_sql := format('select %s from app.%I',
             (select string_agg(i->>'sql', ', ' order by n) from jsonb_array_elements(v_items) with ordinality x(i, n)),
             v_from)
        || v_join
        || case when cardinality(v_where)  > 0 then ' where '    || array_to_string(v_where, ' and ') else '' end
        || case when cardinality(v_groups) > 0 then ' group by ' || array_to_string(v_groups, ', ')   else '' end
        || case when v_order is not null then format(' order by %s %s', v_order->>'sql', v_dir) else '' end
        || format(' limit %s', v_limit);

  return jsonb_build_object(
    'sql', v_sql,
    'columns', (select jsonb_agg(i->'label' order by n) from jsonb_array_elements(v_items) with ordinality x(i, n))
  );
end $$;

-- =============================================================================
-- The public API
-- =============================================================================

create function api.query_schema(args jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select qb.schema();
$$;

-- args: the AST. Returns { sql, columns, rows }: the SQL Postgres actually ran
-- (compare it with the browser's preview) and the result.
create function api.run_query(args jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_query jsonb;
  v_cols  text;
  v_rows  jsonb;
begin
  perform auth.require_uid();
  v_query := qb.build(args);

  -- Rows come back as arrays, not objects: with a join, todos.id and tags.id are
  -- both called "id", and in a JSON object one would overwrite the other.
  -- `q(c1, c2, ...)` renames the subquery's columns by position.
  select string_agg('c' || n, ', ') into v_cols
  from generate_series(1, jsonb_array_length(v_query->'columns')) n;

  -- Runs as app_api (SECURITY INVOKER): RLS adds "user_id = <you>" to every table.
  execute format('select coalesce(jsonb_agg(jsonb_build_array(%s)), ''[]'') from (%s) q(%s)',
                 v_cols, v_query->>'sql', v_cols)
  into v_rows;

  return v_query || jsonb_build_object('rows', v_rows);
end $$;

-- args: { query: <AST>, disableSeqscan?: bool }
-- EXPLAIN ANALYZE shows HOW Postgres ran the query: which indexes it used, how
-- many rows it expected vs. found, and where the time went. It really executes
-- the query, which is fine here: qb.build only ever produces a SELECT.
--
-- Volatile (the default), not stable, because it changes a setting.
create function api.explain_query(args jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_query   jsonb;
  v_plan    json;
  v_disable boolean := coalesce((args->>'disableSeqscan')::boolean, false);
  v_old     text    := current_setting('enable_seqscan');
begin
  perform auth.require_uid();
  perform qb.check_keys(args, array['query', 'disableSeqscan'], 'explain request');
  v_query := qb.build(coalesce(args->'query', '{}'));

  -- enable_seqscan = off doesn't forbid sequential scans, it makes them look
  -- absurdly expensive, so the planner picks an index whenever one can work.
  -- A way to ask "what WOULD the index plan cost?", never a production setting.
  if v_disable then
    perform set_config('enable_seqscan', 'off', true);
  end if;
  execute 'explain (analyze, format json) ' || (v_query->>'sql') into v_plan;
  perform set_config('enable_seqscan', v_old, true);

  return jsonb_build_object(
    'sql',            v_query->>'sql',
    'plan',           v_plan::jsonb->0,
    'seqscanDisabled', v_disable,
    -- The planner's inputs for the WHOLE table, every user's rows (RLS doesn't
    -- apply to catalog statistics): estimated rows (-1 = never analyzed) and
    -- 8 kB pages. A Seq Scan's cost is mostly the page count.
    'tableRows',  (select reltuples::bigint from pg_catalog.pg_class where oid = 'app.todos'::pg_catalog.regclass),
    'tablePages', (select relpages from pg_catalog.pg_class where oid = 'app.todos'::pg_catalog.regclass)
  );
end $$;

-- ---------- Demo data, so EXPLAIN has something to chew on ----------
--
-- An index only pays off when it skips MOST of the table. With just your own
-- handful of todos, reading the whole table (a Seq Scan) is cheaper than
-- visiting an index first, so Postgres won't use todos_user_id_idx.
--
-- This adds 200 other users with 100 done todos each (20,000 rows). Now your
-- rows are a tiny fraction, so finding them through the index wins. RLS hides
-- these rows from you; you'll only see them in EXPLAIN's estimates.
--
-- It needs SECURITY DEFINER (it writes other users' rows), and any logged-in
-- user can call it. Fine for a local learning project, never for production.

create function api.seed_demo_data(args jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  -- One bcrypt hash of a random password, shared by all: nobody can log in as them.
  v_hash text;
begin
  perform auth.require_uid();
  if not exists (select 1 from app.users where email like 'seed-%@example.invalid') then
    v_hash := public.crypt(gen_random_uuid()::text, public.gen_salt('bf'));

    with seeded as (
      insert into app.users (email, password_hash)
      select format('seed-%s@example.invalid', n), v_hash from generate_series(1, 200) n
      returning id
    )
    -- All done: the "20 open todos" trigger only counts open ones.
    insert into app.todos (user_id, title, done, created_at)
    select seeded.id, format('Demo todo %s', i), true, now() - random() * interval '90 days'
    from seeded cross join generate_series(1, 100) i;

    -- Refresh the planner's statistics now instead of waiting for autovacuum.
    -- The estimate for "user_id = $1" is (rows / distinct user_ids), so it's
    -- the 200 distinct users, not just the 20,000 rows, that make the index win.
    analyze app.todos;
  end if;
  return jsonb_build_object('tableRows', (select count(*) from app.todos));
end $$;

-- The deleted rows don't free their space right away: they become "dead
-- tuples" until VACUUM cleans them up (autovacuum does it within a minute or
-- so). Until then the table is still ~230 pages for a handful of live rows, a
-- Seq Scan would read them all, and Postgres keeps choosing the index. VACUUM
-- can't run inside a function (or any transaction), so we can't do it here.
create function api.remove_demo_data(args jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform auth.require_uid();
  delete from app.users where email like 'seed-%@example.invalid'; -- their todos cascade
  analyze app.todos;
  return jsonb_build_object('tableRows', (select count(*) from app.todos));
end $$;

-- ---------- Privileges ----------

-- `grant ... on all functions` in 04_api.sql only covered functions that
-- existed back then, so grant these explicitly.
grant usage on schema qb to app_api;
grant execute on all functions in schema qb to app_api;
grant execute on function
  api.query_schema(jsonb), api.run_query(jsonb), api.explain_query(jsonb),
  api.seed_demo_data(jsonb), api.remove_demo_data(jsonb)
to app_api;
