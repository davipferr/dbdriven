-- =============================================================================
-- 00_setup.sql: extensions, schemas, roles
-- Runs as the "postgres" superuser, only on the first start of the container.
-- =============================================================================

-- pgcrypto gives us: crypt()/gen_salt() for password hashing,
-- hmac() for signing JWTs, gen_random_bytes() for the secret.
create extension if not exists pgcrypto schema public;

-- Schemas organize the database by "who is allowed to touch what":
--   private: secrets and internal helpers. The backend can NEVER access it.
--   auth:    who is the current user? (token helpers)
--   app:     the tables (the data itself)
--   api:     the public interface. The backend may ONLY call functions in here.
create schema private;
create schema auth;
create schema app;
create schema api;

-- By default Postgres lets EVERYONE (the PUBLIC pseudo-role) execute any new
-- function. We flip that: from now on, functions are private unless granted.
alter default privileges revoke execute on functions from public;

-- The ONLY role the backend logs in as. It owns nothing and starts with
-- no privileges; 04_api.sql grants exactly what it needs.
-- (Hard-coded password = fine for local learning, never for production.)
create role app_api login password 'app_api_dev_password';
