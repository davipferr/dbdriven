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

-- ---------- Privileges for the backend role ----------
-- This list is the complete set of things app_api can do. Nothing else.

grant usage on schema api, auth, app to app_api;

grant execute on all functions in schema api to app_api;
grant execute on function auth.uid(), auth.require_uid() to app_api;

-- Needed because the todo functions are SECURITY INVOKER. RLS still limits the rows.
grant select, insert, update, delete on app.todos to app_api;

-- Deliberately NOT granted: anything on app.users, or anything in schema private.
