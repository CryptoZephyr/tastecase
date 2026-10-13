-- Gate 3. Only the authenticated owner's backend may call mutation RPCs. The
-- database resolves evidence itself; requests contain no evidence, owner or hash.
-- Canonical JSON matches contracts: UTF-16 object ordering, ordered arrays,
-- shortest IEEE-754 numbers and no insignificant whitespace.
CREATE OR REPLACE FUNCTION public.tastecase_utf16_key(value text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
DECLARE result text := ''; point int; i int;
BEGIN
  FOR i IN 1..length(value) LOOP
    point := ascii(substr(value,i,1));
    IF point > 65535 THEN
      result := result || lpad(to_hex(55296+(point-65536)/1024),4,'0') || lpad(to_hex(56320+(point-65536)%1024),4,'0');
    ELSE result := result || lpad(to_hex(point),4,'0'); END IF;
  END LOOP;
  RETURN decode(result,'hex');
END;
$$;
CREATE OR REPLACE FUNCTION public.canonical_json(value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, public SET extra_float_digits = 3 AS $$
DECLARE result text; n double precision; coefficient text; exponent int; binary_exponent int; mantissa bigint; bytes bytea;
  exact numeric; rounded numeric; step numeric; precision int; i int;
BEGIN
  CASE jsonb_typeof(value)
  WHEN 'object' THEN
    SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.canonical_json(val),',' ORDER BY public.tastecase_utf16_key(key)),'')||'}'
      INTO result FROM jsonb_each(value) t(key,val);
  WHEN 'array' THEN
    SELECT '['||coalesce(string_agg(public.canonical_json(val),',' ORDER BY ordinal),'')||']'
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY t(val,ordinal);
  WHEN 'number' THEN
    n := (value::text)::double precision;
    IF n = 0 THEN RETURN '0'; END IF;
    IF n::text IN ('Infinity','-Infinity','NaN') THEN RAISE EXCEPTION 'Nonfinite JSON number' USING ERRCODE='23514'; END IF;
    result := abs(n)::text;
    IF result LIKE '%e%' THEN exponent := split_part(result,'e',2)::int;
    ELSIF abs(n)>=1 THEN exponent := length(split_part(result,'.',1))-1;
    ELSE coefficient := split_part(result,'.',2); exponent := -(length(coefficient)-length(ltrim(coefficient,'0')))-1; END IF;
    -- PostgreSQL's shortest float output avoids midpoint endpoints that ECMA-262
    -- permits. Decode the exact IEEE value, then choose the shortest round-trip
    -- decimal nearest to it, preferring an even significand in exact ties.
    bytes := float8send(abs(n)); binary_exponent := ((get_byte(bytes,0)&127)<<4)+(get_byte(bytes,1)>>4);
    mantissa := get_byte(bytes,1)&15;
    FOR i IN 2..7 LOOP mantissa := mantissa*256+get_byte(bytes,i); END LOOP;
    IF binary_exponent=0 THEN binary_exponent := -1074;
    ELSE mantissa := mantissa+4503599627370496; binary_exponent := binary_exponent-1075; END IF;
    IF binary_exponent>=0 THEN exact := mantissa::numeric*power(2::numeric,binary_exponent);
    ELSE exact := ((mantissa::numeric*power(5::numeric,-binary_exponent))::text||'e'||binary_exponent::text)::numeric; END IF;
    FOR precision IN 1..17 LOOP
      rounded := round(exact,precision-1-exponent); step := ('1e'||(exponent-precision+1)::text)::numeric;
      IF abs(rounded-exact)*2=step AND mod(rounded/step,2)=1 THEN rounded := rounded-step; END IF;
      BEGIN
        EXIT WHEN rounded::double precision=abs(n);
      EXCEPTION WHEN numeric_value_out_of_range THEN NULL; -- Trial may overflow at the largest finite double.
      END;
    END LOOP;
    result := rounded::text;
    IF abs(n)>=0.000001 AND abs(n)<1e21 THEN
      IF result LIKE '%.%' THEN result := rtrim(rtrim(result,'0'),'.'); END IF;
    ELSE
      IF rounded>=1 THEN exponent := length(split_part(result,'.',1))-1;
      ELSE coefficient := split_part(result,'.',2); exponent := -(length(coefficient)-length(ltrim(coefficient,'0')))-1; END IF;
      coefficient := rtrim(ltrim(replace(result,'.',''),'0'),'0');
      result := left(coefficient,1)||CASE WHEN length(coefficient)>1 THEN '.'||substr(coefficient,2) ELSE '' END
        ||'e'||CASE WHEN exponent>=0 THEN '+' ELSE '-' END||abs(exponent)::text;
    END IF;
    IF n<0 THEN result := '-'||result; END IF;
  ELSE result := value::text;
  END CASE;
  RETURN result;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_json_checksum(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(public.canonical_json(value),'UTF8')),'hex')
$$;
CREATE OR REPLACE FUNCTION public.tastecase_review_id(p_id uuid,p_operation text) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
  SELECT (substr(h,1,8)||'-'||substr(h,9,4)||'-5'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12))::uuid
  FROM (SELECT public.tastecase_json_checksum(jsonb_build_array('tastecase-discovery-v1',p_id::text,p_operation,0)) AS h) t
