-- =============================================================================
-- 01_auth.sql: JWT signing & verification implemented in plain SQL
--
-- A JWT is just:  base64url(header) . base64url(payload) . base64url(signature)
-- where signature = HMAC-SHA256(header . payload, secret).
-- Only the database knows the secret, so only the database can create valid
-- tokens. The backend just carries them around without understanding them.
-- =============================================================================

create table private.settings (
  key   text primary key,
  value text not null
);

-- A random secret generated once at init. Nobody outside the DB ever needs it.
insert into private.settings (key, value)
values ('jwt_secret', encode(public.gen_random_bytes(32), 'hex'));

-- base64url = base64 with "-" and "_" instead of "+" and "/", and no "=" padding.
-- (encode(..., 'base64') also inserts a newline every 76 chars; translate drops it.)
create function private.base64url_encode(data bytea) returns text
language sql immutable as $$
  select translate(rtrim(encode(data, 'base64'), '='), E'+/\n', '-_');
$$;

create function private.base64url_decode(data text) returns bytea
language sql immutable as $$
  select decode(
    rpad(translate(data, '-_', '+/'), 4 * ((length(data) + 3) / 4), '='),
    'base64'
  );
$$;

create function private.jwt_secret() returns text
language sql stable as $$
  select value from private.settings where key = 'jwt_secret';
$$;

create function private.jwt_sign(claims jsonb) returns text
language plpgsql stable as $$
declare
  header  text := private.base64url_encode(convert_to('{"alg":"HS256","typ":"JWT"}', 'utf8'));
  payload text := private.base64url_encode(convert_to(claims::text, 'utf8'));
begin
  return header || '.' || payload || '.' ||
    private.base64url_encode(public.hmac(header || '.' || payload, private.jwt_secret(), 'sha256'));
end $$;

-- Returns the token's claims if the signature is valid and it hasn't expired,
-- otherwise NULL.
create function private.jwt_verify(token text) returns jsonb
language plpgsql stable as $$
declare
  parts  text[] := string_to_array(token, '.');
  claims jsonb;
begin
  if token is null or array_length(parts, 1) <> 3 then
    return null;
  end if;

  -- Recompute the signature; if anyone tampered with header/payload it won't match.
  if parts[3] <> private.base64url_encode(
       public.hmac(parts[1] || '.' || parts[2], private.jwt_secret(), 'sha256')) then
    return null;
  end if;

  claims := convert_from(private.base64url_decode(parts[2]), 'utf8')::jsonb;
  if (claims->>'exp')::bigint < extract(epoch from now()) then
    return null; -- expired
  end if;
  return claims;
end $$;

create function private.issue_token(user_id uuid, email text) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'token', private.jwt_sign(jsonb_build_object(
      'sub',   user_id,
      'email', email,
      'exp',   extract(epoch from now() + interval '1 hour')::bigint
    )),
    'user', jsonb_build_object('id', user_id, 'email', email)
  );
$$;

-- -----------------------------------------------------------------------------
-- auth.uid(): "who is making this request?"
--
-- For every request the backend runs
--     set_config('request.jwt', '<token from the Authorization header>', true)
-- (the `true` means "only for this transaction"). This function reads that
-- setting, verifies it and returns the user id, or NULL for anonymous requests.
--
-- SECURITY DEFINER = runs with the privileges of its owner (postgres), so it can
-- read private.settings even though the caller (app_api) cannot.
-- `set search_path = ''` stops anyone from hijacking unqualified names inside
-- a SECURITY DEFINER function, which is why everything here is schema-qualified.
-- -----------------------------------------------------------------------------
create function auth.uid() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  return (private.jwt_verify(nullif(current_setting('request.jwt', true), ''))->>'sub')::uuid;
end $$;

-- Same, but raises an error when there's no valid token.
-- SQLSTATE 28000 = invalid_authorization_specification -> the backend maps it to HTTP 401.
create function auth.require_uid() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return v_uid;
end $$;
