-- Gate 1. Repeat-safe under the API migration runner's transaction/advisory lock.
-- Production auth.uid() and the shared auth schema are deliberately not defined here.
CREATE TABLE IF NOT EXISTS public.projects (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  schema_version text NOT NULL DEFAULT '1.0.0' CHECK (schema_version = '1.0.0'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- content is the entire validated Create*VersionRequest, including schema_version/id.
-- checksum is SHA-256 of @tastecase/contracts canonicalJson(content), NOT jsonb::text.
CREATE TABLE IF NOT EXISTS public.catalog_versions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id),
  schema_version text NOT NULL DEFAULT '1.0.0' CHECK (schema_version = '1.0.0'),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  CHECK ((content->>'id' = id::text AND content->>'schema_version' = schema_version) IS TRUE),
  CHECK ((jsonb_typeof(content->'entries') = 'array' AND jsonb_array_length(content->'entries') BETWEEN 1 AND 500) IS TRUE)
);
CREATE TABLE IF NOT EXISTS public.task_versions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id),
  catalog_version_id uuid NOT NULL,
  schema_version text NOT NULL DEFAULT '1.0.0' CHECK (schema_version = '1.0.0'),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  UNIQUE (project_id, id, catalog_version_id),
  FOREIGN KEY (project_id, catalog_version_id) REFERENCES public.catalog_versions(project_id, id),
  CHECK ((content->>'id' = id::text AND content->>'schema_version' = schema_version AND content->>'catalogVersionId' = catalog_version_id::text) IS TRUE),
  CHECK ((content->'syntheticBrief'->>'provenance' = 'synthetic') IS TRUE),
  CHECK ((jsonb_typeof(content->'syntheticInterests') = 'array') IS TRUE),
  CHECK ((jsonb_typeof(content->'constraints') = 'object') IS TRUE)
);
CREATE TABLE IF NOT EXISTS public.mapping_confirmations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id),
  catalog_version_id uuid NOT NULL,
  catalog_entry_id text NOT NULL CHECK (length(btrim(catalog_entry_id)) BETWEEN 1 AND 160),
  qloo_entity_id uuid NOT NULL,
  confirmed_by uuid NOT NULL,
  schema_version text NOT NULL DEFAULT '1.0.0' CHECK (schema_version = '1.0.0'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id, catalog_version_id),
  UNIQUE (project_id, catalog_version_id, catalog_entry_id),
  FOREIGN KEY (project_id, catalog_version_id) REFERENCES public.catalog_versions(project_id, id)
);
CREATE TABLE IF NOT EXISTS public.runner_credentials (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id),
  schema_version text NOT NULL DEFAULT '1.0.0' CHECK (schema_version = '1.0.0'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 160),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (project_id, id),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE TABLE IF NOT EXISTS public.target_attempts (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id),
  schema_version text NOT NULL DEFAULT '1.0.0' CHECK (schema_version = '1.0.0'),
  catalog_version_id uuid NOT NULL,
  task_version_id uuid NOT NULL,
  pinned_input jsonb NOT NULL CHECK (jsonb_typeof(pinned_input) = 'object'),
  input_checksum text NOT NULL CHECK (input_checksum ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'completed')),
  lease_id uuid UNIQUE,
  lease_credential_id uuid,
  lease_expires_at timestamptz,
  result jsonb,
  result_checksum text CHECK (result_checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (project_id, id, catalog_version_id),
  FOREIGN KEY (project_id, catalog_version_id) REFERENCES public.catalog_versions(project_id, id),
  FOREIGN KEY (project_id, task_version_id, catalog_version_id) REFERENCES public.task_versions(project_id, id, catalog_version_id),
  FOREIGN KEY (project_id, lease_credential_id) REFERENCES public.runner_credentials(project_id, id),
  CHECK ((status = 'queued' AND lease_id IS NULL AND lease_credential_id IS NULL AND lease_expires_at IS NULL)
      OR (status IN ('leased', 'completed') AND lease_id IS NOT NULL AND lease_credential_id IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status = 'completed' AND result IS NOT NULL AND result_checksum IS NOT NULL AND completed_at IS NOT NULL)
      OR (status <> 'completed' AND result IS NULL AND result_checksum IS NULL AND completed_at IS NULL)),
  CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND result->>'schema_version' = '1.0.0'
      AND result->>'outcome' IN ('success', 'malformed_output', 'provider_unavailable')
      AND result->'trace'->>'completeness' IN ('complete', 'partial', 'unavailable')
      AND jsonb_typeof(result->'trace'->'events') = 'array'
      AND (result->'trace'->>'completeness' <> 'unavailable' OR jsonb_array_length(result->'trace'->'events') = 0)) IS TRUE)
);
-- Materialised from pinned_input by the insert trigger; no independent client mutation.
CREATE TABLE IF NOT EXISTS public.target_attempt_mappings (
  project_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  mapping_confirmation_id uuid NOT NULL,
  PRIMARY KEY (attempt_id, mapping_confirmation_id),
  FOREIGN KEY (project_id, attempt_id, catalog_version_id) REFERENCES public.target_attempts(project_id, id, catalog_version_id),
  FOREIGN KEY (project_id, mapping_confirmation_id, catalog_version_id) REFERENCES public.mapping_confirmations(project_id, id, catalog_version_id)
);
CREATE INDEX IF NOT EXISTS projects_owner_idx ON public.projects(owner_id);
CREATE INDEX IF NOT EXISTS catalog_versions_project_idx ON public.catalog_versions(project_id, created_at);
CREATE INDEX IF NOT EXISTS task_versions_project_idx ON public.task_versions(project_id, created_at);
CREATE INDEX IF NOT EXISTS mapping_confirmations_project_idx ON public.mapping_confirmations(project_id);
CREATE INDEX IF NOT EXISTS runner_credentials_project_idx ON public.runner_credentials(project_id);
CREATE INDEX IF NOT EXISTS target_attempts_claim_idx ON public.target_attempts(project_id, status, created_at) WHERE status <> 'completed';