$$;
CREATE OR REPLACE FUNCTION public.tastecase_review_time(value timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
  SELECT to_char(value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
CREATE OR REPLACE FUNCTION public.tastecase_review_owner(p_project uuid,p_owner uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project AND owner_id=p_owner) THEN
    RAISE EXCEPTION 'Review requires the project owner' USING ERRCODE='42501';
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_review_object(value jsonb,keys text[]) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR NOT (value ?& keys)
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(value) k WHERE NOT k=ANY(keys)) THEN
    RAISE EXCEPTION 'Invalid review object fields' USING ERRCODE='23514';
  END IF;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS discovery_candidate_checksum_ref ON public.discovery_candidates(project_id,job_id,id,checksum);
CREATE TABLE IF NOT EXISTS public.review_cases (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, job_id uuid NOT NULL, candidate_id uuid NOT NULL,
  candidate_checksum text NOT NULL, created_at timestamptz NOT NULL, case_json jsonb NOT NULL,
  UNIQUE(project_id,id), UNIQUE(project_id,job_id,candidate_id),
  UNIQUE(project_id,id,job_id,candidate_id,candidate_checksum),
  FOREIGN KEY(project_id,job_id,candidate_id,candidate_checksum) REFERENCES public.discovery_candidates(project_id,job_id,id,checksum),
  CHECK(case_json->>'id'=id::text AND case_json->>'projectId'=project_id::text AND case_json->>'jobId'=job_id::text
    AND case_json->>'candidateId'=candidate_id::text AND case_json->>'candidateChecksum'=candidate_checksum)
);
CREATE TABLE IF NOT EXISTS public.review_decisions (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, case_id uuid NOT NULL, job_id uuid NOT NULL, candidate_id uuid NOT NULL,
  candidate_checksum text NOT NULL, expected_revision bigint NOT NULL CHECK(expected_revision BETWEEN 0 AND 9007199254740990),
  revision bigint NOT NULL CHECK(revision=expected_revision+1), action text NOT NULL CHECK(action IN ('accept','edit','reject','defer')),
  reviewed_by uuid NOT NULL, request_checksum text NOT NULL, receipt jsonb NOT NULL, checksum text NOT NULL, created_at timestamptz NOT NULL,
  UNIQUE(project_id,case_id,id,revision), UNIQUE(project_id,case_id,revision),
  FOREIGN KEY(project_id,case_id,job_id,candidate_id,candidate_checksum) REFERENCES public.review_cases(project_id,id,job_id,candidate_id,candidate_checksum),
  CHECK(checksum=public.tastecase_json_checksum(receipt-'checksum')),
  CHECK(octet_length(public.canonical_json(receipt))<=2162688)
);
CREATE TABLE IF NOT EXISTS public.expectation_versions (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, case_id uuid NOT NULL, job_id uuid NOT NULL, candidate_id uuid NOT NULL,
  candidate_checksum text NOT NULL, review_decision_id uuid NOT NULL, review_revision bigint NOT NULL,
  expectation jsonb NOT NULL, evidence_checksum text NOT NULL, version_json jsonb NOT NULL, checksum text NOT NULL, created_at timestamptz NOT NULL,
  UNIQUE(project_id,case_id,id,review_revision), UNIQUE(project_id,case_id,review_decision_id),
  FOREIGN KEY(project_id,case_id,job_id,candidate_id,candidate_checksum) REFERENCES public.review_cases(project_id,id,job_id,candidate_id,candidate_checksum),
  FOREIGN KEY(project_id,case_id,review_decision_id,review_revision) REFERENCES public.review_decisions(project_id,case_id,id,revision),
  CHECK(expectation->>'classification' IN ('objective_contract','approved_policy','advisory')),
  CHECK(checksum=public.tastecase_json_checksum(version_json-'checksum'))
);
CREATE TABLE IF NOT EXISTS public.review_heads (
  project_id uuid NOT NULL, case_id uuid PRIMARY KEY, job_id uuid NOT NULL, candidate_id uuid NOT NULL, candidate_checksum text NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
  status text NOT NULL DEFAULT 'unreviewed' CHECK(status IN ('unreviewed','accepted','edited','rejected','deferred')),
  last_decision_id uuid, approved_expectation_version_id uuid,
  UNIQUE(project_id,case_id),
  FOREIGN KEY(project_id,case_id,job_id,candidate_id,candidate_checksum) REFERENCES public.review_cases(project_id,id,job_id,candidate_id,candidate_checksum),
  FOREIGN KEY(project_id,case_id,last_decision_id,revision) REFERENCES public.review_decisions(project_id,case_id,id,revision),
  FOREIGN KEY(project_id,case_id,approved_expectation_version_id,revision) REFERENCES public.expectation_versions(project_id,case_id,id,review_revision),
  CHECK((revision=0)=(status='unreviewed') AND (revision=0)=(last_decision_id IS NULL)),
  CHECK((status IN ('accepted','edited'))=(approved_expectation_version_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS public.suites (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES public.projects(id), name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160),
  current_version bigint NOT NULL DEFAULT 0 CHECK(current_version BETWEEN 0 AND 9007199254740991), created_at timestamptz NOT NULL,
  UNIQUE(project_id,id)
);
CREATE TABLE IF NOT EXISTS public.suite_versions (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, suite_id uuid NOT NULL, expected_version bigint NOT NULL CHECK(expected_version BETWEEN 0 AND 9007199254740990),
  version bigint NOT NULL CHECK(version=expected_version+1), request_checksum text NOT NULL, published_by uuid NOT NULL,
  snapshot jsonb NOT NULL, checksum text NOT NULL, created_at timestamptz NOT NULL,
  UNIQUE(project_id,suite_id,version), UNIQUE(project_id,suite_id,id),
  FOREIGN KEY(project_id,suite_id) REFERENCES public.suites(project_id,id),
  CHECK(checksum=public.tastecase_json_checksum(snapshot-'checksum')),
  CHECK(octet_length(public.canonical_json(snapshot))<=8388608 AND jsonb_array_length(snapshot->'cases') BETWEEN 1 AND 50)
);
CREATE TABLE IF NOT EXISTS public.suite_version_cases (
  project_id uuid NOT NULL, suite_id uuid NOT NULL, suite_version_id uuid NOT NULL, ordinal int NOT NULL CHECK(ordinal BETWEEN 0 AND 49),
  case_id uuid NOT NULL, review_decision_id uuid NOT NULL, review_revision bigint NOT NULL, expectation_version_id uuid NOT NULL,
  PRIMARY KEY(suite_version_id,case_id), UNIQUE(suite_version_id,ordinal),
  FOREIGN KEY(project_id,suite_id,suite_version_id) REFERENCES public.suite_versions(project_id,suite_id,id),
  FOREIGN KEY(project_id,case_id,review_decision_id,review_revision) REFERENCES public.review_decisions(project_id,case_id,id,revision),
  FOREIGN KEY(project_id,case_id,expectation_version_id,review_revision) REFERENCES public.expectation_versions(project_id,case_id,id,review_revision)
);
CREATE INDEX IF NOT EXISTS review_cases_window ON public.review_cases(project_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS review_decisions_window ON public.review_decisions(project_id,case_id,revision DESC);
CREATE INDEX IF NOT EXISTS suites_window ON public.suites(project_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS suite_versions_window ON public.suite_versions(project_id,suite_id,version DESC);

CREATE OR REPLACE FUNCTION public.tastecase_review_head(p_row public.review_heads) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
 SELECT jsonb_build_object('schema_version','1.0.0','projectId',p_row.project_id,'caseId',p_row.case_id,'jobId',p_row.job_id,
   'candidateId',p_row.candidate_id,'revision',p_row.revision,'status',p_row.status,'lastDecisionId',p_row.last_decision_id,
   'approvedExpectationVersionId',p_row.approved_expectation_version_id)
$$;
CREATE OR REPLACE FUNCTION public.tastecase_suite_identity(p_row public.suites) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
 SELECT jsonb_build_object('schema_version','1.0.0','id',p_row.id,'projectId',p_row.project_id,'name',p_row.name,
   'currentVersion',p_row.current_version,'createdAt',public.tastecase_review_time(p_row.created_at))
$$;
CREATE OR REPLACE FUNCTION public.tastecase_review_record(p_decision uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
 SELECT jsonb_build_object('decision',d.receipt,'expectationVersion',v.version_json)
 FROM public.review_decisions d LEFT JOIN public.expectation_versions v ON v.project_id=d.project_id AND v.case_id=d.case_id AND v.review_decision_id=d.id
 WHERE d.id=p_decision
$$;
-- STABLE is important: this entire source assembly uses ONE MVCC statement
-- snapshot, including mutable target status, result and dispatch completeness.
CREATE OR REPLACE FUNCTION public.tastecase_review_source(p_project uuid,p_job uuid,p_candidate uuid,p_captured timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
SELECT jsonb_build_object('schema_version','1.0.0','projectId',j.project_id,'jobId',j.id,'capturedAt',public.tastecase_review_time(p_captured),
 'candidate',jsonb_build_object('schema_version',c.schema_version,'id',c.id,'projectId',c.project_id,'jobId',c.job_id,'content',c.content,'checksum',c.checksum,'createdAt',public.tastecase_review_time(c.created_at)),
 'job',jsonb_build_object('schema_version',j.schema_version,'id',j.id,'projectId',j.project_id,'input',j.pinned_input,'inputChecksum',j.input_checksum,
   'state',s.state,'checkpoint',(ARRAY['pinned','anchors','ranks','selection','targets','investigation','saved'])[s.checkpoint+1],
   'checkpointData',s.checkpoint_data,'counters',jsonb_build_object('qlooAttempts',s.qloo_attempts,'modelDecisions',s.model_decisions,'targetAttempts',s.target_attempts,'rounds',s.rounds),
   'revision',s.revision,'leaseId',s.lease_id,'leaseExpiresAt',public.tastecase_review_time(s.lease_expires_at),'availableAt',public.tastecase_review_time(s.available_at),
   'deadlineAt',public.tastecase_review_time(j.deadline_at),'createdAt',public.tastecase_review_time(j.created_at),'cancelledAt',public.tastecase_review_time(s.cancelled_at),'reason',s.reason),
 'resolutions',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema_version','1.0.0','id',r.id,'projectId',r.project_id,'jobId',r.job_id,
   'anchorId',r.anchor_id,'evidenceId',r.evidence_id,'candidates',r.candidates,'createdAt',public.tastecase_review_time(r.created_at)) ORDER BY r.created_at,r.id),'[]')
   FROM public.discovery_anchor_resolutions r WHERE r.project_id=j.project_id AND r.job_id=j.id),
 'confirmations',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema_version','1.0.0','id',r.id,'projectId',r.project_id,'jobId',r.job_id,
   'anchorId',r.anchor_id,'resolutionId',r.resolution_id,'entityId',r.entity_id,'confirmedBy',r.confirmed_by,'createdAt',public.tastecase_review_time(r.created_at)) ORDER BY r.created_at,r.id),'[]')
   FROM public.discovery_anchor_confirmations r WHERE r.project_id=j.project_id AND r.job_id=j.id),
 'evidence',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema_version',e.schema_version,'id',e.id,'projectId',e.project_id,'jobId',e.job_id,
   'attemptId',e.attempt_id,'data',e.data,'checksum',e.checksum,'capturedAt',public.tastecase_review_time(e.captured_at)) ORDER BY e.captured_at,e.id),'[]')
   FROM public.discovery_tool_evidence e WHERE e.project_id=j.project_id AND e.job_id=j.id),
 'providerAttempts',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'projectId',a.project_id,'jobId',a.job_id,'kind',a.kind,'operationKey',a.operation_key,
   'tryNumber',a.try_number,'requestChecksum',a.request_checksum,'reservedLeaseId',a.reserved_lease_id,'status',a.status,'reservedAt',public.tastecase_review_time(a.reserved_at),
   'dispatchedAt',public.tastecase_review_time(a.dispatched_at),'finishedAt',public.tastecase_review_time(a.finished_at),'retryable',a.retryable,'errorCategory',a.error_category,
   'errorCode',a.error_code,'nextDispatchAt',public.tastecase_review_time(a.next_dispatch_at)) ORDER BY a.reserved_at,a.id),'[]')
   FROM public.discovery_provider_attempts a WHERE a.project_id=j.project_id AND a.job_id=j.id),
 'targets',(SELECT coalesce(jsonb_agg(jsonb_build_object(
   'association',jsonb_build_object('attemptId',t.attempt_id,'profileId',t.profile_id,'round',t.round,'repeat',t.repeat,'variant',t.variant,'status',a.status,
     'cancelled',s.cancelled_at IS NOT NULL,'dispatchCount',(SELECT count(*) FROM public.discovery_target_dispatches d WHERE d.attempt_id=a.id),
     'uncertainDispatches',(SELECT count(*) FROM public.discovery_target_dispatches d WHERE d.attempt_id=a.id AND (d.lease_id IS DISTINCT FROM a.lease_id OR (a.status='leased' AND a.lease_expires_at<=p_captured)))),
   'attempt',jsonb_build_object('schema_version',a.schema_version,'id',a.id,'projectId',a.project_id,'catalogVersionId',a.catalog_version_id,'taskVersionId',a.task_version_id,
     'mappingConfirmationIds',(SELECT coalesce(jsonb_agg(m.mapping_confirmation_id ORDER BY m.mapping_confirmation_id),'[]') FROM public.target_attempt_mappings m WHERE m.attempt_id=a.id),
     'status',a.status,'input',a.pinned_input,'inputChecksum',a.input_checksum,'leaseId',a.lease_id,'leaseCredentialId',a.lease_credential_id,
     'leaseExpiresAt',public.tastecase_review_time(a.lease_expires_at),'result',a.result,'resultChecksum',a.result_checksum,'createdAt',public.tastecase_review_time(a.created_at),
     'completedAt',public.tastecase_review_time(a.completed_at))) ORDER BY t.created_at,t.attempt_id),'[]')
   FROM public.discovery_job_targets t JOIN public.target_attempts a ON a.project_id=t.project_id AND a.id=t.attempt_id WHERE t.project_id=j.project_id AND t.job_id=j.id))
