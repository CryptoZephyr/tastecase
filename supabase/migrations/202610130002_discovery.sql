-- Gate 2 is additive. Canonical checksums are computed after strict contract validation,
-- using @tastecase/contracts checksum(), never jsonb::text or raw provider responses.
CREATE TABLE IF NOT EXISTS public.discovery_jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id),
  catalog_version_id uuid NOT NULL,
  task_version_id uuid NOT NULL,
  schema_version text NOT NULL DEFAULT '1.0.0' CHECK (schema_version = '1.0.0'),
  pinned_input jsonb NOT NULL CHECK (jsonb_typeof(pinned_input) = 'object' AND octet_length(pinned_input::text) <= 1048576),
  input_checksum text NOT NULL CHECK (input_checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  UNIQUE (project_id, id),
  UNIQUE (project_id, id, catalog_version_id),
  FOREIGN KEY (project_id, task_version_id, catalog_version_id) REFERENCES public.task_versions(project_id, id, catalog_version_id)
);
CREATE TABLE IF NOT EXISTS public.discovery_job_state (
  job_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','resolving','needs_confirmation','ranking','selecting','running_target','waiting_runner','investigating','awaiting_review','no_useful_contrast','unavailable','partial','budget_exhausted','deadline_exceeded','cancelled','failed')),
  checkpoint smallint NOT NULL DEFAULT 0 CHECK (checkpoint BETWEEN 0 AND 6),
  checkpoint_data jsonb NOT NULL DEFAULT '{"evidenceIds":[],"candidateIds":[]}' CHECK (jsonb_typeof(checkpoint_data) = 'object' AND octet_length(checkpoint_data::text) <= 8192),
  qloo_attempts int NOT NULL DEFAULT 0 CHECK (qloo_attempts BETWEEN 0 AND 20),
  model_decisions int NOT NULL DEFAULT 0 CHECK (model_decisions BETWEEN 0 AND 8),
  target_attempts int NOT NULL DEFAULT 0 CHECK (target_attempts BETWEEN 0 AND 12),
  rounds int NOT NULL DEFAULT 0 CHECK (rounds BETWEEN 0 AND 6),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  lease_id uuid,
  lease_expires_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancelled_at timestamptz,
  reason text CHECK (length(reason) BETWEEN 1 AND 2000),
  UNIQUE (project_id, job_id),
  FOREIGN KEY (project_id, job_id) REFERENCES public.discovery_jobs(project_id, id),
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS public.discovery_provider_attempts (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  job_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('qloo','model')),
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 160),
  try_number int NOT NULL CHECK (try_number BETWEEN 0 AND 2),
  request_checksum text NOT NULL CHECK (request_checksum ~ '^[a-f0-9]{64}$'),
  reserved_lease_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','dispatched','accepted','error','interrupted','uncertain')),
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatched_at timestamptz,
  finished_at timestamptz,
  retryable boolean NOT NULL DEFAULT false,
  error_category text CHECK (error_category IN ('auth','transient','invalid_input','unavailable')),
  error_code text CHECK (length(error_code) BETWEEN 1 AND 160),
  next_dispatch_at timestamptz,
  UNIQUE (project_id, job_id, id),
  UNIQUE (job_id, kind, operation_key, try_number),
  FOREIGN KEY (project_id, job_id) REFERENCES public.discovery_jobs(project_id, id),
  CHECK (NOT retryable OR (status = 'error' AND error_category = 'transient')),
  CHECK ((status IN ('reserved','interrupted') AND dispatched_at IS NULL) OR (status IN ('dispatched','accepted','error','uncertain') AND dispatched_at IS NOT NULL)),
  CHECK ((status IN ('reserved','dispatched') AND finished_at IS NULL) OR (status IN ('accepted','error','interrupted','uncertain') AND finished_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS public.discovery_tool_evidence (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  job_id uuid NOT NULL,
  attempt_id uuid,
  schema_version text NOT NULL DEFAULT '1.0.0' CHECK (schema_version = '1.0.0'),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 262144 AND data->>'kind' IN ('resolve','rank','facts','model_decision')),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, job_id, id),
  FOREIGN KEY (project_id, job_id) REFERENCES public.discovery_jobs(project_id, id),
  FOREIGN KEY (project_id, job_id, attempt_id) REFERENCES public.discovery_provider_attempts(project_id, job_id, id)
);
CREATE TABLE IF NOT EXISTS public.discovery_anchor_resolutions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  job_id uuid NOT NULL,
  anchor_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  candidates jsonb NOT NULL CHECK (jsonb_typeof(candidates) = 'array' AND jsonb_array_length(candidates) <= 10 AND octet_length(candidates::text) <= 8192),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, job_id, id, anchor_id),
  FOREIGN KEY (project_id, job_id, evidence_id) REFERENCES public.discovery_tool_evidence(project_id, job_id, id)
);
CREATE TABLE IF NOT EXISTS public.discovery_anchor_confirmations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  job_id uuid NOT NULL,
  anchor_id uuid NOT NULL,
  resolution_id uuid,
  entity_id uuid NOT NULL,
  confirmed_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, anchor_id),
  UNIQUE (project_id, job_id, id),
  FOREIGN KEY (project_id, job_id) REFERENCES public.discovery_jobs(project_id, id),
  FOREIGN KEY (project_id, job_id, resolution_id, anchor_id) REFERENCES public.discovery_anchor_resolutions(project_id, job_id, id, anchor_id)
);
CREATE TABLE IF NOT EXISTS public.discovery_candidates (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  job_id uuid NOT NULL,
  schema_version text NOT NULL DEFAULT '1.0.0' CHECK (schema_version = '1.0.0'),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 262144),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, job_id, id),
  FOREIGN KEY (project_id, job_id) REFERENCES public.discovery_jobs(project_id, id)
);
CREATE TABLE IF NOT EXISTS public.discovery_candidate_evidence (
  project_id uuid NOT NULL,
  job_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  PRIMARY KEY (candidate_id, evidence_id),
  FOREIGN KEY (project_id, job_id, candidate_id) REFERENCES public.discovery_candidates(project_id, job_id, id),
  FOREIGN KEY (project_id, job_id, evidence_id) REFERENCES public.discovery_tool_evidence(project_id, job_id, id)
);
-- Scheduling owns both the target row and this association, in ONE transaction.
-- Queueing reserves one target budget unit, even if the runner never connects.
CREATE TABLE IF NOT EXISTS public.discovery_job_targets (
  attempt_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  job_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  profile_id text NOT NULL CHECK (profile_id IN ('a','b')),
  round int NOT NULL CHECK (round BETWEEN 0 AND 5),
  repeat int NOT NULL CHECK (repeat BETWEEN 0 AND 2),
  variant text NOT NULL CHECK (variant IN ('full','reduced_pair')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, profile_id, round, repeat, variant),
  UNIQUE (project_id, job_id, attempt_id),
  FOREIGN KEY (project_id, job_id, catalog_version_id) REFERENCES public.discovery_jobs(project_id, id, catalog_version_id),
  FOREIGN KEY (project_id, attempt_id, catalog_version_id) REFERENCES public.target_attempts(project_id, id, catalog_version_id)
);
-- Immutable dispatch receipts: a receipt without a matching completed lease is
-- in-flight/uncertain, not proof of exactly-once provider calls or billing.
CREATE TABLE IF NOT EXISTS public.discovery_target_dispatches (
  lease_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  job_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  ordinal int NOT NULL CHECK (ordinal BETWEEN 0 AND 11),
  dispatched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (attempt_id, ordinal),
  FOREIGN KEY (project_id, job_id, attempt_id) REFERENCES public.discovery_job_targets(project_id, job_id, attempt_id)
);
CREATE TABLE IF NOT EXISTS public.discovery_candidate_targets (
  project_id uuid NOT NULL,
  job_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  PRIMARY KEY (candidate_id, attempt_id),
  FOREIGN KEY (project_id, job_id, candidate_id) REFERENCES public.discovery_candidates(project_id, job_id, id),
  FOREIGN KEY (project_id, job_id, attempt_id) REFERENCES public.discovery_job_targets(project_id, job_id, attempt_id)
);
CREATE INDEX IF NOT EXISTS discovery_claim_idx ON public.discovery_job_state(available_at, lease_expires_at) WHERE state IN ('queued','resolving','ranking','selecting','running_target','waiting_runner','investigating');
CREATE INDEX IF NOT EXISTS discovery_project_idx ON public.discovery_jobs(project_id, created_at);
CREATE INDEX IF NOT EXISTS discovery_attempt_job_idx ON public.discovery_provider_attempts(project_id, job_id);
CREATE UNIQUE INDEX IF NOT EXISTS discovery_lease_idx ON public.discovery_job_state(lease_id) WHERE lease_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.tastecase_validate_discovery_job() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE input jsonb := NEW.pinned_input->'targetInput'; request jsonb := NEW.pinned_input->'request'; task jsonb; catalog jsonb; budgets jsonb := request->'budgets';
BEGIN
  SELECT content INTO task FROM public.task_versions WHERE project_id=NEW.project_id AND id=NEW.task_version_id AND catalog_version_id=NEW.catalog_version_id;
  SELECT content INTO catalog FROM public.catalog_versions WHERE project_id=NEW.project_id AND id=NEW.catalog_version_id;
  IF task IS NULL OR catalog IS NULL THEN RAISE EXCEPTION 'Discovery versions are outside project' USING ERRCODE='23503'; END IF;
  IF (NEW.pinned_input->>'schema_version'='1.0.0' AND request->>'schema_version'='1.0.0' AND request->>'id'=NEW.id::text
    AND request->>'catalogVersionId'=NEW.catalog_version_id::text AND request->>'taskVersionId'=NEW.task_version_id::text
    AND input->>'projectId'=NEW.project_id::text AND input->>'schema_version'='1.0.0'
    AND input->'catalog'->>'projectId'=NEW.project_id::text AND input->'task'->>'projectId'=NEW.project_id::text
    AND ((input->'catalog') - ARRAY['projectId','checksum','createdAt'])=catalog AND ((input->'task') - ARRAY['projectId','checksum','createdAt'])=task
    AND request->'eligibleCatalogEntryIds'=input->'eligibleCatalogEntryIds'
    AND jsonb_array_length(request->'profiles')=2 AND request->'profiles'->0->>'id'='a' AND request->'profiles'->1->>'id'='b'
    AND (budgets->>'qlooAttempts')::int BETWEEN 1 AND 20 AND (budgets->>'modelDecisions')::int BETWEEN 1 AND 8
    AND (budgets->>'targetAttempts')::int BETWEEN 2 AND 12 AND (budgets->>'rounds')::int BETWEEN 1 AND 6
    AND (budgets->>'deadlineSeconds')::int BETWEEN 30 AND 3600 AND (budgets->>'outputBytes')::int BETWEEN 1024 AND 262144
    AND (budgets->>'retriesPerOperation')::int BETWEEN 0 AND 2 AND (request->>'repeatCount')::int BETWEEN 1 AND 3
    AND request->>'assistantVersion' IS NOT NULL AND jsonb_typeof(request->'reducePair')='boolean'
    AND NEW.deadline_at=NEW.created_at + (budgets->>'deadlineSeconds')::int * interval '1 second') IS NOT TRUE THEN
    RAISE EXCEPTION 'Invalid immutable discovery input or budget' USING ERRCODE='23514';
  END IF;
  IF input->'catalog'->>'checksum' IS DISTINCT FROM (SELECT checksum FROM public.catalog_versions WHERE id=NEW.catalog_version_id)
    OR input->'task'->>'checksum' IS DISTINCT FROM (SELECT checksum FROM public.task_versions WHERE id=NEW.task_version_id)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(request->'profiles') p WHERE p->>'provenance' IS DISTINCT FROM 'public_synthetic'
      OR jsonb_typeof(p->'anchors') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'anchors') NOT BETWEEN 1 AND 5)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(request->'profiles') p, jsonb_array_elements(p->'anchors') a WHERE a->>'kind' NOT IN ('music','film','brand') OR a->>'id' IS NULL OR a->>'label' IS NULL)
    OR (SELECT count(*) FROM jsonb_array_elements(request->'profiles') p, jsonb_array_elements(p->'anchors')) <>
       (SELECT count(DISTINCT a->>'id') FROM jsonb_array_elements(request->'profiles') p, jsonb_array_elements(p->'anchors') a) THEN
    RAISE EXCEPTION 'Public synthetic profiles or version checksums invalid' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(input->'mappings') IS DISTINCT FROM 'array' OR jsonb_typeof(input->'eligibleCatalogEntryIds') IS DISTINCT FROM 'array'
    OR jsonb_array_length(input->'eligibleCatalogEntryIds') NOT BETWEEN 2 AND 500
    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(input->'eligibleCatalogEntryIds') e WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(catalog->'entries') c WHERE c->>'id'=e) OR task->'constraints'->'excludedEntryIds' ? e)
    OR (SELECT count(*) FROM jsonb_array_elements_text(input->'eligibleCatalogEntryIds')) <> (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(input->'eligibleCatalogEntryIds')) THEN
    RAISE EXCEPTION 'Invalid fixed eligibility' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(input->'mappings') m WHERE NOT EXISTS (SELECT 1 FROM public.mapping_confirmations c
    WHERE c.project_id=NEW.project_id AND c.catalog_version_id=NEW.catalog_version_id AND c.id::text=m->>'id' AND c.catalog_entry_id=m->>'catalogEntryId'
    AND c.qloo_entity_id::text=m->>'qlooEntityId' AND c.confirmed_by::text=m->>'confirmedBy' AND m->>'projectId'=NEW.project_id::text AND m->>'catalogVersionId'=NEW.catalog_version_id::text))
    OR (SELECT count(*) FROM jsonb_array_elements(input->'mappings')) <> (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(input->'mappings'))
    OR (SELECT coalesce(jsonb_agg(value->>'id' ORDER BY value->>'id'),'[]') FROM jsonb_array_elements(input->'mappings')) IS DISTINCT FROM
       (SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM jsonb_array_elements_text(request->'mappingConfirmationIds')) THEN
    RAISE EXCEPTION 'Mappings require pinned owner confirmations' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_initialise_discovery_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.discovery_job_state(project_id,job_id) VALUES(NEW.project_id,NEW.id);
  INSERT INTO public.discovery_anchor_confirmations(id,project_id,job_id,anchor_id,entity_id,confirmed_by)
    SELECT gen_random_uuid(),NEW.project_id,NEW.id,(a->>'id')::uuid,(a->>'confirmedEntityId')::uuid,p.owner_id
      FROM public.projects p,jsonb_array_elements(NEW.pinned_input->'request'->'profiles') profile,jsonb_array_elements(profile->'anchors') a
      WHERE p.id=NEW.project_id AND a ? 'confirmedEntityId';
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_guard_discovery_state() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE budgets jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Execution history cannot be deleted' USING ERRCODE='23514'; END IF;
  IF NEW.project_id<>OLD.project_id OR NEW.job_id<>OLD.job_id OR NEW.revision<>OLD.revision+1 OR NEW.checkpoint<OLD.checkpoint
    OR NEW.qloo_attempts<OLD.qloo_attempts OR NEW.model_decisions<OLD.model_decisions OR NEW.target_attempts<OLD.target_attempts OR NEW.rounds<OLD.rounds
    OR NOT ((NEW.checkpoint_data->'evidenceIds') @> (OLD.checkpoint_data->'evidenceIds')) OR NOT ((NEW.checkpoint_data->'candidateIds') @> (OLD.checkpoint_data->'candidateIds'))
    OR OLD.state IN ('awaiting_review','no_useful_contrast','unavailable','partial','budget_exhausted','deadline_exceeded','cancelled','failed') THEN
    RAISE EXCEPTION 'Execution mutations must be monotonic and nonterminal' USING ERRCODE='23514';
  END IF;
  SELECT pinned_input->'request'->'budgets' INTO budgets FROM public.discovery_jobs WHERE id=NEW.job_id;
  IF NEW.qloo_attempts>(budgets->>'qlooAttempts')::int OR NEW.model_decisions>(budgets->>'modelDecisions')::int
    OR NEW.target_attempts>(budgets->>'targetAttempts')::int OR NEW.rounds>(budgets->>'rounds')::int THEN RAISE EXCEPTION 'Discovery budget exhausted' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_discovery_lock(p_project uuid,p_job uuid,p_lease uuid,p_allow_deadline boolean DEFAULT false)