CREATE OR REPLACE FUNCTION public.tastecase_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_validate_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE catalog jsonb;
BEGIN
  IF NOT (NEW.content ?& ARRAY['id', 'schema_version', 'label']) OR (length(btrim(NEW.content->>'label')) BETWEEN 1 AND 160) IS NOT TRUE THEN
    RAISE EXCEPTION 'Version content requires id, schema_version and label' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'catalog_versions' THEN
    IF NOT (NEW.content ? 'entries') OR jsonb_typeof(NEW.content->'entries') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Catalog requires entries' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.content->'entries') entry
      WHERE NOT (entry ?& ARRAY['id', 'name']) OR (length(btrim(entry->>'id')) BETWEEN 1 AND 160) IS NOT TRUE OR (length(btrim(entry->>'name')) BETWEEN 1 AND 160) IS NOT TRUE)
      OR (SELECT count(*) FROM jsonb_array_elements(NEW.content->'entries')) <> (SELECT count(DISTINCT entry->>'id') FROM jsonb_array_elements(NEW.content->'entries') entry) THEN
      RAISE EXCEPTION 'Catalog entry IDs must be nonempty and unique with names' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT (NEW.content ?& ARRAY['catalogVersionId', 'syntheticBrief', 'syntheticInterests', 'constraints'])
      OR NOT (NEW.content->'syntheticBrief' ?& ARRAY['provenance', 'label', 'text'])
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.content->'syntheticInterests') interest WHERE interest->>'provenance' IS DISTINCT FROM 'synthetic')
      OR NOT (NEW.content->'constraints' ?& ARRAY['partySize', 'dietaryRequirements', 'accessibilityRequirements', 'requiredCuisines', 'excludedEntryIds']) THEN
      RAISE EXCEPTION 'Task requires explicitly synthetic inputs and fixed practical constraints' USING ERRCODE = '23514';
    END IF;
    SELECT content INTO catalog FROM public.catalog_versions WHERE project_id = NEW.project_id AND id = NEW.catalog_version_id;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW.content->'constraints'->'excludedEntryIds') excluded
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(catalog->'entries') entry WHERE entry->>'id' = excluded)) THEN
      RAISE EXCEPTION 'Excluded entry is not in the pinned catalog' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_validate_mapping() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.catalog_versions catalog, jsonb_array_elements(catalog.content->'entries') entry
      WHERE catalog.project_id = NEW.project_id AND catalog.id = NEW.catalog_version_id AND entry->>'id' = NEW.catalog_entry_id) THEN
    RAISE EXCEPTION 'Mapping must reference an entry in the project catalog' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.projects WHERE id = NEW.project_id AND owner_id = NEW.confirmed_by) THEN
    RAISE EXCEPTION 'Mapping must be confirmed by the project owner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_guard_credential() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Credential history cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at') OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'Only one-way credential revocation is allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_guard_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  catalog public.catalog_versions%ROWTYPE;
  task public.task_versions%ROWTYPE;
  mapping jsonb;
  excluded jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Attempt history cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued' THEN RAISE EXCEPTION 'New attempt must be queued' USING ERRCODE = '23514'; END IF;
    SELECT * INTO catalog FROM public.catalog_versions WHERE project_id = NEW.project_id AND id = NEW.catalog_version_id;
    SELECT * INTO task FROM public.task_versions WHERE project_id = NEW.project_id AND id = NEW.task_version_id AND catalog_version_id = NEW.catalog_version_id;
    IF catalog.id IS NULL OR task.id IS NULL THEN RAISE EXCEPTION 'Attempt versions must belong to its project and pinned catalog' USING ERRCODE = '23503'; END IF;
    IF NOT (NEW.pinned_input ?& ARRAY['schema_version', 'projectId', 'catalog', 'task', 'mappings', 'eligibleCatalogEntryIds'])
      OR NEW.pinned_input->>'schema_version' IS DISTINCT FROM NEW.schema_version
      OR NEW.pinned_input->>'projectId' IS DISTINCT FROM NEW.project_id::text
      OR NEW.pinned_input->'catalog'->>'projectId' IS DISTINCT FROM NEW.project_id::text
      OR NEW.pinned_input->'task'->>'projectId' IS DISTINCT FROM NEW.project_id::text
      OR ((NEW.pinned_input->'catalog') - ARRAY['projectId', 'checksum', 'createdAt']) IS DISTINCT FROM catalog.content
      OR ((NEW.pinned_input->'task') - ARRAY['projectId', 'checksum', 'createdAt']) IS DISTINCT FROM task.content
      OR NEW.pinned_input->'catalog'->>'checksum' IS DISTINCT FROM catalog.checksum
      OR NEW.pinned_input->'task'->>'checksum' IS DISTINCT FROM task.checksum
      OR jsonb_typeof(NEW.pinned_input->'mappings') IS DISTINCT FROM 'array'
      OR jsonb_typeof(NEW.pinned_input->'eligibleCatalogEntryIds') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Attempt input must contain the exact pinned project versions' USING ERRCODE = '23514';
    END IF;
    excluded := task.content->'constraints'->'excludedEntryIds';
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW.pinned_input->'eligibleCatalogEntryIds') eligible
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(catalog.content->'entries') entry WHERE entry->>'id' = eligible) OR excluded ? eligible)
      OR (SELECT count(*) FROM jsonb_array_elements_text(NEW.pinned_input->'eligibleCatalogEntryIds')) <> (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(NEW.pinned_input->'eligibleCatalogEntryIds')) THEN
      RAISE EXCEPTION 'Eligible IDs must be unique pinned catalog entries and not excluded' USING ERRCODE = '23514';
    END IF;
    FOR mapping IN SELECT value FROM jsonb_array_elements(NEW.pinned_input->'mappings') LOOP
      IF NOT EXISTS (SELECT 1 FROM public.mapping_confirmations row WHERE row.project_id = NEW.project_id AND row.catalog_version_id = NEW.catalog_version_id
        AND row.id::text = mapping->>'id' AND row.catalog_entry_id = mapping->>'catalogEntryId' AND row.qloo_entity_id::text = mapping->>'qlooEntityId'
        AND row.confirmed_by::text = mapping->>'confirmedBy'
        AND mapping->>'projectId' = NEW.project_id::text AND mapping->>'catalogVersionId' = NEW.catalog_version_id::text
        AND mapping->>'schema_version' = '1.0.0') THEN
        RAISE EXCEPTION 'Pinned mapping must be confirmed in the same project/catalog' USING ERRCODE = '23503';
      END IF;
    END LOOP;
    IF (SELECT count(*) FROM jsonb_array_elements(NEW.pinned_input->'mappings')) <> (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(NEW.pinned_input->'mappings')) THEN
      RAISE EXCEPTION 'Duplicate pinned mappings' USING ERRCODE = '23505';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.project_id, NEW.schema_version, NEW.catalog_version_id, NEW.task_version_id, NEW.pinned_input, NEW.input_checksum, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.project_id, OLD.schema_version, OLD.catalog_version_id, OLD.task_version_id, OLD.pinned_input, OLD.input_checksum, OLD.created_at) THEN
      RAISE EXCEPTION 'Attempt input and identity are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'completed' THEN
      IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Completed result collision: attempt is immutable' USING ERRCODE = '23505'; END IF;
      RETURN NEW;
    END IF;
    IF NEW.status = 'queued' OR (NEW.status = 'completed' AND OLD.status <> 'leased') THEN
      RAISE EXCEPTION 'Invalid attempt state transition' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'leased' AND OLD.status = 'leased' AND OLD.lease_expires_at > clock_timestamp() THEN
      RAISE EXCEPTION 'Active lease cannot be replaced' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'leased' AND NEW.lease_id IS NOT DISTINCT FROM OLD.lease_id THEN
      RAISE EXCEPTION 'Reclaim must issue a fresh lease ID' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'completed' AND (ROW(NEW.lease_id, NEW.lease_credential_id, NEW.lease_expires_at) IS DISTINCT FROM ROW(OLD.lease_id, OLD.lease_credential_id, OLD.lease_expires_at) OR OLD.lease_expires_at <= clock_timestamp()) THEN
      RAISE EXCEPTION 'Result requires the current unexpired lease' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status IN ('leased', 'completed') THEN
    -- API also locks/validates this credential BEFORE locking the attempt, serialising revocation.
    IF NOT EXISTS (SELECT 1 FROM public.runner_credentials WHERE id = NEW.lease_credential_id AND project_id = NEW.project_id AND revoked_at IS NULL) THEN
      RAISE EXCEPTION 'Runner credential must be active and scoped to this project' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'leased' AND (NEW.lease_expires_at <= clock_timestamp() OR NEW.lease_expires_at > clock_timestamp() + interval '15 minutes') THEN
      RAISE EXCEPTION 'Lease expiry must be in the next 15 minutes' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_pin_attempt_mappings() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.target_attempt_mappings(project_id, attempt_id, catalog_version_id, mapping_confirmation_id)
    SELECT NEW.project_id, NEW.id, NEW.catalog_version_id, (value->>'id')::uuid FROM jsonb_array_elements(NEW.pinned_input->'mappings');
  RETURN NEW;
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['catalog_versions', 'task_versions', 'mapping_confirmations', 'target_attempt_mappings'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS tastecase_immutable ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER tastecase_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.tastecase_immutable()', table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['catalog_versions', 'task_versions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS tastecase_validate_version ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER tastecase_validate_version BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.tastecase_validate_version()', table_name);
  END LOOP;
END;
$$;
DROP TRIGGER IF EXISTS tastecase_validate_mapping ON public.mapping_confirmations;
CREATE TRIGGER tastecase_validate_mapping BEFORE INSERT ON public.mapping_confirmations FOR EACH ROW EXECUTE FUNCTION public.tastecase_validate_mapping();
DROP TRIGGER IF EXISTS tastecase_guard_credential ON public.runner_credentials;
CREATE TRIGGER tastecase_guard_credential BEFORE UPDATE OR DELETE ON public.runner_credentials FOR EACH ROW EXECUTE FUNCTION public.tastecase_guard_credential();
DROP TRIGGER IF EXISTS tastecase_guard_attempt ON public.target_attempts;
CREATE TRIGGER tastecase_guard_attempt BEFORE INSERT OR UPDATE OR DELETE ON public.target_attempts FOR EACH ROW EXECUTE FUNCTION public.tastecase_guard_attempt();
DROP TRIGGER IF EXISTS tastecase_pin_attempt_mappings ON public.target_attempts;
CREATE TRIGGER tastecase_pin_attempt_mappings AFTER INSERT ON public.target_attempts FOR EACH ROW EXECUTE FUNCTION public.tastecase_pin_attempt_mappings();

-- No authenticated writes to credentials, claims or results: privileged API only.
-- No owner UPDATE/DELETE on private version/history rows. Project ownership cannot be changed.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['projects', 'catalog_versions', 'task_versions', 'mapping_confirmations', 'runner_credentials', 'target_attempts', 'target_attempt_mappings'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tastecase_owner_read ON public.%I', table_name);
    IF table_name = 'projects' THEN
      EXECUTE 'CREATE POLICY tastecase_owner_read ON public.projects FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()))';
    ELSE
      EXECUTE format('CREATE POLICY tastecase_owner_read ON public.%I FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.projects project WHERE project.id = project_id AND project.owner_id = (SELECT auth.uid())))', table_name);
    END IF;
    IF table_name <> 'runner_credentials' THEN EXECUTE format('GRANT SELECT ON public.%I TO authenticated', table_name); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN EXECUTE format('GRANT ALL ON public.%I TO service_role', table_name); END IF;
  END LOOP;
END;
$$;
GRANT SELECT (id, project_id, schema_version, label, created_at, revoked_at) ON public.runner_credentials TO authenticated;
DROP POLICY IF EXISTS tastecase_owner_insert ON public.projects;
CREATE POLICY tastecase_owner_insert ON public.projects FOR INSERT TO authenticated WITH CHECK (owner_id = (SELECT auth.uid()));
GRANT INSERT ON public.projects TO authenticated;
-- All validated version/mapping writes also go through the API. RLS remains a read backstop.
REVOKE ALL ON FUNCTION public.tastecase_immutable(), public.tastecase_validate_version(), public.tastecase_validate_mapping(), public.tastecase_guard_credential(), public.tastecase_guard_attempt(), public.tastecase_pin_attempt_mappings() FROM PUBLIC;

-- Hosted Storage is optional locally. Bucket setup never creates/replaces the storage schema.
-- Paths: <project UUID>/<nonempty object path>. Only project owners may read/create/delete.
-- No UPDATE/upsert: immutable objects and duplicate path conflicts remain visible.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL AND to_regclass('storage.objects') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      VALUES ('tastecase-private', 'tastecase-private', false, 1048576, ARRAY['application/json'])
      ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 1048576, allowed_mime_types = ARRAY['application/json'];
    DROP POLICY IF EXISTS tastecase_private_read ON storage.objects;
    DROP POLICY IF EXISTS tastecase_private_insert ON storage.objects;
    DROP POLICY IF EXISTS tastecase_private_delete ON storage.objects;
    DROP POLICY IF EXISTS tastecase_private_boundary ON storage.objects;
    DROP POLICY IF EXISTS tastecase_private_no_update ON storage.objects;
    DROP POLICY IF EXISTS tastecase_private_no_anon ON storage.objects;
    -- Restrictive guards prevent pre-existing broad permissive policies opening this bucket.
    CREATE POLICY tastecase_private_boundary ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated USING (
      bucket_id <> 'tastecase-private' OR (length(split_part(name, '/', 2)) > 0
        AND EXISTS (SELECT 1 FROM public.projects WHERE id::text = split_part(storage.objects.name, '/', 1) AND owner_id = (SELECT auth.uid())))
    ) WITH CHECK (
      bucket_id <> 'tastecase-private' OR (length(split_part(name, '/', 2)) > 0
        AND EXISTS (SELECT 1 FROM public.projects WHERE id::text = split_part(storage.objects.name, '/', 1) AND owner_id = (SELECT auth.uid())))
    );
    CREATE POLICY tastecase_private_no_update ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
      USING (bucket_id <> 'tastecase-private') WITH CHECK (bucket_id <> 'tastecase-private');
    CREATE POLICY tastecase_private_no_anon ON storage.objects AS RESTRICTIVE FOR ALL TO anon
      USING (bucket_id <> 'tastecase-private') WITH CHECK (bucket_id <> 'tastecase-private');
    CREATE POLICY tastecase_private_read ON storage.objects FOR SELECT TO authenticated USING (
      bucket_id = 'tastecase-private' AND length(split_part(name, '/', 2)) > 0
      AND EXISTS (SELECT 1 FROM public.projects WHERE id::text = split_part(storage.objects.name, '/', 1) AND owner_id = (SELECT auth.uid()))
    );
    CREATE POLICY tastecase_private_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (
      bucket_id = 'tastecase-private' AND length(split_part(name, '/', 2)) > 0
      AND EXISTS (SELECT 1 FROM public.projects WHERE id::text = split_part(storage.objects.name, '/', 1) AND owner_id = (SELECT auth.uid()))
    );
    CREATE POLICY tastecase_private_delete ON storage.objects FOR DELETE TO authenticated USING (
      bucket_id = 'tastecase-private' AND length(split_part(name, '/', 2)) > 0
      AND EXISTS (SELECT 1 FROM public.projects WHERE id::text = split_part(storage.objects.name, '/', 1) AND owner_id = (SELECT auth.uid()))
    );
  END IF;
END;
$$;
