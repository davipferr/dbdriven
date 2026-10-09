-- =============================================================================
-- 02_schema.sql: tables, constraints and Row Level Security
-- =============================================================================

create table app.users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique
                check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  password_hash text not null,
  created_at    timestamptz not null default now()
);

create table app.todos (
  id           bigint generated always as identity primary key,
  -- The owner is filled in automatically from the token, so the client can't lie about it.
  user_id      uuid not null default auth.uid() references app.users (id) on delete cascade,
  title        text not null check (length(trim(title)) between 1 and 200),
  done         boolean not null default false,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, user_id) -- target for app.todo_tags' "same owner" foreign key
);

create index on app.todos (user_id);

-- Tags: a todo can have many tags, a tag can be on many todos (many-to-many),
-- so the links live in their own table, app.todo_tags.
create table app.tags (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references app.users (id) on delete cascade,
  name       text not null check (name = lower(name) and name ~ '^[[:alnum:]][[:alnum:]_-]{0,29}$'),
  created_at timestamptz not null default now(),
  unique (user_id, name),
  unique (id, user_id)
);

create table app.todo_tags (
  todo_id bigint not null,
  tag_id  bigint not null,
  user_id uuid not null default auth.uid(),
  primary key (todo_id, tag_id),
  -- Composite foreign keys: the todo AND the tag must belong to the same user as
  -- the link. Foreign key checks ignore RLS, so with plain `todo_id references
  -- app.todos (id)` you could tag someone else's todo just by guessing its id.
  foreign key (todo_id, user_id) references app.todos (id, user_id) on delete cascade,
  foreign key (tag_id, user_id)  references app.tags (id, user_id) on delete cascade
);

-- The primary key (todo_id, tag_id) already serves "tags of this todo";
-- this one serves "todos with this tag".
create index on app.todo_tags (tag_id);

-- -----------------------------------------------------------------------------
-- Row Level Security (RLS)
--
-- With RLS on, every SELECT/INSERT/UPDATE/DELETE on app.todos from a non-owner
-- role (like app_api) is silently filtered by the policies below:
--   USING      -> which existing rows you can see / update / delete
--   WITH CHECK -> which rows you're allowed to write
-- So `select * from app.todos` only returns YOUR todos. The query doesn't need
-- a WHERE clause, and a bug in a query can't leak other users' data.
--
-- `(select auth.uid())` rather than `auth.uid()` makes Postgres evaluate it once
-- per query instead of once per row (a common RLS performance trick).
-- -----------------------------------------------------------------------------
alter table app.todos enable row level security;

create policy todos_owner_only on app.todos
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter table app.tags enable row level security;
alter table app.todo_tags enable row level security;

create policy tags_owner_only on app.tags
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy todo_tags_owner_only on app.todo_tags
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Note: app.users has NO grants for app_api at all (see 04_api.sql). Password
-- hashes are only reachable through SECURITY DEFINER functions like api.login.