RETURNS public.discovery_job_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.discovery_job_state;
BEGIN
  SELECT * INTO s FROM public.discovery_job_state WHERE project_id=p_project AND job_id=p_job FOR UPDATE;
  IF s.job_id IS NULL OR s.lease_id IS DISTINCT FROM p_lease OR s.lease_expires_at<=clock_timestamp() OR s.lease_id IS NULL THEN RAISE EXCEPTION 'Stale discovery lease' USING ERRCODE='40001'; END IF;
  IF s.state IN ('awaiting_review','no_useful_contrast','unavailable','partial','budget_exhausted','deadline_exceeded','cancelled','failed') THEN RAISE EXCEPTION 'Discovery is terminal' USING ERRCODE='23514'; END IF;
  IF NOT p_allow_deadline AND (SELECT deadline_at FROM public.discovery_jobs WHERE id=p_job)<=clock_timestamp() THEN RAISE EXCEPTION 'Discovery deadline exceeded' USING ERRCODE='23514'; END IF;
  RETURN s;
END;
$$;
CREATE OR REPLACE FUNCTION public.claim_discovery_job(p_lease uuid,p_seconds int DEFAULT 60,p_project uuid DEFAULT NULL)
RETURNS SETOF public.discovery_job_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.discovery_job_state;
BEGIN
  IF p_lease IS NULL OR p_seconds NOT BETWEEN 1 AND 900 THEN RAISE EXCEPTION 'Invalid discovery lease duration' USING ERRCODE='23514'; END IF;
  SELECT * INTO s FROM public.discovery_job_state WHERE (p_project IS NULL OR project_id=p_project)
    AND (state IN ('queued','resolving','ranking','selecting','running_target','waiting_runner','investigating')
      OR (state='needs_confirmation' AND EXISTS(SELECT 1 FROM public.discovery_jobs j WHERE j.id=job_id AND j.deadline_at<=clock_timestamp()))) AND available_at<=clock_timestamp()
    AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp()) ORDER BY available_at,job_id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF s.job_id IS NULL THEN RETURN; END IF;
  -- A crash after reservation/dispatch remains charged and visible on restart.
  UPDATE public.discovery_provider_attempts SET status=CASE WHEN status='reserved' THEN 'interrupted' ELSE 'uncertain' END,finished_at=clock_timestamp()
    WHERE job_id=s.job_id AND status IN ('reserved','dispatched');
  RETURN QUERY UPDATE public.discovery_job_state SET lease_id=p_lease,lease_expires_at=clock_timestamp()+p_seconds*interval '1 second',revision=revision+1 WHERE job_id=s.job_id RETURNING *;
