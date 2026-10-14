-- Verified handshake history is separate from immutable credential identity/revocation.
-- No credential values, adapter configuration or owner-controlled runner labels are copied.
CREATE TABLE IF NOT EXISTS public.runner_handshakes (
  credential_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  first_verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, credential_id) REFERENCES public.runner_credentials(project_id, id),
  CHECK (last_verified_at >= first_verified_at)
);
CREATE INDEX IF NOT EXISTS runner_handshakes_project_idx ON public.runner_handshakes(project_id);

CREATE OR REPLACE FUNCTION public.tastecase_guard_runner_handshake() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE verified_at timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Handshake history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  -- Serialize with revocation even if invoked by a privileged SQL writer.
  PERFORM 1 FROM public.runner_credentials
    WHERE id=NEW.credential_id AND project_id=NEW.project_id AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Handshake requires an active scoped credential' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.credential_id,NEW.project_id,NEW.first_verified_at)
      IS DISTINCT FROM ROW(OLD.credential_id,OLD.project_id,OLD.first_verified_at) THEN
      RAISE EXCEPTION 'Handshake identity and first receipt are immutable' USING ERRCODE = '23514';
    END IF;
    NEW.last_verified_at := greatest(OLD.last_verified_at, verified_at);
  ELSE
    NEW.first_verified_at := verified_at;
    NEW.last_verified_at := verified_at;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tastecase_guard_runner_handshake ON public.runner_handshakes;
CREATE TRIGGER tastecase_guard_runner_handshake BEFORE INSERT OR UPDATE OR DELETE ON public.runner_handshakes
  FOR EACH ROW EXECUTE FUNCTION public.tastecase_guard_runner_handshake();

ALTER TABLE public.runner_handshakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.runner_handshakes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.runner_handshakes FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS tastecase_owner_read ON public.runner_handshakes;
CREATE POLICY tastecase_owner_read ON public.runner_handshakes FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id=project_id AND p.owner_id=(SELECT auth.uid()))
);
GRANT SELECT ON public.runner_handshakes TO authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.runner_handshakes TO service_role;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.tastecase_guard_runner_handshake() FROM PUBLIC, anon, authenticated;