FROM public.discovery_jobs j JOIN public.discovery_job_state s ON s.project_id=j.project_id AND s.job_id=j.id
JOIN public.discovery_candidates c ON c.project_id=j.project_id AND c.job_id=j.id AND c.id=p_candidate
WHERE j.project_id=p_project AND j.id=p_job
$$;
CREATE OR REPLACE FUNCTION public.tastecase_pin_review(source jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE coverage jsonb; limits jsonb; result jsonb; row jsonb; facts jsonb; rank_a jsonb; rank_b jsonb;
  contrast jsonb := source->'candidate'->'content'->'contrast'; input jsonb := source->'job'->'input'->'targetInput';
BEGIN
  IF source IS NULL OR jsonb_array_length(source->'resolutions')>20 OR jsonb_array_length(source->'confirmations')>10
    OR jsonb_array_length(source->'evidence')>50 OR jsonb_array_length(source->'providerAttempts')>28 OR jsonb_array_length(source->'targets')>12 THEN
    RAISE EXCEPTION 'Review evidence is absent or exceeds bounds' USING ERRCODE='23514';
  END IF;
  IF source->'job'->>'inputChecksum' IS DISTINCT FROM public.tastecase_json_checksum(source->'job'->'input')
    OR source->'candidate'->>'checksum' IS DISTINCT FROM public.tastecase_json_checksum(source->'candidate'->'content')
    OR input->'catalog'->>'checksum' IS DISTINCT FROM public.tastecase_json_checksum((input->'catalog')-ARRAY['projectId','checksum','createdAt'])
    OR input->'task'->>'checksum' IS DISTINCT FROM public.tastecase_json_checksum((input->'task')-ARRAY['projectId','checksum','createdAt'])
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(source->'evidence') e WHERE e->>'checksum' IS DISTINCT FROM public.tastecase_json_checksum(e->'data')) THEN
    RAISE EXCEPTION 'Stored review source checksum mismatch' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(source->'candidate'->'content'->'evidenceIds') id WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source->'evidence') e WHERE e->>'id'=id))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(source->'candidate'->'content'->'targetAttemptIds') id WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source->'targets') e WHERE e->'attempt'->>'id'=id)) THEN
    RAISE EXCEPTION 'Candidate source references are incomplete' USING ERRCODE='23503';
  END IF;
  SELECT e->'data' INTO facts FROM jsonb_array_elements(source->'evidence') e
    WHERE e->'data'->>'kind'='facts' AND source->'candidate'->'content'->'evidenceIds' ? (e->>'id')
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(e->'data'->'contrasts') c WHERE c=contrast) LIMIT 1;
  SELECT e->'data' INTO rank_a FROM jsonb_array_elements(source->'evidence') e WHERE e->>'id'=facts->'rankingEvidenceIds'->>0;
  SELECT e->'data' INTO rank_b FROM jsonb_array_elements(source->'evidence') e WHERE e->>'id'=facts->'rankingEvidenceIds'->>1;
  IF (facts IS NOT NULL AND rank_a->>'kind'='rank' AND rank_b->>'kind'='rank'
    AND rank_a->>'scope'='full' AND rank_b->>'scope'='full' AND rank_a->>'profileId'='a' AND rank_b->>'profileId'='b'
    AND rank_a->>'providerStatus' IN ('ok','partial') AND rank_b->>'providerStatus' IN ('ok','partial')
    AND rank_a->'requestedEntryIds'=rank_b->'requestedEntryIds' AND rank_a->'unmappedEntryIds'=rank_b->'unmappedEntryIds'
    AND source->'candidate'->'content'->'briefs'->'constraints'=input->'task'->'constraints'
    AND contrast->'entryIds'->>0<>contrast->'entryIds'->>1
    AND input->'eligibleCatalogEntryIds' ? (contrast->'entryIds'->>0) AND input->'eligibleCatalogEntryIds' ? (contrast->'entryIds'->>1)
    AND contrast->'orders'->'a'=contrast->'entryIds' AND contrast->'orders'->'b'=jsonb_build_array(contrast->'entryIds'->>1,contrast->'entryIds'->>0)
    AND contrast->>'id'=public.tastecase_review_id((source->>'jobId')::uuid,'contrast:'||public.tastecase_json_checksum(contrast->'entryIds'))::text
    AND (SELECT ordinal FROM jsonb_array_elements_text(rank_a->'orderedEntryIds') WITH ORDINALITY t(id,ordinal) WHERE id=contrast->'entryIds'->>0)
      <(SELECT ordinal FROM jsonb_array_elements_text(rank_a->'orderedEntryIds') WITH ORDINALITY t(id,ordinal) WHERE id=contrast->'entryIds'->>1)
    AND (SELECT ordinal FROM jsonb_array_elements_text(rank_b->'orderedEntryIds') WITH ORDINALITY t(id,ordinal) WHERE id=contrast->'entryIds'->>0)
      >(SELECT ordinal FROM jsonb_array_elements_text(rank_b->'orderedEntryIds') WITH ORDINALITY t(id,ordinal) WHERE id=contrast->'entryIds'->>1)) IS NOT TRUE THEN
    RAISE EXCEPTION 'Candidate contrast is not supported by pinned full rankings and constraints' USING ERRCODE='23514';
  END IF;
  FOR row IN SELECT value FROM jsonb_array_elements(source->'targets') LOOP
    IF row->'attempt'->'input'->'task'->>'checksum' IS DISTINCT FROM public.tastecase_json_checksum((row->'attempt'->'input'->'task')-ARRAY['projectId','checksum','createdAt'])
      OR row->'attempt'->>'inputChecksum' IS DISTINCT FROM public.tastecase_json_checksum(row->'attempt'->'input')
      OR (row->'attempt'->'result'<>'null'::jsonb AND row->'attempt'->>'resultChecksum' IS DISTINCT FROM public.tastecase_json_checksum(row->'attempt'->'result'))
      OR row->'attempt'->>'id' IS DISTINCT FROM public.tastecase_review_id((source->>'jobId')::uuid,'target:'||(row->'association'->>'profileId')||':'||(row->'association'->>'round')||':'||(row->'association'->>'repeat')||':'||(row->'association'->>'variant'))::text
      OR row->'attempt'->'input'->'task'->>'id' IS DISTINCT FROM public.tastecase_review_id((source->>'jobId')::uuid,'task:'||(row->'association'->>'profileId')||':'||(row->'association'->>'variant'))::text
      OR row->'attempt'->'input'->'catalog' IS DISTINCT FROM input->'catalog'
      OR row->'attempt'->'input'->'mappings' IS DISTINCT FROM input->'mappings'
      OR row->'attempt'->'input'->'eligibleCatalogEntryIds' IS DISTINCT FROM input->'eligibleCatalogEntryIds'
      OR row->'attempt'->'input'->'task'->'constraints' IS DISTINCT FROM input->'task'->'constraints'
      OR (row->'association'->>'variant'='full' AND row->'attempt'->'input'->'task'->'syntheticBrief' IS DISTINCT FROM source->'candidate'->'content'->'briefs'->(row->'association'->>'profileId'))
      OR (row->'association'->>'repeat')::int >= (source->'job'->'input'->'request'->>'repeatCount')::int THEN
      RAISE EXCEPTION 'Target source does not preserve pinned job context or checksum' USING ERRCODE='23514';
    END IF;
  END LOOP;
  SELECT jsonb_build_object(
    'missingEntryIds',(SELECT coalesce(jsonb_agg(id ORDER BY public.tastecase_utf16_key(id)),'[]') FROM (SELECT DISTINCT id FROM jsonb_array_elements(source->'evidence') e,jsonb_array_elements_text(e->'data'->'missingEntryIds') id WHERE e->'data'->>'kind' IN ('rank','facts')) ids),
    'unmappedEntryIds',(SELECT coalesce(jsonb_agg(id ORDER BY public.tastecase_utf16_key(id)),'[]') FROM (SELECT DISTINCT id FROM jsonb_array_elements(source->'evidence') e,jsonb_array_elements_text(e->'data'->'unmappedEntryIds') id WHERE e->'data'->>'kind' IN ('rank','facts')) ids),
    'intendedFullAttempts',2*(source->'job'->'input'->'request'->>'repeatCount')::int,
    'capturedFullAttempts',count(*) FILTER(WHERE t->'association'->>'variant'='full'),
    'completedFullAttempts',count(*) FILTER(WHERE t->'association'->>'variant'='full' AND t->'attempt'->>'status'='completed'),
    'unfinishedAttemptIds',coalesce(jsonb_agg(t->'attempt'->'id' ORDER BY ordinal) FILTER(WHERE t->'attempt'->>'status'<>'completed'),'[]'),
    'unavailableResultAttemptIds',coalesce(jsonb_agg(t->'attempt'->'id' ORDER BY ordinal) FILTER(WHERE t->'attempt'->'result'->>'outcome'='provider_unavailable'),'[]'),
    'partialTraceAttemptIds',coalesce(jsonb_agg(t->'attempt'->'id' ORDER BY ordinal) FILTER(WHERE t->'attempt'->'result'->'trace'->>'completeness'='partial'),'[]'),
    'unavailableTraceAttemptIds',coalesce(jsonb_agg(t->'attempt'->'id' ORDER BY ordinal) FILTER(WHERE t->'attempt'->'result'->'trace'->>'completeness'='unavailable'),'[]'),
    'uncertainAttemptIds',coalesce(jsonb_agg(t->'attempt'->'id' ORDER BY ordinal) FILTER(WHERE (t->'association'->>'uncertainDispatches')::int>0),'[]'))
  INTO coverage FROM jsonb_array_elements(source->'targets') WITH ORDINALITY rows(t,ordinal);
  limits := source->'candidate'->'content'->'limitations' || jsonb_build_array(
    'Qloo evidence is query-relative and advisory, not individual preference correctness.',
    'Absent tool events cannot prove misconduct; trace completeness is pinned for each captured result.',
    'Catalog facts are pinned as supplied; no fact freshness or evaluator is asserted.',
    'Full target coverage: '||(coverage->>'completedFullAttempts')||' completed, '||(coverage->>'capturedFullAttempts')||' captured, '||(coverage->>'intendedFullAttempts')||' intended.');
  IF jsonb_array_length(coverage->'missingEntryIds')+jsonb_array_length(coverage->'unmappedEntryIds')>0 THEN limits := limits || jsonb_build_array('Missing or unmapped ranking coverage is unavailable, not negative preference.'); END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(source->'evidence') e WHERE e->'data'->>'kind'='rank' AND e->'data'->>'providerStatus'<>'ok') THEN limits := limits || jsonb_build_array('Reduced or non-ok provider evidence retains its scope, status and coverage.'); END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(source->'targets') t WHERE t->'attempt'->'result'->>'outcome' IS DISTINCT FROM 'success') THEN limits := limits || jsonb_build_array('Unfinished, malformed or unavailable target results are execution gaps, not taste passes or failures.'); END IF;
  IF jsonb_array_length(coverage->'partialTraceAttemptIds')+jsonb_array_length(coverage->'unavailableTraceAttemptIds')>0 THEN limits := limits || jsonb_build_array('Incomplete traces cannot prove missing tool calls.'); END IF;
  IF jsonb_array_length(coverage->'uncertainAttemptIds')>0 THEN limits := limits || jsonb_build_array('Interrupted dispatches may have repeated provider calls; exactly-once execution is not established.'); END IF;
  SELECT jsonb_agg(val ORDER BY first_ordinal) INTO limits FROM (SELECT val,min(ordinal) first_ordinal FROM jsonb_array_elements(limits) WITH ORDINALITY t(val,ordinal) GROUP BY val) unique_limits;
  result := source || jsonb_build_object('coverage',coverage,'limitations',limits);
  result := result || jsonb_build_object('checksum',public.tastecase_json_checksum(result));
  IF octet_length(public.canonical_json(result))>2097152 THEN RAISE EXCEPTION 'Pinned review evidence exceeds byte limit' USING ERRCODE='23514'; END IF;
  RETURN result;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_validate_expectation(value jsonb,evidence jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE class text := value->>'classification'; rule jsonb; ids jsonb; input jsonb := evidence->'job'->'input'->'targetInput';
BEGIN
  IF class='advisory' THEN
    PERFORM public.tastecase_review_object(value,ARRAY['classification','automaticFailure','humanReviewRequired','contrastId','rationale']);
    IF (value->'automaticFailure'='false'::jsonb AND value->'humanReviewRequired'='true'::jsonb
      AND value->>'contrastId'=evidence->'candidate'->'content'->'contrast'->>'id'
      AND jsonb_typeof(value->'rationale')='string' AND length(btrim(value->>'rationale')) BETWEEN 1 AND 2000) IS NOT TRUE THEN
      RAISE EXCEPTION 'Advisory approval must remain non-automatic and pin the contrast' USING ERRCODE='23514'; END IF;
    RETURN;
  ELSIF class='objective_contract' THEN
    PERFORM public.tastecase_review_object(value,ARRAY['classification','automaticFailure','profiles','rules']);
    IF jsonb_typeof(value->'profiles') IS DISTINCT FROM 'array' OR jsonb_array_length(value->'profiles') NOT BETWEEN 1 AND 2
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(value->'profiles') p WHERE p NOT IN ('"a"'::jsonb,'"b"'::jsonb))
      OR (SELECT count(*) FROM jsonb_array_elements(value->'profiles'))<>(SELECT count(DISTINCT p) FROM jsonb_array_elements(value->'profiles') p) THEN
      RAISE EXCEPTION 'Objective profiles must be scoped and unique' USING ERRCODE='23514'; END IF;
  ELSIF class='approved_policy' THEN
    PERFORM public.tastecase_review_object(value,ARRAY['classification','automaticFailure','rules']);
  ELSE RAISE EXCEPTION 'Unavailable or unsupported class cannot be approved' USING ERRCODE='23514'; END IF;
  IF value->'automaticFailure' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(value->'rules') IS DISTINCT FROM 'array'
    OR jsonb_array_length(value->'rules') NOT BETWEEN 1 AND (CASE WHEN class='objective_contract' THEN 3 ELSE 20 END)
    OR (SELECT count(*) FROM jsonb_array_elements(value->'rules'))<>(SELECT count(DISTINCT r) FROM jsonb_array_elements(value->'rules') r)
    OR (class='objective_contract' AND (SELECT count(*) FROM jsonb_array_elements(value->'rules'))<>(SELECT count(DISTINCT r->>'kind') FROM jsonb_array_elements(value->'rules') r)) THEN
    RAISE EXCEPTION 'Invalid approved rule list' USING ERRCODE='23514'; END IF;
  FOR rule IN SELECT r FROM jsonb_array_elements(value->'rules') r LOOP
    IF class='objective_contract' THEN
      IF rule->>'kind'='output_schema' THEN PERFORM public.tastecase_review_object(rule,ARRAY['kind']); CONTINUE;
      ELSIF rule->>'kind' IN ('allowed_ids','exclusions') THEN PERFORM public.tastecase_review_object(rule,ARRAY['kind','entryIds']);
      ELSE RAISE EXCEPTION 'Unsupported mechanical check' USING ERRCODE='23514'; END IF;
    ELSE
      IF (rule->>'profileId' IN ('a','b')) IS NOT TRUE THEN RAISE EXCEPTION 'Policy profile outside job' USING ERRCODE='23514'; END IF;
      IF rule->>'kind'='order' THEN
        PERFORM public.tastecase_review_object(rule,ARRAY['kind','profileId','beforeEntryId','afterEntryId','whenBothPresent']);
        IF rule->'whenBothPresent' IS DISTINCT FROM 'true'::jsonb OR rule->'beforeEntryId'=rule->'afterEntryId' THEN RAISE EXCEPTION 'Order is conditional and requires distinct IDs' USING ERRCODE='23514'; END IF;
      ELSIF rule->>'kind' IN ('recommend_any','avoid') THEN PERFORM public.tastecase_review_object(rule,ARRAY['kind','profileId','entryIds']);
      ELSE RAISE EXCEPTION 'Unsupported policy check' USING ERRCODE='23514'; END IF;
    END IF;
    ids := CASE WHEN rule->>'kind'='order' THEN jsonb_build_array(rule->'beforeEntryId',rule->'afterEntryId') ELSE rule->'entryIds' END;
    IF jsonb_typeof(ids) IS DISTINCT FROM 'array' OR jsonb_array_length(ids) NOT BETWEEN 1 AND 500
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(ids) id WHERE jsonb_typeof(id)<>'string' OR length(btrim(id#>>'{}')) NOT BETWEEN 1 AND 160)
      OR (SELECT count(*) FROM jsonb_array_elements(ids))<>(SELECT count(DISTINCT id) FROM jsonb_array_elements(ids) id) THEN RAISE EXCEPTION 'Invalid scoped IDs' USING ERRCODE='23514'; END IF;
    IF class='objective_contract' THEN
      IF (rule->>'kind'='allowed_ids' AND (NOT (ids @> (input->'eligibleCatalogEntryIds')) OR NOT ((input->'eligibleCatalogEntryIds') @> ids)))
        OR (rule->>'kind'='exclusions' AND NOT ((input->'task'->'constraints'->'excludedEntryIds') @> ids)) THEN
        RAISE EXCEPTION 'Mechanical checks must match explicit eligibility or exclusions' USING ERRCODE='23514'; END IF;
    ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements_text(ids) id WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(input->'catalog'->'entries') e WHERE e->>'id'=id)
      OR (rule->>'kind'<>'avoid' AND NOT (input->'eligibleCatalogEntryIds' ? id))) THEN RAISE EXCEPTION 'Policy ID outside pinned catalog or eligibility' USING ERRCODE='23514'; END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_review_case(p_project uuid,p_owner uuid,p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public SET statement_timeout='10s' SET lock_timeout='3s' AS $$
DECLARE c public.discovery_candidates; row public.review_cases; h public.review_heads; timing timestamptz := date_trunc('milliseconds',clock_timestamp()); payload jsonb;
BEGIN
  PERFORM public.tastecase_review_owner(p_project,p_owner);
  PERFORM public.tastecase_review_object(p_request,ARRAY['schema_version','id','jobId','candidateId']);
  IF p_request->>'schema_version' IS DISTINCT FROM '1.0.0' THEN RAISE EXCEPTION 'Unsupported schema' USING ERRCODE='23514'; END IF;
  SELECT * INTO c FROM public.discovery_candidates WHERE project_id=p_project AND job_id=(p_request->>'jobId')::uuid AND id=(p_request->>'candidateId')::uuid;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Candidate outside project/job' USING ERRCODE='23503'; END IF;
  IF c.checksum<>public.tastecase_json_checksum(c.content) THEN RAISE EXCEPTION 'Candidate checksum mismatch' USING ERRCODE='23514'; END IF;
  payload := p_request || jsonb_build_object('projectId',p_project,'candidateChecksum',c.checksum,'createdAt',public.tastecase_review_time(timing));
  INSERT INTO public.review_cases(id,project_id,job_id,candidate_id,candidate_checksum,created_at,case_json)
    VALUES((p_request->>'id')::uuid,p_project,c.job_id,c.id,c.checksum,timing,payload) ON CONFLICT DO NOTHING;
  SELECT * INTO row FROM public.review_cases WHERE project_id=p_project AND id=(p_request->>'id')::uuid;
  IF row.id IS NULL OR row.job_id<>c.job_id OR row.candidate_id<>c.id OR row.candidate_checksum<>c.checksum THEN RAISE EXCEPTION 'Review case ID/candidate conflict' USING ERRCODE='23505'; END IF;
  INSERT INTO public.review_heads(project_id,case_id,job_id,candidate_id,candidate_checksum) VALUES(p_project,row.id,row.job_id,row.candidate_id,row.candidate_checksum) ON CONFLICT DO NOTHING;
  SELECT * INTO h FROM public.review_heads WHERE project_id=p_project AND case_id=row.id;
  RETURN jsonb_build_object('schema_version','1.0.0','case',row.case_json,'head',public.tastecase_review_head(h),
    'candidate',jsonb_build_object('schema_version',c.schema_version,'id',c.id,'projectId',c.project_id,'jobId',c.job_id,'content',c.content,'checksum',c.checksum,'createdAt',public.tastecase_review_time(c.created_at)),
    'currentReview',public.tastecase_review_record(h.last_decision_id));
END;
$$;
CREATE OR REPLACE FUNCTION public.record_review_decision(p_project uuid,p_owner uuid,p_case uuid,p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public SET statement_timeout='10s' SET lock_timeout='3s' AS $$
DECLARE row public.review_cases; h public.review_heads; old public.review_decisions; evidence jsonb; expectation jsonb; version_id uuid; receipt jsonb; version_json jsonb;
  timing timestamptz := date_trunc('milliseconds',clock_timestamp()); request_hash text; expected bigint; action text := p_request->>'action'; decision_id uuid;
BEGIN
  PERFORM public.tastecase_review_owner(p_project,p_owner);
  PERFORM public.tastecase_review_object(p_request,CASE WHEN action='edit' THEN ARRAY['schema_version','id','expectedRevision','rationale','action','expectation'] ELSE ARRAY['schema_version','id','expectedRevision','rationale','action'] END);
  IF (p_request->>'schema_version'='1.0.0' AND action IN ('accept','edit','reject','defer') AND jsonb_typeof(p_request->'rationale')='string'
    AND length(btrim(p_request->>'rationale')) BETWEEN 1 AND 2000 AND p_request->>'rationale'=btrim(p_request->>'rationale')
    AND jsonb_typeof(p_request->'expectedRevision')='number' AND (p_request->>'expectedRevision') ~ '^(0|[1-9][0-9]*)$'
    AND octet_length(public.canonical_json(p_request))<=65536) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid review request' USING ERRCODE='23514'; END IF;
  expected := (p_request->>'expectedRevision')::bigint; decision_id := (p_request->>'id')::uuid;
  IF expected NOT BETWEEN 0 AND 9007199254740990 THEN RAISE EXCEPTION 'Invalid review revision' USING ERRCODE='23514'; END IF;
  request_hash := public.tastecase_json_checksum(p_request);
  SELECT * INTO row FROM public.review_cases WHERE project_id=p_project AND id=p_case;
  IF row.id IS NULL THEN RAISE EXCEPTION 'Review case outside project' USING ERRCODE='23503'; END IF;
  -- Review locks only one head. Publish locks suite then ALL heads by case UUID;
  -- it never locks target rows or discovery state, so runner uploads cannot deadlock.
  SELECT * INTO h FROM public.review_heads WHERE project_id=p_project AND case_id=p_case FOR UPDATE;
  SELECT * INTO old FROM public.review_decisions WHERE id=decision_id;
  IF old.id IS NOT NULL THEN
    IF old.project_id<>p_project OR old.case_id<>p_case OR old.request_checksum<>request_hash THEN RAISE EXCEPTION 'Review retry content conflict' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('schema_version','1.0.0','head',public.tastecase_review_head(h),'review',public.tastecase_review_record(old.id),'idempotent',true);
  END IF;
  IF h.revision<>expected THEN RAISE EXCEPTION 'Stale review revision' USING ERRCODE='40001'; END IF;
  evidence := public.tastecase_pin_review(public.tastecase_review_source(p_project,row.job_id,row.candidate_id,timing));
  IF evidence->'candidate'->>'checksum' IS DISTINCT FROM row.candidate_checksum THEN RAISE EXCEPTION 'Candidate changed' USING ERRCODE='23514'; END IF;
  expectation := CASE WHEN action='accept' THEN evidence->'candidate'->'content'->'proposedExpectation' WHEN action='edit' THEN p_request->'expectation' ELSE NULL END;
  IF expectation IS NOT NULL THEN
    PERFORM public.tastecase_validate_expectation(expectation,evidence);
    version_id := public.tastecase_review_id(decision_id,'approved-expectation');
  END IF;
  receipt := jsonb_build_object('schema_version','1.0.0','id',decision_id,'projectId',p_project,'caseId',p_case,'jobId',row.job_id,'candidateId',row.candidate_id,
    'candidateChecksum',row.candidate_checksum,'action',action,'rationale',p_request->>'rationale','expectedRevision',expected,'revision',expected+1,'requestChecksum',request_hash,
    'reviewedBy',p_owner,'createdAt',public.tastecase_review_time(timing),'evidence',evidence,'approvedExpectationVersionId',version_id);
  receipt := receipt || jsonb_build_object('checksum',public.tastecase_json_checksum(receipt));
  INSERT INTO public.review_decisions(id,project_id,case_id,job_id,candidate_id,candidate_checksum,expected_revision,revision,action,reviewed_by,request_checksum,receipt,checksum,created_at)
    VALUES(decision_id,p_project,p_case,row.job_id,row.candidate_id,row.candidate_checksum,expected,expected+1,action,p_owner,request_hash,receipt,receipt->>'checksum',timing);
  IF version_id IS NOT NULL THEN
    version_json := jsonb_build_object('schema_version','1.0.0','id',version_id,'projectId',p_project,'caseId',p_case,'jobId',row.job_id,'candidateId',row.candidate_id,
      'candidateChecksum',row.candidate_checksum,'reviewDecisionId',decision_id,'reviewRevision',expected+1,'expectation',expectation,'evidenceChecksum',evidence->>'checksum','createdAt',public.tastecase_review_time(timing));
    version_json := version_json || jsonb_build_object('checksum',public.tastecase_json_checksum(version_json));
    INSERT INTO public.expectation_versions(id,project_id,case_id,job_id,candidate_id,candidate_checksum,review_decision_id,review_revision,expectation,evidence_checksum,version_json,checksum,created_at)
      VALUES(version_id,p_project,p_case,row.job_id,row.candidate_id,row.candidate_checksum,decision_id,expected+1,expectation,evidence->>'checksum',version_json,version_json->>'checksum',timing);
  END IF;
  UPDATE public.review_heads SET revision=expected+1,status=CASE action WHEN 'accept' THEN 'accepted' WHEN 'edit' THEN 'edited' WHEN 'reject' THEN 'rejected' ELSE 'deferred' END,
    last_decision_id=decision_id,approved_expectation_version_id=version_id WHERE case_id=p_case RETURNING * INTO h;
  RETURN jsonb_build_object('schema_version','1.0.0','head',public.tastecase_review_head(h),'review',public.tastecase_review_record(decision_id),'idempotent',false);
END;
$$;
CREATE OR REPLACE FUNCTION public.create_suite(p_project uuid,p_owner uuid,p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public SET statement_timeout='10s' SET lock_timeout='3s' AS $$
DECLARE row public.suites;
BEGIN
  PERFORM public.tastecase_review_owner(p_project,p_owner);
  PERFORM public.tastecase_review_object(p_request,ARRAY['schema_version','id','name']);
  IF (p_request->>'schema_version'='1.0.0' AND jsonb_typeof(p_request->'name')='string' AND length(btrim(p_request->>'name')) BETWEEN 1 AND 160
    AND p_request->>'name'=btrim(p_request->>'name')) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid suite identity' USING ERRCODE='23514'; END IF;
  INSERT INTO public.suites(id,project_id,name,created_at) VALUES((p_request->>'id')::uuid,p_project,p_request->>'name',date_trunc('milliseconds',clock_timestamp())) ON CONFLICT DO NOTHING;
  SELECT * INTO row FROM public.suites WHERE project_id=p_project AND id=(p_request->>'id')::uuid;
  IF row.id IS NULL OR row.name<>p_request->>'name' THEN RAISE EXCEPTION 'Suite identity conflict' USING ERRCODE='23505'; END IF;
  RETURN public.tastecase_suite_identity(row);
END;
$$;
CREATE OR REPLACE FUNCTION public.publish_suite(p_project uuid,p_owner uuid,p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public SET statement_timeout='10s' SET lock_timeout='3s' AS $$
DECLARE row public.suites; old public.suite_versions; selection jsonb; cases jsonb := '[]'; h public.review_heads; c public.review_cases; d public.review_decisions; v public.expectation_versions;
  snapshot jsonb; request_hash text; publication_id uuid; expected bigint; ordinal int := 0; timing timestamptz := date_trunc('milliseconds',clock_timestamp());
BEGIN
  PERFORM public.tastecase_review_owner(p_project,p_owner);
  PERFORM public.tastecase_review_object(p_request,ARRAY['schema_version','id','suiteId','expectedVersion','cases']);
  IF (p_request->>'schema_version'='1.0.0' AND jsonb_typeof(p_request->'expectedVersion')='number' AND (p_request->>'expectedVersion') ~ '^(0|[1-9][0-9]*)$'
    AND jsonb_typeof(p_request->'cases')='array' AND jsonb_array_length(p_request->'cases') BETWEEN 1 AND 50
    AND octet_length(public.canonical_json(p_request))<=65536) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid publication request' USING ERRCODE='23514'; END IF;
  expected := (p_request->>'expectedVersion')::bigint; publication_id := (p_request->>'id')::uuid;
  IF expected NOT BETWEEN 0 AND 9007199254740990 THEN RAISE EXCEPTION 'Invalid suite version' USING ERRCODE='23514'; END IF;
  FOR selection IN SELECT value FROM jsonb_array_elements(p_request->'cases') LOOP
    PERFORM public.tastecase_review_object(selection,ARRAY['caseId','expectationVersionId','expectedReviewRevision']);
    PERFORM (selection->>'caseId')::uuid,(selection->>'expectationVersionId')::uuid;
    IF (jsonb_typeof(selection->'expectedReviewRevision')='number' AND (selection->>'expectedReviewRevision') ~ '^[1-9][0-9]*$'
      AND (selection->>'expectedReviewRevision')::numeric<=9007199254740991) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid selected review revision' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT s->>'caseId') FROM jsonb_array_elements(p_request->'cases') s)<>jsonb_array_length(p_request->'cases')
    OR (SELECT count(DISTINCT s->>'expectationVersionId') FROM jsonb_array_elements(p_request->'cases') s)<>jsonb_array_length(p_request->'cases') THEN RAISE EXCEPTION 'Duplicate suite selection' USING ERRCODE='23514'; END IF;
  request_hash := public.tastecase_json_checksum(p_request);
  SELECT * INTO row FROM public.suites WHERE project_id=p_project AND id=(p_request->>'suiteId')::uuid FOR UPDATE;
  IF row.id IS NULL THEN RAISE EXCEPTION 'Suite outside project' USING ERRCODE='23503'; END IF;
  SELECT * INTO old FROM public.suite_versions WHERE id=publication_id;
  IF old.id IS NOT NULL THEN
    IF old.project_id<>p_project OR old.suite_id<>row.id OR old.request_checksum<>request_hash THEN RAISE EXCEPTION 'Publication retry content conflict' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('schema_version','1.0.0','suite',old.snapshot,'idempotent',true);
  END IF;
  IF row.current_version<>expected THEN RAISE EXCEPTION 'Stale suite version' USING ERRCODE='40001'; END IF;
  PERFORM head.case_id FROM public.review_heads head WHERE head.project_id=p_project AND head.case_id IN
    (SELECT (s->>'caseId')::uuid FROM jsonb_array_elements(p_request->'cases') s) ORDER BY head.case_id FOR UPDATE;
  -- Validate the WHOLE list and assemble only persisted immutable receipts before
  -- inserting anything. Original list order is part of the publication checksum.
  FOR selection IN SELECT value FROM jsonb_array_elements(p_request->'cases') LOOP
    SELECT * INTO h FROM public.review_heads WHERE project_id=p_project AND case_id=(selection->>'caseId')::uuid;
    IF h.case_id IS NULL THEN RAISE EXCEPTION 'Selected case outside project' USING ERRCODE='23503'; END IF;
    IF h.revision<>(selection->>'expectedReviewRevision')::bigint OR h.status NOT IN ('accepted','edited')
      OR h.approved_expectation_version_id IS DISTINCT FROM (selection->>'expectationVersionId')::uuid THEN RAISE EXCEPTION 'Stale or unapproved selected expectation' USING ERRCODE='40001'; END IF;
    SELECT * INTO c FROM public.review_cases WHERE project_id=p_project AND id=h.case_id;
    SELECT * INTO d FROM public.review_decisions WHERE project_id=p_project AND case_id=h.case_id AND id=h.last_decision_id AND revision=h.revision;
    SELECT * INTO v FROM public.expectation_versions WHERE project_id=p_project AND case_id=h.case_id AND id=h.approved_expectation_version_id AND review_revision=h.revision AND review_decision_id=d.id;
    IF v.id IS NULL OR d.action NOT IN ('accept','edit') THEN RAISE EXCEPTION 'Approval references invalid' USING ERRCODE='23503'; END IF;
    cases := cases || jsonb_build_array(jsonb_build_object('case',c.case_json,'review',jsonb_build_object('decision',d.receipt,'expectationVersion',v.version_json)));
  END LOOP;
  snapshot := jsonb_build_object('schema_version','1.0.0','id',publication_id,'suiteId',row.id,'projectId',p_project,'expectedVersion',expected,'version',expected+1,
    'requestChecksum',request_hash,'publishedBy',p_owner,'createdAt',public.tastecase_review_time(timing),'cases',cases);
  snapshot := snapshot || jsonb_build_object('checksum',public.tastecase_json_checksum(snapshot));
  INSERT INTO public.suite_versions(id,project_id,suite_id,expected_version,version,request_checksum,published_by,snapshot,checksum,created_at)
    VALUES(publication_id,p_project,row.id,expected,expected+1,request_hash,p_owner,snapshot,snapshot->>'checksum',timing);
  FOR selection IN SELECT value FROM jsonb_array_elements(cases) LOOP
    INSERT INTO public.suite_version_cases(project_id,suite_id,suite_version_id,ordinal,case_id,review_decision_id,review_revision,expectation_version_id)
      VALUES(p_project,row.id,publication_id,ordinal,(selection->'case'->>'id')::uuid,(selection->'review'->'decision'->>'id')::uuid,
        (selection->'review'->'decision'->>'revision')::bigint,(selection->'review'->'expectationVersion'->>'id')::uuid);
    ordinal := ordinal+1;
  END LOOP;
  UPDATE public.suites SET current_version=expected+1 WHERE id=row.id RETURNING * INTO row;
  RETURN jsonb_build_object('schema_version','1.0.0','suite',snapshot,'idempotent',false);
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_guard_review_head() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Review heads cannot be deleted' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-ARRAY['revision','status','last_decision_id','approved_expectation_version_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','status','last_decision_id','approved_expectation_version_id'])
    OR NEW.revision<>OLD.revision+1 OR NOT EXISTS(SELECT 1 FROM public.review_decisions d WHERE d.project_id=NEW.project_id AND d.case_id=NEW.case_id AND d.id=NEW.last_decision_id AND d.revision=NEW.revision
      AND NEW.status=CASE d.action WHEN 'accept' THEN 'accepted' WHEN 'edit' THEN 'edited' WHEN 'reject' THEN 'rejected' ELSE 'deferred' END) THEN RAISE EXCEPTION 'Invalid review head advance' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_guard_suite() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Suite identities cannot be deleted' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-'current_version') IS DISTINCT FROM (to_jsonb(OLD)-'current_version') OR NEW.current_version<>OLD.current_version+1
    OR NOT EXISTS(SELECT 1 FROM public.suite_versions v WHERE v.project_id=NEW.project_id AND v.suite_id=NEW.id AND v.version=NEW.current_version) THEN RAISE EXCEPTION 'Invalid suite advance' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
DO $$
DECLARE table_name text; f record;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['review_cases','review_heads','review_decisions','expectation_versions','suites','suite_versions','suite_version_cases'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',table_name);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated,service_role',table_name);
    EXECUTE format('DROP POLICY IF EXISTS tastecase_owner_read ON public.%I',table_name);
    EXECUTE format('CREATE POLICY tastecase_owner_read ON public.%I FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.projects WHERE id=project_id AND owner_id=(SELECT auth.uid())))',table_name);
    IF table_name NOT IN ('review_heads','suites') THEN
      EXECUTE format('DROP TRIGGER IF EXISTS tastecase_immutable ON public.%I',table_name);
      EXECUTE format('CREATE TRIGGER tastecase_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.tastecase_immutable()',table_name);
    END IF;
  END LOOP;
  FOR f IN SELECT oid::regprocedure AS signature,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND
    (proname IN ('canonical_json','create_review_case','record_review_decision','create_suite','publish_suite') OR proname LIKE 'tastecase\_review\_%' ESCAPE '\' OR proname IN ('tastecase_utf16_key','tastecase_json_checksum','tastecase_suite_identity','tastecase_pin_review','tastecase_validate_expectation','tastecase_guard_review_head','tastecase_guard_suite')) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
    IF f.proname IN ('create_review_case','record_review_decision','create_suite','publish_suite') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature); END IF;
  END LOOP;
END;
$$;
DROP TRIGGER IF EXISTS tastecase_guard_review_head ON public.review_heads;
CREATE TRIGGER tastecase_guard_review_head BEFORE UPDATE OR DELETE ON public.review_heads FOR EACH ROW EXECUTE FUNCTION public.tastecase_guard_review_head();
DROP TRIGGER IF EXISTS tastecase_guard_suite ON public.suites;
CREATE TRIGGER tastecase_guard_suite BEFORE UPDATE OR DELETE ON public.suites FOR EACH ROW EXECUTE FUNCTION public.tastecase_guard_suite();