END;
$$;
CREATE OR REPLACE FUNCTION public.renew_discovery_lease(p_project uuid,p_job uuid,p_lease uuid,p_seconds int DEFAULT 60)
RETURNS public.discovery_job_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.discovery_job_state;
BEGIN
  PERFORM public.tastecase_discovery_lock(p_project,p_job,p_lease);
  IF p_seconds NOT BETWEEN 1 AND 900 THEN RAISE EXCEPTION 'Invalid lease duration' USING ERRCODE='23514'; END IF;
  UPDATE public.discovery_job_state SET lease_expires_at=clock_timestamp()+p_seconds*interval '1 second',revision=revision+1 WHERE job_id=p_job RETURNING * INTO s; RETURN s;
END;
$$;
CREATE OR REPLACE FUNCTION public.advance_discovery_job(p_project uuid,p_job uuid,p_lease uuid,p_state text,p_checkpoint int,p_data jsonb,p_reason text DEFAULT NULL,p_delay_seconds int DEFAULT 0,p_release boolean DEFAULT false,p_round boolean DEFAULT false)
RETURNS public.discovery_job_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.discovery_job_state; ref text;
BEGIN
  PERFORM public.tastecase_discovery_lock(p_project,p_job,p_lease,p_state='deadline_exceeded');
  IF p_delay_seconds NOT BETWEEN 0 AND 300 OR jsonb_typeof(p_data->'evidenceIds') IS DISTINCT FROM 'array' OR jsonb_typeof(p_data->'candidateIds') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_data->'evidenceIds')>20 OR jsonb_array_length(p_data->'candidateIds')>20
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_data) k WHERE k NOT IN ('evidenceIds','candidateIds','note')) THEN RAISE EXCEPTION 'Invalid checkpoint' USING ERRCODE='23514'; END IF;
  FOR ref IN SELECT jsonb_array_elements_text(p_data->'evidenceIds') LOOP
    IF NOT EXISTS(SELECT 1 FROM public.discovery_tool_evidence WHERE project_id=p_project AND job_id=p_job AND id::text=ref) THEN RAISE EXCEPTION 'Checkpoint evidence outside job' USING ERRCODE='23503'; END IF;
  END LOOP;
  FOR ref IN SELECT jsonb_array_elements_text(p_data->'candidateIds') LOOP
    IF NOT EXISTS(SELECT 1 FROM public.discovery_candidates WHERE project_id=p_project AND job_id=p_job AND id::text=ref) THEN RAISE EXCEPTION 'Checkpoint candidate outside job' USING ERRCODE='23503'; END IF;
  END LOOP;
  UPDATE public.discovery_job_state SET state=p_state,checkpoint=p_checkpoint,checkpoint_data=p_data,reason=p_reason,
    available_at=greatest(available_at,clock_timestamp()+p_delay_seconds*interval '1 second'),rounds=rounds+CASE WHEN p_round THEN 1 ELSE 0 END,
    lease_id=CASE WHEN p_release THEN NULL ELSE lease_id END,lease_expires_at=CASE WHEN p_release THEN NULL ELSE lease_expires_at END,revision=revision+1
    WHERE job_id=p_job RETURNING * INTO s; RETURN s;
