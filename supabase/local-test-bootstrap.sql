-- VANILLA POSTGRES TESTS ONLY. Never execute this file in Supabase/cloud environments.
-- Caller must explicitly opt in: SET tastecase.local_test = 'on';
DO $$
BEGIN
  IF current_setting('tastecase.local_test', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Local test bootstrap requires tastecase.local_test=on';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  CREATE SCHEMA IF NOT EXISTS auth;
  IF to_regprocedure('auth.uid()') IS NULL THEN
    EXECUTE $definition$
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $body$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $body$
    $definition$;
  END IF;
END;
$$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
