-- =============================================================================
-- 03_rules.sql: business rules (triggers) and realtime notifications
-- =============================================================================

-- Rule: keep timestamps correct no matter who writes the row.
create function app.todos_set_timestamps() returns trigger
language plpgsql as $$
begin
  new.title      := trim(new.title);
  new.updated_at := now();

  if tg_op = 'INSERT' then
    new.completed_at := case when new.done then now() end;
  elsif new.done is distinct from old.done then
    new.completed_at := case when new.done then now() end;
  end if;

  return new;
end $$;

create trigger todos_set_timestamps
  before insert or update on app.todos
  for each row execute function app.todos_set_timestamps();

-- Rule: a user may have at most 20 open (not done) todos.
-- The error message travels all the way to the React UI.
create function app.todos_enforce_open_limit() returns trigger
language plpgsql as $$
declare
  open_count int;
begin
  if not new.done then
    select count(*) into open_count
    from app.todos
    where user_id = new.user_id and not done and id <> new.id;

    if open_count >= 20 then
      raise exception 'You can have at most 20 open todos. Finish some first!'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

create trigger todos_enforce_open_limit
  before insert or update of done on app.todos
  for each row execute function app.todos_enforce_open_limit();

-- -----------------------------------------------------------------------------
-- Realtime: after every change, publish a message on the "todo_changes" channel.
-- Any connection that ran `LISTEN todo_changes` receives it. The backend
-- listens and forwards it to the right browser over Server-Sent Events.
-- NOTIFY messages are only delivered when the transaction COMMITs, so clients
-- never hear about changes that were rolled back.
-- -----------------------------------------------------------------------------
create function app.todos_notify() returns trigger
language plpgsql as $$
declare
  r app.todos := coalesce(new, old);
begin
  perform pg_notify('todo_changes', json_build_object(
    'op',      tg_op,     -- INSERT / UPDATE / DELETE
    'id',      r.id,
    'user_id', r.user_id  -- the backend uses this to pick the recipient
  )::text);
  return null; -- the return value of AFTER triggers is ignored
end $$;

create trigger todos_notify
  after insert or update or delete on app.todos
  for each row execute function app.todos_notify();