END;
$$;
CREATE OR REPLACE FUNCTION public.cancel_discovery_job(p_project uuid,p_job uuid)
RETURNS public.discovery_job_state LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.discovery_job_state;
BEGIN
  SELECT * INTO s FROM public.discovery_job_state WHERE project_id=p_project AND job_id=p_job FOR UPDATE;
  IF s.job_id IS NULL THEN RAISE EXCEPTION 'Discovery not found' USING ERRCODE='P0002'; END IF;
  IF s.state IN ('awaiting_review','no_useful_contrast','unavailable','partial','budget_exhausted','deadline_exceeded','cancelled','failed') THEN RETURN s; END IF;
  UPDATE public.discovery_job_state SET state='cancelled',cancelled_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL,revision=revision+1 WHERE job_id=p_job RETURNING * INTO s; RETURN s;
END;
$$;
CREATE OR REPLACE FUNCTION public.reserve_discovery_attempt(p_project uuid,p_job uuid,p_lease uuid,p_id uuid,p_kind text,p_operation text,p_try int,p_checksum text,p_allow_uncertain boolean DEFAULT false)
RETURNS public.discovery_provider_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a public.discovery_provider_attempts; previous public.discovery_provider_attempts; budgets jsonb;
BEGIN
  PERFORM public.tastecase_discovery_lock(p_project,p_job,p_lease);
  SELECT * INTO a FROM public.discovery_provider_attempts WHERE job_id=p_job AND kind=p_kind AND operation_key=p_operation AND try_number=p_try;
  IF a.id IS NOT NULL THEN
    IF a.id<>p_id OR a.request_checksum<>p_checksum THEN RAISE EXCEPTION 'Attempt identity/checksum conflict' USING ERRCODE='23505'; END IF;
    RETURN a;
  END IF;
  SELECT pinned_input->'request'->'budgets' INTO budgets FROM public.discovery_jobs WHERE id=p_job;
  IF p_kind NOT IN ('qloo','model') OR p_try NOT BETWEEN 0 AND (budgets->>'retriesPerOperation')::int THEN RAISE EXCEPTION 'Invalid attempt retry' USING ERRCODE='23514'; END IF;
  IF p_try>0 THEN
    SELECT * INTO previous FROM public.discovery_provider_attempts WHERE job_id=p_job AND kind=p_kind AND operation_key=p_operation AND try_number=p_try-1;
    IF previous.id IS NULL OR previous.request_checksum<>p_checksum OR NOT ((previous.status='error' AND previous.retryable AND previous.error_category='transient')
      OR (p_allow_uncertain AND previous.status IN ('interrupted','uncertain')))
      OR (previous.next_dispatch_at IS NOT NULL AND previous.next_dispatch_at>clock_timestamp()) THEN RAISE EXCEPTION 'Retry is not eligible or backoff pending' USING ERRCODE='23514'; END IF;
  END IF;
  UPDATE public.discovery_job_state SET qloo_attempts=qloo_attempts+CASE WHEN p_kind='qloo' THEN 1 ELSE 0 END,
    model_decisions=model_decisions+CASE WHEN p_kind='model' THEN 1 ELSE 0 END,revision=revision+1 WHERE job_id=p_job;
  INSERT INTO public.discovery_provider_attempts(id,project_id,job_id,kind,operation_key,try_number,request_checksum,reserved_lease_id)
    VALUES(p_id,p_project,p_job,p_kind,p_operation,p_try,p_checksum,p_lease) RETURNING * INTO a; RETURN a;
END;
$$;
CREATE OR REPLACE FUNCTION public.dispatch_discovery_attempt(p_project uuid,p_job uuid,p_lease uuid,p_attempt uuid)
RETURNS public.discovery_provider_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a public.discovery_provider_attempts;
BEGIN
  PERFORM public.tastecase_discovery_lock(p_project,p_job,p_lease);
  UPDATE public.discovery_provider_attempts SET status='dispatched',dispatched_at=clock_timestamp()
    WHERE project_id=p_project AND job_id=p_job AND id=p_attempt AND reserved_lease_id=p_lease AND status='reserved' RETURNING * INTO a;
  IF a.id IS NULL THEN RAISE EXCEPTION 'Attempt is not dispatchable' USING ERRCODE='23514'; END IF; RETURN a;
END;
$$;
CREATE OR REPLACE FUNCTION public.finish_discovery_attempt(p_project uuid,p_job uuid,p_lease uuid,p_attempt uuid,p_status text,p_retryable boolean DEFAULT false,p_category text DEFAULT NULL,p_code text DEFAULT NULL,p_backoff_seconds int DEFAULT 30)
RETURNS public.discovery_provider_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a public.discovery_provider_attempts;
BEGIN
  PERFORM public.tastecase_discovery_lock(p_project,p_job,p_lease);
  IF p_status NOT IN ('accepted','error') OR p_backoff_seconds NOT BETWEEN 1 AND 300 OR (p_retryable AND (p_status<>'error' OR p_category IS DISTINCT FROM 'transient')) THEN RAISE EXCEPTION 'Invalid provider completion' USING ERRCODE='23514'; END IF;
  UPDATE public.discovery_provider_attempts SET status=p_status,finished_at=clock_timestamp(),retryable=p_retryable,error_category=p_category,error_code=p_code,
    next_dispatch_at=CASE WHEN p_retryable THEN clock_timestamp()+p_backoff_seconds*interval '1 second' ELSE NULL END
    WHERE project_id=p_project AND job_id=p_job AND id=p_attempt AND reserved_lease_id=p_lease AND status='dispatched' RETURNING * INTO a;
  IF a.id IS NULL THEN RAISE EXCEPTION 'Attempt completion is fenced' USING ERRCODE='40001'; END IF;
  IF p_retryable THEN UPDATE public.discovery_job_state SET available_at=greatest(available_at,a.next_dispatch_at),revision=revision+1 WHERE job_id=p_job; END IF;
  RETURN a;
END;
$$;
CREATE OR REPLACE FUNCTION public.put_discovery_evidence(p_project uuid,p_job uuid,p_lease uuid,p_id uuid,p_attempt uuid,p_data jsonb,p_checksum text)
RETURNS public.discovery_tool_evidence LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e public.discovery_tool_evidence;
BEGIN
  PERFORM public.tastecase_discovery_lock(p_project,p_job,p_lease);
  SELECT * INTO e FROM public.discovery_tool_evidence WHERE id=p_id;
  IF e.id IS NOT NULL THEN
    IF e.project_id<>p_project OR e.job_id<>p_job OR e.attempt_id IS DISTINCT FROM p_attempt OR e.data<>p_data OR e.checksum<>p_checksum THEN RAISE EXCEPTION 'Evidence checksum/content conflict' USING ERRCODE='23505'; END IF; RETURN e;
  END IF;
  IF octet_length(p_data::text)>(SELECT (pinned_input->'request'->'budgets'->>'outputBytes')::int FROM public.discovery_jobs WHERE id=p_job) THEN RAISE EXCEPTION 'Evidence output budget exceeded' USING ERRCODE='23514'; END IF;
  INSERT INTO public.discovery_tool_evidence(id,project_id,job_id,attempt_id,data,checksum) VALUES(p_id,p_project,p_job,p_attempt,p_data,p_checksum) RETURNING * INTO e; RETURN e;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_validate_discovery_confirmation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE anchor jsonb;
BEGIN
  SELECT a INTO anchor FROM public.discovery_jobs j,jsonb_array_elements(j.pinned_input->'request'->'profiles') p,jsonb_array_elements(p->'anchors') a
    WHERE j.project_id=NEW.project_id AND j.id=NEW.job_id AND a->>'id'=NEW.anchor_id::text;
  IF anchor IS NULL OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=NEW.project_id AND owner_id=NEW.confirmed_by) THEN RAISE EXCEPTION 'Anchor requires project owner confirmation' USING ERRCODE='23514'; END IF;
  IF NEW.resolution_id IS NULL THEN
    IF anchor->>'confirmedEntityId' IS DISTINCT FROM NEW.entity_id::text THEN RAISE EXCEPTION 'Unresolved anchor was not confirmed at queue time' USING ERRCODE='23514'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM public.discovery_anchor_resolutions r,jsonb_array_elements(r.candidates) c WHERE r.project_id=NEW.project_id AND r.job_id=NEW.job_id AND r.id=NEW.resolution_id AND r.anchor_id=NEW.anchor_id AND c->>'entityId'=NEW.entity_id::text AND c->>'kind'=anchor->>'kind') THEN
    RAISE EXCEPTION 'Confirmation must select an observed same-kind candidate' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_guard_discovery_provider_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Provider history cannot be deleted' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.id,NEW.project_id,NEW.job_id,NEW.kind,NEW.operation_key,NEW.try_number,NEW.request_checksum,NEW.reserved_lease_id,NEW.reserved_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.job_id,OLD.kind,OLD.operation_key,OLD.try_number,OLD.request_checksum,OLD.reserved_lease_id,OLD.reserved_at)
    OR NOT ((OLD.status='reserved' AND NEW.status IN ('dispatched','interrupted')) OR (OLD.status='dispatched' AND NEW.status IN ('accepted','error','uncertain')))
    OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at) THEN
    RAISE EXCEPTION 'Provider identity/completion is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_validate_discovery_resolution() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE e jsonb; anchor jsonb;
BEGIN
  SELECT data INTO e FROM public.discovery_tool_evidence WHERE project_id=NEW.project_id AND job_id=NEW.job_id AND id=NEW.evidence_id;
  SELECT a INTO anchor FROM public.discovery_jobs j,jsonb_array_elements(j.pinned_input->'request'->'profiles') p,jsonb_array_elements(p->'anchors') a
    WHERE j.project_id=NEW.project_id AND j.id=NEW.job_id AND a->>'id'=NEW.anchor_id::text;
  IF e IS NULL OR anchor IS NULL OR e->>'kind' IS DISTINCT FROM 'resolve' OR e->>'anchorId' IS DISTINCT FROM NEW.anchor_id::text OR e->'candidates' IS DISTINCT FROM NEW.candidates
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.candidates) c WHERE c->>'kind' IS DISTINCT FROM anchor->>'kind' OR c->>'entityId' IS NULL)
    OR (SELECT count(*) FROM jsonb_array_elements(NEW.candidates))<>(SELECT count(DISTINCT c->>'entityId') FROM jsonb_array_elements(NEW.candidates) c) THEN
    RAISE EXCEPTION 'Resolution must preserve observed same-anchor candidates' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_validate_discovery_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE d jsonb := NEW.data; input jsonb; ref text; mapped jsonb; missing jsonb; unmapped jsonb; a jsonb; b jsonb; c jsonb; allowed text[];
BEGIN
  SELECT pinned_input->'targetInput' INTO input FROM public.discovery_jobs WHERE project_id=NEW.project_id AND id=NEW.job_id;
  allowed := CASE d->>'kind'
    WHEN 'rank' THEN ARRAY['kind','providerStatus','profileId','scope','requestedEntryIds','orderedEntryIds','missingEntryIds','unmappedEntryIds','mappingConfirmationIds','anchorConfirmationIds','error']
    WHEN 'resolve' THEN ARRAY['kind','providerStatus','anchorId','candidates','error']
    WHEN 'facts' THEN ARRAY['kind','rankingEvidenceIds','contrasts','missingEntryIds','unmappedEntryIds','unsupportedReason']
    WHEN 'model_decision' THEN ARRAY['kind','selectedContrastId','rationale'] END;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(d) k WHERE NOT k=ANY(allowed)) THEN RAISE EXCEPTION 'Only normalised task evidence may be stored' USING ERRCODE='23514'; END IF;
  IF d->>'kind' IN ('rank','resolve') AND (d->>'providerStatus' IN ('ok','empty','needs_input','partial','degraded','error')) IS NOT TRUE THEN RAISE EXCEPTION 'Unknown Qloo status' USING ERRCODE='23514'; END IF;
  IF d->'error'->>'category'='auth' AND d->'error'->'retryable'='true'::jsonb THEN RAISE EXCEPTION 'Auth errors cannot be retryable' USING ERRCODE='23514'; END IF;
  IF d->>'kind'='rank' THEN
    IF (jsonb_typeof(d->'requestedEntryIds')='array' AND jsonb_array_length(d->'requestedEntryIds') BETWEEN 1 AND 10
      AND jsonb_typeof(d->'orderedEntryIds')='array' AND jsonb_typeof(d->'missingEntryIds')='array' AND jsonb_typeof(d->'unmappedEntryIds')='array'
      AND jsonb_typeof(d->'mappingConfirmationIds')='array' AND jsonb_typeof(d->'anchorConfirmationIds')='array'
      AND d->>'profileId' IN ('a','b') AND d->>'scope' IN ('full','reduced_pair')) IS NOT TRUE THEN RAISE EXCEPTION 'Malformed rank evidence' USING ERRCODE='23514'; END IF;
    SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO missing FROM jsonb_array_elements_text(d->'requestedEntryIds') WHERE NOT (d->'orderedEntryIds' ? value);
    SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO mapped FROM jsonb_array_elements_text(input->'eligibleCatalogEntryIds') e(value)
      WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(input->'mappings') m WHERE m->>'catalogEntryId'=e.value);
    SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO unmapped FROM jsonb_array_elements_text(input->'eligibleCatalogEntryIds') e(value)
      WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(input->'mappings') m WHERE m->>'catalogEntryId'=e.value);
    IF (SELECT count(*) FROM jsonb_array_elements_text(d->'requestedEntryIds'))<>(SELECT count(DISTINCT value) FROM jsonb_array_elements_text(d->'requestedEntryIds'))
      OR (SELECT count(*) FROM jsonb_array_elements_text(d->'orderedEntryIds'))<>(SELECT count(DISTINCT value) FROM jsonb_array_elements_text(d->'orderedEntryIds'))
      OR NOT ((d->'requestedEntryIds') @> (d->'orderedEntryIds')) OR missing IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM jsonb_array_elements_text(d->'missingEntryIds'))
      OR unmapped IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM jsonb_array_elements_text(d->'unmappedEntryIds'))
      OR NOT (mapped @> (d->'requestedEntryIds')) OR (d->>'scope'='full' AND mapped IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM jsonb_array_elements_text(d->'requestedEntryIds')))
      OR (d->>'scope'='reduced_pair' AND jsonb_array_length(d->'requestedEntryIds')<>2)
      OR (d->>'providerStatus' IN ('empty','needs_input','error') AND jsonb_array_length(d->'orderedEntryIds')>0) THEN RAISE EXCEPTION 'Rank coverage must preserve mapped, omitted and unmapped options' USING ERRCODE='23514'; END IF;
    FOR ref IN SELECT jsonb_array_elements_text(d->'mappingConfirmationIds') LOOP
      IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(input->'mappings') m WHERE m->>'id'=ref) THEN RAISE EXCEPTION 'Rank mapping outside pinned input' USING ERRCODE='23503'; END IF;
    END LOOP;
    FOR ref IN SELECT jsonb_array_elements_text(d->'anchorConfirmationIds') LOOP
      IF NOT EXISTS(SELECT 1 FROM public.discovery_anchor_confirmations WHERE project_id=NEW.project_id AND job_id=NEW.job_id AND id::text=ref) THEN RAISE EXCEPTION 'Rank anchor outside job' USING ERRCODE='23503'; END IF;
    END LOOP;
  ELSIF d->>'kind'='facts' THEN
    IF (jsonb_typeof(d->'contrasts')='array' AND jsonb_array_length(d->'contrasts')<=45 AND jsonb_array_length(d->'rankingEvidenceIds')=2) IS NOT TRUE THEN RAISE EXCEPTION 'Malformed computed facts' USING ERRCODE='23514'; END IF;
    FOR ref IN SELECT jsonb_array_elements_text(d->'rankingEvidenceIds') LOOP
      IF NOT EXISTS(SELECT 1 FROM public.discovery_tool_evidence WHERE project_id=NEW.project_id AND job_id=NEW.job_id AND id::text=ref AND data->>'kind'='rank' AND data->>'scope'='full') THEN RAISE EXCEPTION 'Facts rank outside job' USING ERRCODE='23503'; END IF;
    END LOOP;
    SELECT data INTO a FROM public.discovery_tool_evidence WHERE project_id=NEW.project_id AND job_id=NEW.job_id AND d->'rankingEvidenceIds' ? id::text AND data->>'profileId'='a';
    SELECT data INTO b FROM public.discovery_tool_evidence WHERE project_id=NEW.project_id AND job_id=NEW.job_id AND d->'rankingEvidenceIds' ? id::text AND data->>'profileId'='b';
    IF a IS NULL OR b IS NULL OR a->'requestedEntryIds' IS DISTINCT FROM b->'requestedEntryIds' THEN RAISE EXCEPTION 'Facts need both fixed-catalog ranks' USING ERRCODE='23514'; END IF;
    SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO missing FROM (SELECT value FROM jsonb_array_elements_text(a->'missingEntryIds') UNION SELECT value FROM jsonb_array_elements_text(b->'missingEntryIds')) omissions;
    IF missing IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM jsonb_array_elements_text(d->'missingEntryIds'))
      OR d->'unmappedEntryIds' IS DISTINCT FROM a->'unmappedEntryIds' THEN RAISE EXCEPTION 'Facts cannot discard missing coverage' USING ERRCODE='23514'; END IF;
    FOR c IN SELECT value FROM jsonb_array_elements(d->'contrasts') LOOP
      IF (jsonb_array_length(c->'entryIds')=2 AND c->'entryIds'->>0<>c->'entryIds'->>1 AND c->'orders'->'a'=c->'entryIds'
        AND c->'orders'->'b'=jsonb_build_array(c->'entryIds'->1,c->'entryIds'->0)
        AND a->>'providerStatus' IN ('ok','partial') AND b->>'providerStatus' IN ('ok','partial')
        AND (SELECT ord FROM jsonb_array_elements_text(a->'orderedEntryIds') WITH ORDINALITY t(value,ord) WHERE value=c->'entryIds'->>0)<(SELECT ord FROM jsonb_array_elements_text(a->'orderedEntryIds') WITH ORDINALITY t(value,ord) WHERE value=c->'entryIds'->>1)
        AND (SELECT ord FROM jsonb_array_elements_text(b->'orderedEntryIds') WITH ORDINALITY t(value,ord) WHERE value=c->'entryIds'->>0)>(SELECT ord FROM jsonb_array_elements_text(b->'orderedEntryIds') WITH ORDINALITY t(value,ord) WHERE value=c->'entryIds'->>1)) IS NOT TRUE THEN RAISE EXCEPTION 'Contrast is not an observed reversal' USING ERRCODE='23514'; END IF;
    END LOOP;
  ELSIF d->>'kind'='model_decision' AND d->'selectedContrastId'<>'null'::jsonb THEN
    IF NOT EXISTS(SELECT 1 FROM public.discovery_tool_evidence e,jsonb_array_elements(e.data->'contrasts') contrast WHERE e.project_id=NEW.project_id AND e.job_id=NEW.job_id AND e.data->>'kind'='facts' AND contrast->>'id'=d->>'selectedContrastId') THEN RAISE EXCEPTION 'Model selected unsupported contrast' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.confirm_discovery_anchor(p_project uuid,p_job uuid,p_owner uuid,p_id uuid,p_anchor uuid,p_resolution uuid,p_entity uuid)
RETURNS public.discovery_anchor_confirmations LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.discovery_job_state; c public.discovery_anchor_confirmations;
BEGIN
  SELECT * INTO s FROM public.discovery_job_state WHERE project_id=p_project AND job_id=p_job FOR UPDATE;
  SELECT * INTO c FROM public.discovery_anchor_confirmations WHERE project_id=p_project AND job_id=p_job AND anchor_id=p_anchor;
  IF c.id IS NOT NULL THEN
    IF c.id<>p_id OR c.entity_id<>p_entity OR c.resolution_id IS DISTINCT FROM p_resolution OR c.confirmed_by<>p_owner THEN RAISE EXCEPTION 'Confirmation conflict' USING ERRCODE='23505'; END IF;
    RETURN c;
  END IF;
  IF s.state IS DISTINCT FROM 'needs_confirmation' OR (SELECT deadline_at FROM public.discovery_jobs WHERE id=p_job)<=clock_timestamp() THEN RAISE EXCEPTION 'Job is not awaiting confirmation' USING ERRCODE='23514'; END IF;
  INSERT INTO public.discovery_anchor_confirmations(id,project_id,job_id,anchor_id,resolution_id,entity_id,confirmed_by)
    VALUES(p_id,p_project,p_job,p_anchor,p_resolution,p_entity,p_owner) RETURNING * INTO c;
  IF NOT EXISTS(SELECT 1 FROM public.discovery_jobs j,jsonb_array_elements(j.pinned_input->'request'->'profiles') p,jsonb_array_elements(p->'anchors') a
    WHERE j.id=p_job AND NOT EXISTS(SELECT 1 FROM public.discovery_anchor_confirmations ac WHERE ac.job_id=p_job AND ac.anchor_id::text=a->>'id')) THEN
    UPDATE public.discovery_job_state SET state='resolving',available_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL,revision=revision+1 WHERE job_id=p_job;
  END IF;
  RETURN c;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_validate_discovery_candidate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE input jsonb; ref text;
BEGIN
  SELECT pinned_input->'targetInput' INTO input FROM public.discovery_jobs WHERE project_id=NEW.project_id AND id=NEW.job_id;
  IF (NEW.content->'briefs'->'constraints'=input->'task'->'constraints' AND NEW.content->'briefs'->'eligibleCatalogEntryIds'=input->'eligibleCatalogEntryIds'
    AND NEW.content->'briefs'->'a'->>'provenance'='synthetic' AND NEW.content->'briefs'->'b'->>'provenance'='synthetic'
    AND NEW.content->'proposedExpectation'->>'classification'='advisory' AND NEW.content->'proposedExpectation'->'automaticFailure'='false'::jsonb
    AND NEW.content->'proposedExpectation'->'humanReviewRequired'='true'::jsonb
    AND NEW.content->'proposedExpectation'->>'contrastId'=NEW.content->'contrast'->>'id'
    AND jsonb_array_length(NEW.content->'evidenceIds') BETWEEN 1 AND 20 AND jsonb_array_length(NEW.content->'targetAttemptIds')<=12) IS NOT TRUE THEN
    RAISE EXCEPTION 'Candidate must preserve fixed constraints and advisory boundary' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.discovery_tool_evidence e,jsonb_array_elements(e.data->'contrasts') c WHERE e.project_id=NEW.project_id AND e.job_id=NEW.job_id AND e.data->>'kind'='facts' AND c=NEW.content->'contrast' AND NEW.content->'evidenceIds' ? e.id::text) THEN RAISE EXCEPTION 'Candidate needs an observed computed contrast' USING ERRCODE='23514'; END IF;
  FOR ref IN SELECT jsonb_array_elements_text(NEW.content->'evidenceIds') LOOP
    IF NOT EXISTS(SELECT 1 FROM public.discovery_tool_evidence WHERE project_id=NEW.project_id AND job_id=NEW.job_id AND id::text=ref) THEN RAISE EXCEPTION 'Evidence outside candidate job' USING ERRCODE='23503'; END IF;
  END LOOP;
  FOR ref IN SELECT jsonb_array_elements_text(NEW.content->'targetAttemptIds') LOOP
    IF NOT EXISTS(SELECT 1 FROM public.discovery_job_targets WHERE project_id=NEW.project_id AND job_id=NEW.job_id AND attempt_id::text=ref) THEN RAISE EXCEPTION 'Target outside candidate job' USING ERRCODE='23503'; END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_pin_discovery_candidate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.discovery_candidate_evidence SELECT NEW.project_id,NEW.job_id,NEW.id,value::uuid FROM jsonb_array_elements_text(NEW.content->'evidenceIds');
  INSERT INTO public.discovery_candidate_targets SELECT NEW.project_id,NEW.job_id,NEW.id,value::uuid FROM jsonb_array_elements_text(NEW.content->'targetAttemptIds');
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.put_discovery_candidate(p_project uuid,p_job uuid,p_lease uuid,p_id uuid,p_content jsonb,p_checksum text)
RETURNS public.discovery_candidates LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c public.discovery_candidates;
BEGIN
  PERFORM public.tastecase_discovery_lock(p_project,p_job,p_lease);
  SELECT * INTO c FROM public.discovery_candidates WHERE id=p_id;
  IF c.id IS NOT NULL THEN
    IF c.project_id<>p_project OR c.job_id<>p_job OR c.content<>p_content OR c.checksum<>p_checksum THEN RAISE EXCEPTION 'Candidate checksum/content conflict' USING ERRCODE='23505'; END IF; RETURN c;
  END IF;
  INSERT INTO public.discovery_candidates(id,project_id,job_id,content,checksum) VALUES(p_id,p_project,p_job,p_content,p_checksum) RETURNING * INTO c; RETURN c;
END;
$$;
CREATE OR REPLACE FUNCTION public.schedule_discovery_target(p_project uuid,p_job uuid,p_lease uuid,p_attempt uuid,p_task uuid,p_input jsonb,p_checksum text,p_profile text,p_round int,p_repeat int,p_variant text)
RETURNS public.discovery_job_targets LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE j public.discovery_jobs; a public.discovery_job_targets;
BEGIN
  PERFORM public.tastecase_discovery_lock(p_project,p_job,p_lease);
  SELECT * INTO j FROM public.discovery_jobs WHERE id=p_job;
  SELECT * INTO a FROM public.discovery_job_targets WHERE job_id=p_job AND profile_id=p_profile AND round=p_round AND repeat=p_repeat AND variant=p_variant;
  IF a.attempt_id IS NOT NULL THEN
    IF a.attempt_id<>p_attempt OR NOT EXISTS(SELECT 1 FROM public.target_attempts WHERE id=p_attempt AND pinned_input=p_input AND input_checksum=p_checksum AND task_version_id=p_task) THEN RAISE EXCEPTION 'Target scheduling conflict' USING ERRCODE='23505'; END IF; RETURN a;
  END IF;
  IF p_round NOT BETWEEN 0 AND (j.pinned_input->'request'->'budgets'->>'rounds')::int-1 OR p_repeat NOT BETWEEN 0 AND (j.pinned_input->'request'->>'repeatCount')::int-1
    OR p_profile NOT IN ('a','b') OR p_variant NOT IN ('full','reduced_pair') OR (p_variant='reduced_pair' AND j.pinned_input->'request'->'reducePair'<>'true'::jsonb)
    OR p_input->'task'->'constraints' IS DISTINCT FROM j.pinned_input->'targetInput'->'task'->'constraints'
    OR p_input->'eligibleCatalogEntryIds' IS DISTINCT FROM j.pinned_input->'targetInput'->'eligibleCatalogEntryIds'
    OR p_input->'catalog' IS DISTINCT FROM j.pinned_input->'targetInput'->'catalog'
    OR p_input->'mappings' IS DISTINCT FROM j.pinned_input->'targetInput'->'mappings' THEN RAISE EXCEPTION 'Target scheduling must preserve fixed practical constraints and catalog' USING ERRCODE='23514'; END IF;
  UPDATE public.discovery_job_state SET target_attempts=target_attempts+1,revision=revision+1 WHERE job_id=p_job;
  INSERT INTO public.target_attempts(id,project_id,catalog_version_id,task_version_id,pinned_input,input_checksum) VALUES(p_attempt,p_project,j.catalog_version_id,p_task,p_input,p_checksum);
  INSERT INTO public.discovery_job_targets(attempt_id,project_id,job_id,catalog_version_id,profile_id,round,repeat,variant)
    VALUES(p_attempt,p_project,p_job,j.catalog_version_id,p_profile,p_round,p_repeat,p_variant) RETURNING * INTO a; RETURN a;
END;
$$;
-- Runs in addition to, not instead of, Gate 1's lease/result guard. Cancellation
-- locks only job state; claims lock target then state. No cancelled-row rewrites.
CREATE OR REPLACE FUNCTION public.discovery_target_claimable(p_attempt uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT EXISTS(SELECT 1 FROM public.discovery_job_targets a JOIN public.discovery_job_state s ON s.job_id=a.job_id JOIN public.discovery_jobs j ON j.id=a.job_id
    WHERE a.attempt_id=p_attempt AND (s.state IN ('awaiting_review','no_useful_contrast','unavailable','partial','budget_exhausted','deadline_exceeded','cancelled','failed') OR j.deadline_at<=clock_timestamp()
      OR (EXISTS(SELECT 1 FROM public.discovery_target_dispatches d WHERE d.attempt_id=p_attempt) AND s.target_attempts>=(j.pinned_input->'request'->'budgets'->>'targetAttempts')::int)))
$$;
CREATE OR REPLACE FUNCTION public.tastecase_guard_discovery_target_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a public.discovery_job_targets; s public.discovery_job_state; n int;
BEGIN
  IF NEW.status<>'leased' THEN RETURN NEW; END IF;
  SELECT * INTO a FROM public.discovery_job_targets WHERE attempt_id=NEW.id;
  IF a.attempt_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO s FROM public.discovery_job_state WHERE job_id=a.job_id FOR UPDATE;
  IF s.state IN ('awaiting_review','no_useful_contrast','unavailable','partial','budget_exhausted','deadline_exceeded','cancelled','failed')
    OR (SELECT deadline_at FROM public.discovery_jobs WHERE id=a.job_id)<=clock_timestamp() THEN RAISE EXCEPTION 'Discovery target claim stopped' USING ERRCODE='23514'; END IF;
  SELECT count(*)::int INTO n FROM public.discovery_target_dispatches WHERE attempt_id=NEW.id;
  -- Reclaim may redispatch a crashed/uncertain target call, so charge again first.
  IF n>0 THEN UPDATE public.discovery_job_state SET target_attempts=target_attempts+1,revision=revision+1 WHERE job_id=a.job_id; END IF;
  INSERT INTO public.discovery_target_dispatches(lease_id,project_id,job_id,attempt_id,ordinal) VALUES(NEW.lease_id,a.project_id,a.job_id,NEW.id,n);
  RETURN NEW;
END;
$$;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['discovery_jobs','discovery_tool_evidence','discovery_anchor_resolutions','discovery_anchor_confirmations','discovery_candidates','discovery_candidate_evidence','discovery_job_targets','discovery_target_dispatches','discovery_candidate_targets'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS tastecase_immutable ON public.%I',table_name);
    EXECUTE format('CREATE TRIGGER tastecase_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.tastecase_immutable()',table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['discovery_jobs','discovery_job_state','discovery_provider_attempts','discovery_tool_evidence','discovery_anchor_resolutions','discovery_anchor_confirmations','discovery_candidates','discovery_candidate_evidence','discovery_job_targets','discovery_target_dispatches','discovery_candidate_targets'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',table_name);
    EXECUTE format('DROP POLICY IF EXISTS tastecase_owner_read ON public.%I',table_name);
    EXECUTE format('CREATE POLICY tastecase_owner_read ON public.%I FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.projects p WHERE p.id=project_id AND p.owner_id=(SELECT auth.uid())))',table_name);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated',table_name);
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM service_role',table_name);
      EXECUTE format('GRANT SELECT ON public.%I TO service_role',table_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT INSERT ON public.discovery_jobs,public.discovery_anchor_resolutions,public.discovery_anchor_confirmations TO service_role;
  END IF;
END;
$$;
DROP TRIGGER IF EXISTS tastecase_validate_discovery_job ON public.discovery_jobs;
CREATE TRIGGER tastecase_validate_discovery_job BEFORE INSERT ON public.discovery_jobs FOR EACH ROW EXECUTE FUNCTION public.tastecase_validate_discovery_job();
DROP TRIGGER IF EXISTS tastecase_initialise_discovery_job ON public.discovery_jobs;
CREATE TRIGGER tastecase_initialise_discovery_job AFTER INSERT ON public.discovery_jobs FOR EACH ROW EXECUTE FUNCTION public.tastecase_initialise_discovery_job();
DROP TRIGGER IF EXISTS tastecase_guard_discovery_state ON public.discovery_job_state;
CREATE TRIGGER tastecase_guard_discovery_state BEFORE UPDATE OR DELETE ON public.discovery_job_state FOR EACH ROW EXECUTE FUNCTION public.tastecase_guard_discovery_state();
DROP TRIGGER IF EXISTS tastecase_validate_discovery_confirmation ON public.discovery_anchor_confirmations;
CREATE TRIGGER tastecase_validate_discovery_confirmation BEFORE INSERT ON public.discovery_anchor_confirmations FOR EACH ROW EXECUTE FUNCTION public.tastecase_validate_discovery_confirmation();
DROP TRIGGER IF EXISTS tastecase_guard_discovery_provider_attempt ON public.discovery_provider_attempts;
CREATE TRIGGER tastecase_guard_discovery_provider_attempt BEFORE UPDATE OR DELETE ON public.discovery_provider_attempts FOR EACH ROW EXECUTE FUNCTION public.tastecase_guard_discovery_provider_attempt();
DROP TRIGGER IF EXISTS tastecase_validate_discovery_resolution ON public.discovery_anchor_resolutions;
CREATE TRIGGER tastecase_validate_discovery_resolution BEFORE INSERT ON public.discovery_anchor_resolutions FOR EACH ROW EXECUTE FUNCTION public.tastecase_validate_discovery_resolution();
DROP TRIGGER IF EXISTS tastecase_validate_discovery_evidence ON public.discovery_tool_evidence;
CREATE TRIGGER tastecase_validate_discovery_evidence BEFORE INSERT ON public.discovery_tool_evidence FOR EACH ROW EXECUTE FUNCTION public.tastecase_validate_discovery_evidence();
DROP TRIGGER IF EXISTS tastecase_validate_discovery_candidate ON public.discovery_candidates;
CREATE TRIGGER tastecase_validate_discovery_candidate BEFORE INSERT ON public.discovery_candidates FOR EACH ROW EXECUTE FUNCTION public.tastecase_validate_discovery_candidate();
DROP TRIGGER IF EXISTS tastecase_pin_discovery_candidate ON public.discovery_candidates;
CREATE TRIGGER tastecase_pin_discovery_candidate AFTER INSERT ON public.discovery_candidates FOR EACH ROW EXECUTE FUNCTION public.tastecase_pin_discovery_candidate();
DROP TRIGGER IF EXISTS tastecase_guard_discovery_target_claim ON public.target_attempts;
CREATE TRIGGER tastecase_guard_discovery_target_claim BEFORE UPDATE ON public.target_attempts FOR EACH ROW EXECUTE FUNCTION public.tastecase_guard_discovery_target_claim();
-- Functions are backend-only. In particular no owner/runner may mint leases,
-- bypass budgets or forge evidence through PostgREST RPC.
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT oid::regprocedure AS signature,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND
    (proname LIKE '%discovery%' OR proname IN ('claim_discovery_job','renew_discovery_lease','advance_discovery_job','cancel_discovery_job','reserve_discovery_attempt','dispatch_discovery_attempt','finish_discovery_attempt','put_discovery_evidence','confirm_discovery_anchor','put_discovery_candidate','schedule_discovery_target')) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') AND f.proname NOT LIKE 'tastecase_%' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature); END IF;
  END LOOP;
END;
$$;
