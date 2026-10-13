-- Gate 4: fresh comparison work from immutable publication receipts only.
-- Lock order: runner credential, target attempts (UUID order for finalization),
-- comparison_state. Cancellation locks state only. Creation serialises by project
-- advisory lock before inserting shared deterministic tasks. Never lock state then
-- target attempts. API claims must reserve before returning a lease, in ONE transaction.
CREATE UNIQUE INDEX IF NOT EXISTS comparison_suite_version_ref ON public.suite_versions(project_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS comparison_selected_case_ref ON public.suite_version_cases(project_id,suite_version_id,case_id,expectation_version_id);
CREATE TABLE IF NOT EXISTS public.comparison_runs (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, suite_version_id uuid NOT NULL,
  request_checksum text NOT NULL, plan jsonb NOT NULL, checksum text NOT NULL,
  created_at timestamptz NOT NULL, deadline_at timestamptz NOT NULL,
  dispatch_budget int NOT NULL CHECK(dispatch_budget BETWEEN 4 AND 144), reclaim_budget int NOT NULL CHECK(reclaim_budget BETWEEN 0 AND 24),
  create_receipt jsonb NOT NULL, UNIQUE(project_id,id), UNIQUE(project_id,id,suite_version_id),
  FOREIGN KEY(project_id,suite_version_id) REFERENCES public.suite_versions(project_id,id),
  CHECK(checksum=public.tastecase_json_checksum(plan-'checksum') AND checksum=plan->>'checksum'),
  CHECK(request_checksum=public.tastecase_json_checksum(plan->'request')),
  CHECK(plan->>'id'=id::text AND plan->>'projectId'=project_id::text AND plan->'request'->>'suiteVersionId'=suite_version_id::text),
  CHECK(octet_length(public.canonical_json(plan))<=8388608 AND jsonb_array_length(plan->'slots') BETWEEN 4 AND 120),
  CHECK(deadline_at>created_at AND deadline_at<=created_at+interval '1 hour')
);
CREATE TABLE IF NOT EXISTS public.comparison_state (
  comparison_id uuid PRIMARY KEY, project_id uuid NOT NULL, state text NOT NULL DEFAULT 'queued'
    CHECK(state IN ('queued','running','cancelled','deadline_exceeded','budget_exhausted','finalized')),
  dispatches int NOT NULL DEFAULT 0 CHECK(dispatches BETWEEN 0 AND 144),
  reclaims int NOT NULL DEFAULT 0 CHECK(reclaims BETWEEN 0 AND 24), cancelled_at timestamptz,
  UNIQUE(project_id,comparison_id), FOREIGN KEY(project_id,comparison_id) REFERENCES public.comparison_runs(project_id,id)
);
CREATE TABLE IF NOT EXISTS public.comparison_cases (
  project_id uuid NOT NULL, comparison_id uuid NOT NULL, suite_version_id uuid NOT NULL, case_id uuid NOT NULL,
  expectation_version_id uuid NOT NULL, ordinal int NOT NULL CHECK(ordinal BETWEEN 0 AND 9), projection jsonb NOT NULL,
  PRIMARY KEY(comparison_id,case_id), UNIQUE(project_id,comparison_id,case_id), UNIQUE(comparison_id,ordinal),
  FOREIGN KEY(project_id,comparison_id,suite_version_id) REFERENCES public.comparison_runs(project_id,id,suite_version_id),
  FOREIGN KEY(project_id,suite_version_id,case_id,expectation_version_id)
    REFERENCES public.suite_version_cases(project_id,suite_version_id,case_id,expectation_version_id)
);
CREATE TABLE IF NOT EXISTS public.comparison_targets (
  attempt_id uuid PRIMARY KEY, project_id uuid NOT NULL, comparison_id uuid NOT NULL, case_id uuid NOT NULL,
  role text NOT NULL CHECK(role IN ('baseline','candidate')), assistant_version text NOT NULL CHECK(length(btrim(assistant_version)) BETWEEN 1 AND 160),
  profile_id text NOT NULL CHECK(profile_id IN ('a','b')), repeat int NOT NULL CHECK(repeat BETWEEN 0 AND 2),
  catalog_version_id uuid NOT NULL, ordinal int NOT NULL CHECK(ordinal BETWEEN 0 AND 119),
  UNIQUE(project_id,comparison_id,attempt_id), UNIQUE(comparison_id,case_id,role,profile_id,repeat), UNIQUE(comparison_id,ordinal),
  FOREIGN KEY(project_id,comparison_id,case_id) REFERENCES public.comparison_cases(project_id,comparison_id,case_id),
  FOREIGN KEY(project_id,attempt_id,catalog_version_id) REFERENCES public.target_attempts(project_id,id,catalog_version_id)
);
CREATE TABLE IF NOT EXISTS public.comparison_dispatches (
  lease_id uuid PRIMARY KEY, project_id uuid NOT NULL, comparison_id uuid NOT NULL, attempt_id uuid NOT NULL,
  credential_id uuid NOT NULL, ordinal int NOT NULL CHECK(ordinal BETWEEN 0 AND 24),
  dispatched_at timestamptz NOT NULL, lease_expires_at timestamptz NOT NULL,
  UNIQUE(attempt_id,ordinal), FOREIGN KEY(project_id,comparison_id,attempt_id) REFERENCES public.comparison_targets(project_id,comparison_id,attempt_id),
  FOREIGN KEY(project_id,credential_id) REFERENCES public.runner_credentials(project_id,id)
);
CREATE TABLE IF NOT EXISTS public.comparison_cancellations (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, comparison_id uuid NOT NULL, request_checksum text NOT NULL,
  receipt jsonb NOT NULL, created_at timestamptz NOT NULL,
  FOREIGN KEY(project_id,comparison_id) REFERENCES public.comparison_runs(project_id,id)
);
CREATE TABLE IF NOT EXISTS public.comparison_reports (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, comparison_id uuid NOT NULL UNIQUE, request_checksum text NOT NULL,
  report jsonb NOT NULL, checksum text NOT NULL, created_at timestamptz NOT NULL,
  UNIQUE(project_id,comparison_id,id), FOREIGN KEY(project_id,comparison_id) REFERENCES public.comparison_runs(project_id,id),
  CHECK(checksum=public.tastecase_json_checksum(report-'checksum') AND checksum=report->>'checksum'),
  CHECK(octet_length(public.canonical_json(report))<=2097152)
);
-- No graph blobs, provider text, reasons, events, token hashes or executable code.
-- These receipts are server-derived, not caller-provided artifact snapshots.
CREATE TABLE IF NOT EXISTS public.comparison_artifacts (
  project_id uuid NOT NULL, comparison_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('pack','report')),
  content jsonb NOT NULL, checksum text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(comparison_id,kind), FOREIGN KEY(project_id,comparison_id) REFERENCES public.comparison_runs(project_id,id),
  CHECK(checksum=public.tastecase_json_checksum(content-'checksum') AND checksum=content->>'checksum'),
  CHECK(octet_length(public.canonical_json(content))<=8388608)
);
CREATE INDEX IF NOT EXISTS comparison_runs_window ON public.comparison_runs(project_id,created_at DESC,id DESC);

CREATE OR REPLACE FUNCTION public.tastecase_comparison_safe(value jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE item jsonb; text_value text;
BEGIN
  CASE jsonb_typeof(value)
  WHEN 'object' THEN FOR text_value,item IN SELECT key,val FROM jsonb_each(value) t(key,val) LOOP
    PERFORM public.tastecase_comparison_safe(to_jsonb(text_value)); PERFORM public.tastecase_comparison_safe(item);
  END LOOP;
  WHEN 'array' THEN FOR item IN SELECT val FROM jsonb_array_elements(value) t(val) LOOP PERFORM public.tastecase_comparison_safe(item); END LOOP;
  WHEN 'string' THEN
    text_value:=value#>>'{}';
    IF text_value ~* '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|tc_runner_[A-Za-z0-9_-]{43}|(AKIA|ASIA)[A-Z0-9]{16}|\m(sk|rk|pk)_?(live|test)?[_-][A-Za-z0-9_-]{16,}\M|\meyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\M|\m(authorization\s*[:=]\s*(bearer|basic)|(api[_ -]?key|password|secret|access[_ -]?token)\s*[:=]\s*\S+)|[a-z][a-z0-9+.-]*://[^\s/@:]+:[^\s/@]+@' THEN
      RAISE EXCEPTION 'Unsafe credential-like required input' USING ERRCODE='23514';
    END IF;
  ELSE NULL;
  END CASE;
END;
$$;
-- Conservative pattern rejection is not universal detection. API also checks known
-- runtime secrets. Required input is rejected, never redacted with new checksums.
CREATE OR REPLACE FUNCTION public.tastecase_comparison_case(p_row jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE evidence jsonb:=p_row->'review'->'decision'->'evidence'; version jsonb:=p_row->'review'->'expectationVersion';
  base jsonb:=evidence->'job'->'input'->'targetInput'; inputs jsonb:='{}'; profile jsonb; profile_id text;
  task jsonb; input jsonb; content jsonb; expectation jsonb:=version->'expectation'; refs jsonb;
BEGIN
  IF version IS NULL OR version='null'::jsonb THEN RAISE EXCEPTION 'Published approval missing' USING ERRCODE='23514'; END IF;
  FOREACH profile_id IN ARRAY ARRAY['a','b'] LOOP
    SELECT p INTO profile FROM jsonb_array_elements(evidence->'job'->'input'->'request'->'profiles') p WHERE p->>'id'=profile_id;
    IF profile IS NULL THEN RAISE EXCEPTION 'Published profile missing' USING ERRCODE='23514'; END IF;
    task:=jsonb_build_object('schema_version',base->'schema_version','id',public.tastecase_review_id((evidence->>'jobId')::uuid,'task:'||profile_id||':full'),
      'label','Synthetic discovery '||profile_id||' full','catalogVersionId',base->'catalog'->'id',
      'syntheticBrief',evidence->'candidate'->'content'->'briefs'->profile_id,
      'syntheticInterests',(SELECT jsonb_agg(jsonb_build_object('provenance','synthetic','label','Public '||(a->>'kind')||' interest','text',a->>'label') ORDER BY n)
        FROM jsonb_array_elements(profile->'anchors') WITH ORDINALITY t(a,n)), 'constraints',base->'task'->'constraints');
    input:=(base-'execution')||jsonb_build_object('task',task||jsonb_build_object('projectId',evidence->'projectId',
      'checksum',public.tastecase_json_checksum(task),'createdAt',evidence->'job'->'createdAt'));
    inputs:=inputs||jsonb_build_object(profile_id,input);
  END LOOP;
  IF expectation->>'classification'='advisory' THEN expectation:=jsonb_build_object('classification','advisory','automaticFailure',false,'humanReviewRequired',true,'contrastId',expectation->'contrastId'); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',ref->'id','checksum',ref->'checksum','kind',ref->'data'->'kind',
    'providerStatus',ref->'data'->'providerStatus','missingEntryIds',coalesce(ref->'data'->'missingEntryIds','[]'),
    'unmappedEntryIds',coalesce(ref->'data'->'unmappedEntryIds','[]')) ORDER BY n),'[]') INTO refs
    FROM jsonb_array_elements(evidence->'evidence') WITH ORDINALITY t(ref,n);
  content:=jsonb_build_object('caseId',p_row->'case'->'id','caseChecksum',public.tastecase_json_checksum(p_row->'case'),
    'candidateChecksum',p_row->'case'->'candidateChecksum','jobId',evidence->'jobId','expectationVersionId',version->'id',
    'expectationChecksum',version->'checksum','evidenceChecksum',evidence->'checksum','repeatCount',evidence->'job'->'input'->'request'->'repeatCount',
    'inputs',inputs,'expectation',expectation,'evidenceReferences',refs);
  RETURN content||jsonb_build_object('checksum',public.tastecase_json_checksum(content));
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_comparison_plan(p_project uuid,p_request jsonb,p_created timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE suite public.suite_versions; selected_case text; row jsonb; projection jsonb; cases jsonb:='[]'; slots jsonb:='[]';
  role text; profile_id text; repeat int; execution jsonb; input jsonb; content jsonb;
BEGIN
  SELECT * INTO suite FROM public.suite_versions WHERE project_id=p_project AND id=(p_request->>'suiteVersionId')::uuid;
  IF suite.id IS NULL THEN RAISE EXCEPTION 'Published suite outside project' USING ERRCODE='23503'; END IF;
  FOR selected_case IN SELECT value FROM jsonb_array_elements_text(p_request->'caseIds') LOOP
    SELECT r INTO row FROM jsonb_array_elements(suite.snapshot->'cases') r WHERE r->'case'->>'id'=selected_case;
    IF row IS NULL OR NOT EXISTS(SELECT 1 FROM public.suite_version_cases c WHERE c.project_id=p_project AND c.suite_version_id=suite.id
      AND c.case_id=selected_case::uuid AND c.expectation_version_id=(row->'review'->'expectationVersion'->>'id')::uuid) THEN
      RAISE EXCEPTION 'Selected case absent from published suite' USING ERRCODE='23503';
    END IF;
    projection:=public.tastecase_comparison_case(row); cases:=cases||jsonb_build_array(projection);
    FOREACH role IN ARRAY ARRAY['baseline','candidate'] LOOP
      FOREACH profile_id IN ARRAY ARRAY['a','b'] LOOP
        FOR repeat IN 0..(projection->>'repeatCount')::int-1 LOOP
          execution:=jsonb_build_object('kind','comparison','comparisonId',p_request->'id','caseId',selected_case,
            'caseChecksum',projection->'caseChecksum','suiteVersionId',p_request->'suiteVersionId','suiteChecksum',suite.checksum,
            'expectationVersionId',projection->'expectationVersionId','expectationChecksum',projection->'expectationChecksum',
            'evidenceChecksum',projection->'evidenceChecksum','role',role,'assistantVersion',p_request->(role||'Version'),'profileId',profile_id,'repeat',repeat);
          input:=projection->'inputs'->profile_id||jsonb_build_object('execution',execution);
          slots:=slots||jsonb_build_array(jsonb_build_object('attemptId',public.tastecase_review_id((p_request->>'id')::uuid,
            'comparison:'||public.tastecase_json_checksum(jsonb_build_array(selected_case,role,profile_id,repeat))),
            'execution',execution,'input',input,'inputChecksum',public.tastecase_json_checksum(input)));
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;
  content:=jsonb_build_object('schema_version','1.0.0','id',p_request->'id','projectId',p_project,'request',p_request,
    'requestChecksum',public.tastecase_json_checksum(p_request),'suiteChecksum',suite.checksum,'createdAt',public.tastecase_review_time(p_created),'cases',cases,'slots',slots);
  IF jsonb_array_length(slots)>120 OR (p_request->>'dispatchBudget')::int<jsonb_array_length(slots)
    OR (p_request->>'dispatchBudget')::int>jsonb_array_length(slots)+(p_request->>'reclaimBudget')::int
    OR octet_length(public.canonical_json(content))>8388500 THEN RAISE EXCEPTION 'Plan exceeds bounded capacity' USING ERRCODE='23514'; END IF;
  PERFORM public.tastecase_comparison_safe(content);
  RETURN content||jsonb_build_object('checksum',public.tastecase_json_checksum(content));
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_comparison_associations(p_project uuid,p_id uuid,p_now timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('attemptId',t.attempt_id,'comparisonId',t.comparison_id,'caseId',t.case_id,
    'role',t.role,'assistantVersion',t.assistant_version,'profileId',t.profile_id,'repeat',t.repeat,'status',a.status,
    'dispatchCount',(SELECT count(*) FROM public.comparison_dispatches d WHERE d.attempt_id=t.attempt_id),
    'uncertainDispatches',(SELECT count(*) FROM public.comparison_dispatches d WHERE d.attempt_id=t.attempt_id
      AND (d.lease_id IS DISTINCT FROM a.lease_id OR (a.status='leased' AND a.lease_expires_at<=p_now))),
    'cancelled',s.cancelled_at IS NOT NULL) ORDER BY t.ordinal),'[]')
  FROM public.comparison_targets t JOIN public.target_attempts a ON a.project_id=t.project_id AND a.id=t.attempt_id
  JOIN public.comparison_state s ON s.project_id=t.project_id AND s.comparison_id=t.comparison_id
  WHERE t.project_id=p_project AND t.comparison_id=p_id
$$;
CREATE OR REPLACE FUNCTION public.tastecase_comparison_progress(rows jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('logicalSlots',count(*),'queued',count(*) FILTER(WHERE r->>'status'='queued'),
  'leased',count(*) FILTER(WHERE r->>'status'='leased'),'completed',count(*) FILTER(WHERE r->>'status'='completed'),
  'dispatches',coalesce(sum((r->>'dispatchCount')::int),0),'reclaims',coalesce(sum(greatest(0,(r->>'dispatchCount')::int-1)),0),
  'uncertainDispatches',coalesce(sum((r->>'uncertainDispatches')::int),0)) FROM jsonb_array_elements(rows) r
$$;
CREATE OR REPLACE FUNCTION public.tastecase_comparison_state_value(p_row public.comparison_state,p_run public.comparison_runs,p_now timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN p_row.state IN ('cancelled','finalized') THEN p_row.state
   WHEN NOT EXISTS(SELECT 1 FROM public.comparison_targets t JOIN public.target_attempts a ON a.id=t.attempt_id
     WHERE t.comparison_id=p_run.id AND a.status<>'completed') THEN p_row.state
   WHEN p_run.deadline_at<=p_now THEN 'deadline_exceeded'
   WHEN p_row.dispatches>=p_run.dispatch_budget THEN 'budget_exhausted' ELSE p_row.state END
$$;
CREATE OR REPLACE FUNCTION public.tastecase_comparison_run(p_project uuid,p_id uuid,p_now timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('schema_version','1.0.0','plan',r.plan,'state',public.tastecase_comparison_state_value(s,r,p_now),
  'progress',public.tastecase_comparison_progress(public.tastecase_comparison_associations(p_project,p_id,p_now)),
  'cancelledAt',public.tastecase_review_time(s.cancelled_at),'finalReport',(SELECT report FROM public.comparison_reports f WHERE f.project_id=p_project AND f.comparison_id=p_id))
 FROM public.comparison_runs r JOIN public.comparison_state s ON s.project_id=r.project_id AND s.comparison_id=r.id WHERE r.project_id=p_project AND r.id=p_id
$$;
CREATE OR REPLACE FUNCTION public.create_comparison(p_project uuid,p_owner uuid,p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='15s' SET lock_timeout='3s' AS $$
DECLARE old public.comparison_runs; plan jsonb; pack jsonb; receipt jsonb; row jsonb; slot jsonb; task jsonb; task_id uuid;
  created timestamptz:=date_trunc('milliseconds',clock_timestamp()); comparison_id uuid; ordinal int:=0; logical_slots int;
BEGIN
  PERFORM public.tastecase_review_owner(p_project,p_owner);
  PERFORM public.tastecase_review_object(p_request,ARRAY['schema_version','id','suiteVersionId','baselineVersion','candidateVersion','caseIds','deadlineAt','dispatchBudget','reclaimBudget']);
  IF (p_request->>'schema_version'='1.0.0' AND jsonb_typeof(p_request->'baselineVersion')='string' AND jsonb_typeof(p_request->'candidateVersion')='string'
    AND length(p_request->>'baselineVersion') BETWEEN 1 AND 160 AND btrim(p_request->>'baselineVersion')=p_request->>'baselineVersion'
    AND length(p_request->>'candidateVersion') BETWEEN 1 AND 160 AND btrim(p_request->>'candidateVersion')=p_request->>'candidateVersion'
    AND p_request->>'baselineVersion'<>p_request->>'candidateVersion' AND jsonb_typeof(p_request->'caseIds')='array'
    AND jsonb_array_length(p_request->'caseIds') BETWEEN 1 AND 10 AND jsonb_typeof(p_request->'dispatchBudget')='number'
    AND (p_request->>'dispatchBudget')~'^[0-9]+$' AND (p_request->>'dispatchBudget')::numeric BETWEEN 4 AND 144
    AND jsonb_typeof(p_request->'reclaimBudget')='number' AND (p_request->>'reclaimBudget')~'^[0-9]+$'
    AND (p_request->>'reclaimBudget')::numeric BETWEEN 0 AND 24 AND jsonb_typeof(p_request->'deadlineAt')='string'
    AND octet_length(public.canonical_json(p_request))<=65536) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid comparison request' USING ERRCODE='23514'; END IF;
  comparison_id:=(p_request->>'id')::uuid; PERFORM (p_request->>'suiteVersionId')::uuid;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_request->'caseIds') c WHERE jsonb_typeof(c)<>'string')
    OR (SELECT count(DISTINCT c) FROM jsonb_array_elements_text(p_request->'caseIds') c)<>jsonb_array_length(p_request->'caseIds') THEN
    RAISE EXCEPTION 'Invalid case selection' USING ERRCODE='23514'; END IF;
  PERFORM c::uuid FROM jsonb_array_elements_text(p_request->'caseIds') c;
  PERFORM pg_advisory_xact_lock(hashtextextended('tastecase:comparison-create:'||p_project::text,0));
  SELECT * INTO old FROM public.comparison_runs WHERE comparison_runs.id=comparison_id;
  IF old.id IS NOT NULL THEN
    IF old.project_id<>p_project OR old.request_checksum<>public.tastecase_json_checksum(p_request) THEN RAISE EXCEPTION 'Comparison ID content conflict' USING ERRCODE='23505'; END IF;
    RETURN old.create_receipt||jsonb_build_object('idempotent',true);
  END IF;
  IF (p_request->>'deadlineAt')::timestamptz<=created OR (p_request->>'deadlineAt')::timestamptz>created+interval '1 hour' THEN RAISE EXCEPTION 'Deadline must be within one hour' USING ERRCODE='23514'; END IF;
  plan:=public.tastecase_comparison_plan(p_project,p_request,created); logical_slots:=jsonb_array_length(plan->'slots');
  pack:=jsonb_build_object('schema_version','1.0.0','pack_version','tastecase-test-pack/1','target_output_contract','tastecase-target-output/1','plan',plan);
  pack:=pack||jsonb_build_object('checksum',public.tastecase_json_checksum(pack));
  IF octet_length(public.canonical_json(pack))>8388608 THEN RAISE EXCEPTION 'Pack exceeds byte limit' USING ERRCODE='23514'; END IF;
  receipt:=jsonb_build_object('schema_version','1.0.0','comparison',jsonb_build_object('schema_version','1.0.0','plan',plan,'state','queued',
    'progress',jsonb_build_object('logicalSlots',logical_slots,'queued',logical_slots,'leased',0,'completed',0,'dispatches',0,'reclaims',0,'uncertainDispatches',0),
    'cancelledAt',NULL,'finalReport',NULL),'idempotent',false);
  INSERT INTO public.comparison_runs(id,project_id,suite_version_id,request_checksum,plan,checksum,created_at,deadline_at,dispatch_budget,reclaim_budget,create_receipt)
    VALUES(comparison_id,p_project,(p_request->>'suiteVersionId')::uuid,plan->>'requestChecksum',plan,plan->>'checksum',created,(p_request->>'deadlineAt')::timestamptz,
      (p_request->>'dispatchBudget')::int,(p_request->>'reclaimBudget')::int,receipt);
  INSERT INTO public.comparison_state(comparison_id,project_id) VALUES(comparison_id,p_project);
  INSERT INTO public.comparison_artifacts(project_id,comparison_id,kind,content,checksum,created_at) VALUES(p_project,comparison_id,'pack',pack,pack->>'checksum',created);
  FOR row IN SELECT value FROM jsonb_array_elements(plan->'cases') LOOP
    INSERT INTO public.comparison_cases(project_id,comparison_id,suite_version_id,case_id,expectation_version_id,ordinal,projection)
      VALUES(p_project,comparison_id,(p_request->>'suiteVersionId')::uuid,(row->>'caseId')::uuid,(row->>'expectationVersionId')::uuid,ordinal,row); ordinal:=ordinal+1;
  END LOOP;
  ordinal:=0;
  FOR slot IN SELECT value FROM jsonb_array_elements(plan->'slots') LOOP
    task:=slot->'input'->'task'; task_id:=(task->>'id')::uuid;
    INSERT INTO public.task_versions(id,project_id,catalog_version_id,content,checksum,created_at)
      VALUES(task_id,p_project,(task->>'catalogVersionId')::uuid,task-ARRAY['projectId','checksum','createdAt'],task->>'checksum',(task->>'createdAt')::timestamptz) ON CONFLICT DO NOTHING;
    IF NOT EXISTS(SELECT 1 FROM public.task_versions v WHERE v.project_id=p_project AND v.id=task_id AND v.content=task-ARRAY['projectId','checksum','createdAt']
      AND v.checksum=task->>'checksum' AND v.created_at=(task->>'createdAt')::timestamptz) THEN RAISE EXCEPTION 'Pinned full-profile task identity conflict' USING ERRCODE='23505'; END IF;
    INSERT INTO public.target_attempts(id,project_id,catalog_version_id,task_version_id,pinned_input,input_checksum,created_at)
      VALUES((slot->>'attemptId')::uuid,p_project,(slot->'input'->'catalog'->>'id')::uuid,task_id,slot->'input',slot->>'inputChecksum',created);
    INSERT INTO public.comparison_targets(attempt_id,project_id,comparison_id,case_id,role,assistant_version,profile_id,repeat,catalog_version_id,ordinal)
      VALUES((slot->>'attemptId')::uuid,p_project,comparison_id,(slot->'execution'->>'caseId')::uuid,slot->'execution'->>'role',slot->'execution'->>'assistantVersion',
        slot->'execution'->>'profileId',(slot->'execution'->>'repeat')::int,(slot->'input'->'catalog'->>'id')::uuid,ordinal); ordinal:=ordinal+1;
  END LOOP;
  RETURN receipt;
END;
$$;
CREATE OR REPLACE FUNCTION public.get_comparison(p_project uuid,p_owner uuid,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='10s' AS $$
DECLARE run jsonb; timing timestamptz:=clock_timestamp();
BEGIN
  PERFORM public.tastecase_review_owner(p_project,p_owner); run:=public.tastecase_comparison_run(p_project,p_id,timing);
  IF run IS NULL THEN RAISE EXCEPTION 'Comparison outside project' USING ERRCODE='23503'; END IF;
  RETURN jsonb_build_object('schema_version','1.0.0','comparison',run,'associations',public.tastecase_comparison_associations(p_project,p_id,timing));
END;
$$;
CREATE OR REPLACE FUNCTION public.list_comparisons(p_project uuid,p_owner uuid,p_limit int DEFAULT 20,p_offset int DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='10s' AS $$
DECLARE rows jsonb; timing timestamptz:=clock_timestamp();
BEGIN
  PERFORM public.tastecase_review_owner(p_project,p_owner);
  IF p_limit NOT BETWEEN 1 AND 20 OR p_offset NOT BETWEEN 0 AND 10000 OR p_limit IS NULL OR p_offset IS NULL THEN RAISE EXCEPTION 'Invalid comparison window' USING ERRCODE='23514'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('schema_version','1.0.0','id',r.id,'projectId',r.project_id,'suiteVersionId',r.suite_version_id,
    'suiteChecksum',r.plan->'suiteChecksum','planChecksum',r.checksum,'baselineVersion',r.plan->'request'->'baselineVersion','candidateVersion',r.plan->'request'->'candidateVersion',
    'state',public.tastecase_comparison_state_value(s,r,timing),'progress',public.tastecase_comparison_progress(public.tastecase_comparison_associations(p_project,r.id,timing)),
    'createdAt',public.tastecase_review_time(r.created_at),'deadlineAt',r.plan->'request'->'deadlineAt','cancelledAt',public.tastecase_review_time(s.cancelled_at),
    'finalReportChecksum',f.checksum) ORDER BY r.created_at DESC,r.id DESC),'[]') INTO rows
  FROM (SELECT * FROM public.comparison_runs WHERE project_id=p_project ORDER BY created_at DESC,id DESC LIMIT p_limit OFFSET p_offset) r
  JOIN public.comparison_state s ON s.project_id=r.project_id AND s.comparison_id=r.id LEFT JOIN public.comparison_reports f ON f.project_id=r.project_id AND f.comparison_id=r.id;
  RETURN jsonb_build_object('schema_version','1.0.0','comparisons',rows);
END;
$$;
CREATE OR REPLACE FUNCTION public.cancel_comparison(p_project uuid,p_owner uuid,p_id uuid,p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='10s' SET lock_timeout='3s' AS $$
DECLARE old public.comparison_cancellations; s public.comparison_state; receipt jsonb; timing timestamptz:=date_trunc('milliseconds',clock_timestamp());
BEGIN
  PERFORM public.tastecase_review_owner(p_project,p_owner); PERFORM public.tastecase_review_object(p_request,ARRAY['schema_version','id']);
  IF p_request->>'schema_version' IS DISTINCT FROM '1.0.0' THEN RAISE EXCEPTION 'Invalid cancellation request' USING ERRCODE='23514'; END IF;
  SELECT * INTO s FROM public.comparison_state WHERE project_id=p_project AND comparison_id=p_id FOR UPDATE;
  IF s.comparison_id IS NULL THEN RAISE EXCEPTION 'Comparison outside project' USING ERRCODE='23503'; END IF;
  SELECT * INTO old FROM public.comparison_cancellations WHERE id=(p_request->>'id')::uuid;
  IF old.id IS NOT NULL THEN
    IF old.project_id<>p_project OR old.comparison_id<>p_id OR old.request_checksum<>public.tastecase_json_checksum(p_request) THEN RAISE EXCEPTION 'Cancellation ID content conflict' USING ERRCODE='23505'; END IF;
    RETURN old.receipt||jsonb_build_object('idempotent',true);
  END IF;
  IF s.state='finalized' THEN RAISE EXCEPTION 'Finalized comparison cannot be cancelled' USING ERRCODE='23505'; END IF;
  UPDATE public.comparison_state SET state='cancelled',cancelled_at=coalesce(cancelled_at,timing) WHERE comparison_id=p_id;
  receipt:=jsonb_build_object('schema_version','1.0.0','comparison',public.tastecase_comparison_run(p_project,p_id,timing),'idempotent',false);
  INSERT INTO public.comparison_cancellations(id,project_id,comparison_id,request_checksum,receipt,created_at)
    VALUES((p_request->>'id')::uuid,p_project,p_id,public.tastecase_json_checksum(p_request),receipt,timing);
  RETURN receipt;
END;
$$;
-- This is a prefilter, NOT a reservation. Null binding preserves legacy work but
-- can never claim comparisons, including execution-tagged orphan rows.
CREATE OR REPLACE FUNCTION public.comparison_target_claimable(p_attempt uuid,p_assistant_version text DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN t.attempt_id IS NULL THEN NOT (a.pinned_input ? 'execution') ELSE
  p_assistant_version IS NOT NULL AND p_assistant_version=t.assistant_version AND s.state IN ('queued','running')
  AND r.deadline_at>statement_timestamp() AND s.dispatches<r.dispatch_budget
  AND (a.status='queued' OR (a.status='leased' AND a.lease_expires_at<=statement_timestamp() AND s.reclaims<r.reclaim_budget)) END
 FROM public.target_attempts a LEFT JOIN public.comparison_targets t ON t.project_id=a.project_id AND t.attempt_id=a.id
 LEFT JOIN public.comparison_runs r ON r.project_id=t.project_id AND r.id=t.comparison_id
 LEFT JOIN public.comparison_state s ON s.project_id=t.project_id AND s.comparison_id=t.comparison_id WHERE a.id=p_attempt
$$;
-- Returns false without a charge if a cancellation/budget/deadline won the race.
-- True means the supplied lease is durably reserved AND installed. API must not
-- issue a second target_attempts UPDATE. Legacy work returns true unchanged.
CREATE OR REPLACE FUNCTION public.reserve_comparison_dispatch(p_project uuid,p_attempt uuid,p_lease uuid,p_credential uuid,p_seconds int,p_assistant_version text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='10s' SET lock_timeout='3s' AS $$
DECLARE t public.comparison_targets; a public.target_attempts; r public.comparison_runs; s public.comparison_state;
  old public.comparison_dispatches; n int; timing timestamptz; expiry timestamptz;
BEGIN
  IF p_lease IS NULL OR p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 900 THEN RAISE EXCEPTION 'Invalid comparison lease' USING ERRCODE='23514'; END IF;
  PERFORM id FROM public.runner_credentials WHERE project_id=p_project AND id=p_credential AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active project runner required' USING ERRCODE='42501'; END IF;
  SELECT * INTO a FROM public.target_attempts WHERE project_id=p_project AND id=p_attempt FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'Attempt outside project' USING ERRCODE='23503'; END IF;
  SELECT * INTO t FROM public.comparison_targets WHERE project_id=p_project AND attempt_id=p_attempt;
  IF t.attempt_id IS NULL THEN
    IF a.pinned_input ? 'execution' THEN RETURN false; END IF;
    RETURN true;
  END IF;
  SELECT * INTO s FROM public.comparison_state WHERE project_id=p_project AND comparison_id=t.comparison_id FOR UPDATE;
  SELECT * INTO r FROM public.comparison_runs WHERE project_id=p_project AND id=t.comparison_id;
  SELECT * INTO old FROM public.comparison_dispatches WHERE lease_id=p_lease;
  IF old.lease_id IS NOT NULL THEN
    IF old.project_id<>p_project OR old.attempt_id<>p_attempt OR old.credential_id<>p_credential OR p_assistant_version IS DISTINCT FROM t.assistant_version
      OR old.lease_expires_at<>old.dispatched_at+p_seconds*interval '1 second' THEN RAISE EXCEPTION 'Dispatch retry content conflict' USING ERRCODE='23505'; END IF;
    RETURN true;
  END IF;
  timing:=clock_timestamp();
  IF p_assistant_version IS DISTINCT FROM t.assistant_version OR s.state NOT IN ('queued','running') OR r.deadline_at<=timing
    OR s.dispatches>=r.dispatch_budget OR a.status='completed' OR (a.status='leased' AND (a.lease_expires_at>timing OR s.reclaims>=r.reclaim_budget)) THEN RETURN false; END IF;
  SELECT count(*) INTO n FROM public.comparison_dispatches WHERE attempt_id=p_attempt;
  expiry:=timing+p_seconds*interval '1 second';
  INSERT INTO public.comparison_dispatches(lease_id,project_id,comparison_id,attempt_id,credential_id,ordinal,dispatched_at,lease_expires_at)
    VALUES(p_lease,p_project,t.comparison_id,p_attempt,p_credential,n,timing,expiry);
  UPDATE public.comparison_state SET state='running',dispatches=dispatches+1,reclaims=reclaims+CASE WHEN n>0 THEN 1 ELSE 0 END WHERE comparison_id=t.comparison_id;
  UPDATE public.target_attempts SET status='leased',lease_id=p_lease,lease_credential_id=p_credential,lease_expires_at=expiry WHERE id=p_attempt;
  RETURN true;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_comparison_guard_state() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE run public.comparison_runs;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Comparison state cannot be deleted' USING ERRCODE='23514'; END IF;
  SELECT * INTO run FROM public.comparison_runs WHERE project_id=OLD.project_id AND id=OLD.comparison_id;
  IF ROW(NEW.comparison_id,NEW.project_id) IS DISTINCT FROM ROW(OLD.comparison_id,OLD.project_id)
    OR OLD.state='finalized' OR (OLD.state='cancelled' AND NEW.state NOT IN ('cancelled','finalized'))
    OR NEW.dispatches<OLD.dispatches OR NEW.reclaims<OLD.reclaims OR NEW.dispatches>run.dispatch_budget OR NEW.reclaims>run.reclaim_budget
    OR NEW.dispatches<>(SELECT count(*) FROM public.comparison_dispatches WHERE comparison_id=NEW.comparison_id)
    OR NEW.reclaims<>(SELECT count(*) FROM public.comparison_dispatches WHERE comparison_id=NEW.comparison_id AND ordinal>0)
    OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at)
    OR (NEW.state='cancelled' AND NEW.cancelled_at IS NULL)
    OR (NEW.state='finalized' AND NOT EXISTS(SELECT 1 FROM public.comparison_reports WHERE comparison_id=NEW.comparison_id)) THEN
    RAISE EXCEPTION 'Invalid comparison state advance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_comparison_guard_lease() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.status='leased' AND EXISTS(SELECT 1 FROM public.comparison_targets WHERE attempt_id=NEW.id)
    AND NOT EXISTS(SELECT 1 FROM public.comparison_dispatches d WHERE d.project_id=NEW.project_id AND d.attempt_id=NEW.id
      AND d.lease_id=NEW.lease_id AND d.credential_id=NEW.lease_credential_id AND d.lease_expires_at=NEW.lease_expires_at) THEN
    RAISE EXCEPTION 'Comparison lease requires charged dispatch receipt' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_comparison_result(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE content jsonb; ids jsonb:='[]';
BEGIN
  IF value->>'outcome'='success' THEN
    SELECT coalesce(jsonb_agg(coalesce(r->'catalogEntryId','null'::jsonb) ORDER BY n),'[]') INTO ids
      FROM jsonb_array_elements(value->'output'->'recommendations') WITH ORDINALITY t(r,n);
  END IF;
  content:=jsonb_build_object('outcome',coalesce(value->>'outcome','pending'),'resultChecksum',public.tastecase_json_checksum(value),
    'traceCompleteness',value->'trace'->'completeness','recommendationIds',ids);
  RETURN content||jsonb_build_object('checksum',public.tastecase_json_checksum(content));
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_comparison_rules(expectation jsonb,input jsonb,p_profile text,result jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE rules jsonb:='[]'; rule jsonb; n int; outcome text; reason text; applies boolean; passes boolean;
  ids jsonb:=result->'recommendationIds'; before_pos bigint; after_pos bigint; classification text:=expectation->>'classification';
BEGIN
  IF classification='advisory' THEN RETURN jsonb_build_array(jsonb_build_object('ruleIndex',0,'ruleKind','advisory','classification','advisory',
    'automaticFailure',false,'outcome','advisory','reason','human_review_required')); END IF;
  FOR rule,n IN SELECT r,(ordinal-1)::int FROM jsonb_array_elements(expectation->'rules') WITH ORDINALITY t(r,ordinal) LOOP
    outcome:='unavailable'; reason:='pending_execution';
    applies:=CASE WHEN classification='objective_contract' THEN expectation->'profiles' ? p_profile ELSE rule->>'profileId'=p_profile END;
    IF NOT applies THEN outcome:='not_applicable'; reason:='outside_profile';
    ELSIF result->>'outcome'='provider_unavailable' THEN reason:='provider_unavailable';
    ELSIF result->>'outcome'='pending' THEN reason:='pending_execution';
    ELSIF rule->>'kind'='output_schema' THEN
      outcome:=CASE WHEN result->>'outcome'='malformed_output' THEN 'fail' ELSE 'pass' END;
      reason:=CASE WHEN outcome='fail' THEN 'explicit_malformed_output' ELSE 'schema_valid' END;
    ELSIF result->>'outcome'='malformed_output' THEN reason:='malformed_execution';
    ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(ids) i WHERE i='null'::jsonb) THEN reason:='missing_identity';
    ELSIF rule->>'kind'<>'allowed_ids' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(ids) i
      WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(input->'catalog'->'entries') e WHERE e->>'id'=i)) THEN reason:='unknown_catalog_id';
    ELSE
      passes:=false;
      CASE rule->>'kind'
      WHEN 'allowed_ids' THEN passes:=NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(ids) i WHERE NOT rule->'entryIds' ? i);
      WHEN 'exclusions','avoid' THEN passes:=NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(ids) i WHERE rule->'entryIds' ? i);
      WHEN 'recommend_any' THEN passes:=EXISTS(SELECT 1 FROM jsonb_array_elements_text(ids) i WHERE rule->'entryIds' ? i);
      WHEN 'order' THEN
        SELECT min(t.n) FILTER(WHERE i=rule->>'beforeEntryId'),min(t.n) FILTER(WHERE i=rule->>'afterEntryId') INTO before_pos,after_pos
          FROM jsonb_array_elements_text(ids) WITH ORDINALITY t(i,n);
        IF before_pos IS NULL OR after_pos IS NULL THEN outcome:='not_applicable'; reason:='both_ids_not_present'; ELSE passes:=before_pos<after_pos; END IF;
      ELSE RAISE EXCEPTION 'Unsupported published comparison rule' USING ERRCODE='23514';
      END CASE;
      IF outcome<>'not_applicable' THEN outcome:=CASE WHEN passes THEN 'pass' ELSE 'fail' END; reason:=CASE WHEN passes THEN 'compliant' ELSE 'violated' END; END IF;
    END IF;
    rules:=rules||jsonb_build_array(jsonb_build_object('ruleIndex',n,'ruleKind',rule->>'kind','classification',classification,'automaticFailure',true,'outcome',outcome,'reason',reason));
  END LOOP;
  RETURN rules;
END;
$$;
CREATE OR REPLACE FUNCTION public.tastecase_comparison_source(p_project uuid,p_id uuid,p_now timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('plan',r.plan,'state',public.tastecase_comparison_state_value(s,r,p_now),
  'associations',public.tastecase_comparison_associations(p_project,p_id,p_now),
  'attempts',(SELECT jsonb_agg(jsonb_build_object('schema_version',a.schema_version,'id',a.id,'projectId',a.project_id,
    'catalogVersionId',a.catalog_version_id,'taskVersionId',a.task_version_id,
    'mappingConfirmationIds',(SELECT coalesce(jsonb_agg(m.mapping_confirmation_id ORDER BY m.mapping_confirmation_id),'[]') FROM public.target_attempt_mappings m WHERE m.attempt_id=a.id),
    'status',a.status,'input',a.pinned_input,'inputChecksum',a.input_checksum,'leaseId',a.lease_id,'leaseCredentialId',a.lease_credential_id,
    'leaseExpiresAt',public.tastecase_review_time(a.lease_expires_at),'result',a.result,'resultChecksum',a.result_checksum,
    'createdAt',public.tastecase_review_time(a.created_at),'completedAt',public.tastecase_review_time(a.completed_at)) ORDER BY t.ordinal)
    FROM public.comparison_targets t JOIN public.target_attempts a ON a.project_id=t.project_id AND a.id=t.attempt_id WHERE t.project_id=p_project AND t.comparison_id=p_id))
 FROM public.comparison_runs r JOIN public.comparison_state s ON s.project_id=r.project_id AND s.comparison_id=r.id WHERE r.project_id=p_project AND r.id=p_id
$$;
CREATE OR REPLACE FUNCTION public.tastecase_comparison_report(source jsonb,p_request jsonb,p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE plan jsonb:=source->'plan'; progress jsonb:=public.tastecase_comparison_progress(source->'associations');
  partial boolean:=(progress->>'completed')::int<>(progress->>'logicalSlots')::int;
  repeats jsonb:='[]'; summaries jsonb:='[]'; changes jsonb:='[]'; limitations jsonb;
  slot jsonb; association jsonb; row jsonb; result jsonb; rules jsonb; outcome text;
  case_row jsonb; role text; profile_id text; outcomes jsonb; selected jsonb; disagreement boolean; behavior_disagreement boolean;
  repeat int; baseline jsonb; candidate jsonb; known boolean; content jsonb;
BEGIN
  IF partial AND p_request->>'allowPartial'<>'true' THEN RAISE EXCEPTION 'Pending work requires explicit partial finalization or waiting' USING ERRCODE='40001'; END IF;
  FOR slot IN SELECT value FROM jsonb_array_elements(plan->'slots') LOOP
    SELECT a INTO association FROM jsonb_array_elements(source->'associations') a WHERE a->>'attemptId'=slot->>'attemptId';
    SELECT c INTO row FROM jsonb_array_elements(plan->'cases') c WHERE c->>'caseId'=slot->'execution'->>'caseId';
    SELECT public.tastecase_comparison_result(nullif(a->'result','null'::jsonb)) INTO result FROM jsonb_array_elements(source->'attempts') a WHERE a->>'id'=slot->>'attemptId';
    rules:=public.tastecase_comparison_rules(row->'expectation',slot->'input',slot->'execution'->>'profileId',result);
    SELECT o INTO outcome FROM unnest(ARRAY['fail','unavailable','pass','advisory','not_applicable']) WITH ORDINALITY t(o,n)
      WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(rules) r WHERE r->>'outcome'=o) ORDER BY n LIMIT 1;
    repeats:=repeats||jsonb_build_array(jsonb_build_object('attemptId',slot->'attemptId','caseId',row->'caseId','role',slot->'execution'->'role',
      'assistantVersion',slot->'execution'->'assistantVersion','profileId',slot->'execution'->'profileId','repeat',slot->'execution'->'repeat',
      'inputChecksum',slot->'inputChecksum','dispatchCount',association->'dispatchCount','uncertainDispatches',association->'uncertainDispatches',
      'result',result,'rules',rules,'outcome',coalesce(outcome,'unavailable')));
  END LOOP;
  FOR case_row IN SELECT value FROM jsonb_array_elements(plan->'cases') LOOP
    FOREACH role IN ARRAY ARRAY['baseline','candidate'] LOOP
      FOREACH profile_id IN ARRAY ARRAY['a','b'] LOOP
        SELECT jsonb_agg(r ORDER BY n),jsonb_agg(r->'outcome' ORDER BY n),count(DISTINCT r->>'outcome')>1,
          count(DISTINCT r->'result'->'recommendationIds') FILTER(WHERE r->'result'->>'outcome'='success'
            AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'result'->'recommendationIds') i WHERE i='null'::jsonb))>1
          INTO selected,outcomes,disagreement,behavior_disagreement FROM jsonb_array_elements(repeats) WITH ORDINALITY t(r,n)
          WHERE r->>'caseId'=case_row->>'caseId' AND r->>'role'=role AND r->>'profileId'=profile_id;
        summaries:=summaries||jsonb_build_array(jsonb_build_object('caseId',case_row->'caseId','role',role,'profileId',profile_id,
          'repeatCount',case_row->'repeatCount','outcomes',outcomes,'outcome',CASE WHEN disagreement THEN 'mixed' ELSE outcomes->>0 END,
          'disagreement',disagreement,'behaviorDisagreement',behavior_disagreement));
      END LOOP;
    END LOOP;
    FOREACH profile_id IN ARRAY ARRAY['a','b'] LOOP
      FOR repeat IN 0..(case_row->>'repeatCount')::int-1 LOOP
        SELECT r INTO baseline FROM jsonb_array_elements(repeats) r WHERE r->>'caseId'=case_row->>'caseId' AND r->>'role'='baseline' AND r->>'profileId'=profile_id AND (r->>'repeat')::int=repeat;
        SELECT r INTO candidate FROM jsonb_array_elements(repeats) r WHERE r->>'caseId'=case_row->>'caseId' AND r->>'role'='candidate' AND r->>'profileId'=profile_id AND (r->>'repeat')::int=repeat;
        known:=baseline->'result'->>'outcome'='success' AND candidate->'result'->>'outcome'='success'
          AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements((baseline->'result'->'recommendationIds')||(candidate->'result'->'recommendationIds')) i
            WHERE i='null'::jsonb OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(case_row->'inputs'->'a'->'catalog'->'entries') e WHERE e->'id'=i));
        changes:=changes||jsonb_build_array(jsonb_build_object('caseId',case_row->'caseId','profileId',profile_id,'repeat',repeat,
          'status',CASE WHEN NOT known THEN 'unavailable' WHEN baseline->'result'->'recommendationIds'=candidate->'result'->'recommendationIds' THEN 'unchanged' ELSE 'changed' END,
          'interpretation','Behavior change is not evidence of improved taste.'));
      END LOOP;
    END LOOP;
  END LOOP;
  limitations:='["scoped_policy_only","not_individual_taste","qloo_not_redistributed","pinned_fact_freshness_unknown"]';
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(repeats) r WHERE r->'result'->>'traceCompleteness' IS DISTINCT FROM 'complete') THEN limitations:=limitations||'"incomplete_traces"'::jsonb; END IF;
  IF partial THEN limitations:=limitations||'"partial_execution"'::jsonb; END IF;
  IF (progress->>'uncertainDispatches')::int>0 THEN limitations:=limitations||'"uncertain_dispatch"'::jsonb; END IF;
  content:=jsonb_build_object('schema_version','1.0.0','report_version','tastecase-comparison-report/1','id',p_request->'id','comparisonId',plan->'id',
    'projectId',plan->'projectId','planChecksum',plan->'checksum','suiteVersionId',plan->'request'->'suiteVersionId','suiteChecksum',plan->'suiteChecksum',
    'baselineVersion',plan->'request'->'baselineVersion','candidateVersion',plan->'request'->'candidateVersion','requestChecksum',public.tastecase_json_checksum(p_request),
    'finalizedAt',public.tastecase_review_time(p_now),'completion',CASE WHEN partial THEN 'partial' ELSE 'complete' END,
    'stopReason',CASE WHEN source->>'state' IN ('cancelled','deadline_exceeded','budget_exhausted') THEN source->>'state' WHEN partial THEN 'explicit_partial' ELSE 'completed' END,
    'progress',progress,'repeats',repeats,'summaries',summaries,'behaviorChanges',changes,'limitations',limitations);
  PERFORM public.tastecase_comparison_safe(content);
  RETURN content||jsonb_build_object('checksum',public.tastecase_json_checksum(content));
END;
$$;
-- Caller supplies no source/result/report. API validates the returned report using
-- validateComparisonReportAgainstPlan BEFORE committing this transaction.
CREATE OR REPLACE FUNCTION public.finalize_comparison(p_project uuid,p_owner uuid,p_id uuid,p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='15s' SET lock_timeout='3s' AS $$
DECLARE s public.comparison_state; old public.comparison_reports; source jsonb; report jsonb; timing timestamptz;
BEGIN
  PERFORM public.tastecase_review_owner(p_project,p_owner); PERFORM public.tastecase_review_object(p_request,ARRAY['schema_version','id','allowPartial']);
  IF p_request->>'schema_version' IS DISTINCT FROM '1.0.0' OR jsonb_typeof(p_request->'allowPartial') IS DISTINCT FROM 'boolean'
    OR octet_length(public.canonical_json(p_request))>65536 THEN RAISE EXCEPTION 'Invalid finalization request' USING ERRCODE='23514'; END IF;
  PERFORM a.id FROM public.target_attempts a JOIN public.comparison_targets t ON t.project_id=a.project_id AND t.attempt_id=a.id
    WHERE t.project_id=p_project AND t.comparison_id=p_id ORDER BY a.id FOR UPDATE OF a;
  SELECT * INTO s FROM public.comparison_state WHERE project_id=p_project AND comparison_id=p_id FOR UPDATE;
  IF s.comparison_id IS NULL THEN RAISE EXCEPTION 'Comparison outside project' USING ERRCODE='23503'; END IF;
  SELECT * INTO old FROM public.comparison_reports WHERE id=(p_request->>'id')::uuid OR comparison_id=p_id ORDER BY id LIMIT 1;
  IF old.id IS NOT NULL THEN
    IF old.project_id<>p_project OR old.comparison_id<>p_id OR old.id<>(p_request->>'id')::uuid OR old.request_checksum<>public.tastecase_json_checksum(p_request) THEN
      RAISE EXCEPTION 'Finalization ID content conflict' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('schema_version','1.0.0','report',old.report,'idempotent',true);
  END IF;
  timing:=date_trunc('milliseconds',clock_timestamp()); source:=public.tastecase_comparison_source(p_project,p_id,timing);
  report:=public.tastecase_comparison_report(source,p_request,timing);
  INSERT INTO public.comparison_reports(id,project_id,comparison_id,request_checksum,report,checksum,created_at)
    VALUES((p_request->>'id')::uuid,p_project,p_id,public.tastecase_json_checksum(p_request),report,report->>'checksum',timing);
  INSERT INTO public.comparison_artifacts(project_id,comparison_id,kind,content,checksum,created_at) VALUES(p_project,p_id,'report',report,report->>'checksum',timing);
  UPDATE public.comparison_state SET state='finalized' WHERE comparison_id=p_id;
  RETURN jsonb_build_object('schema_version','1.0.0','report',report,'idempotent',false);
END;
$$;
CREATE OR REPLACE FUNCTION public.export_comparison_artifact(p_project uuid,p_owner uuid,p_id uuid,p_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='10s' AS $$
DECLARE content jsonb;
BEGIN
  PERFORM public.tastecase_review_owner(p_project,p_owner);
  IF p_kind IS NULL OR p_kind NOT IN ('pack','report') THEN RAISE EXCEPTION 'Unsupported comparison artifact' USING ERRCODE='23514'; END IF;
  SELECT a.content INTO content FROM public.comparison_artifacts a WHERE a.project_id=p_project AND a.comparison_id=p_id AND a.kind=p_kind;
  IF content IS NULL THEN RAISE EXCEPTION 'Immutable artifact unavailable' USING ERRCODE='23503'; END IF;
  PERFORM public.tastecase_comparison_safe(content); RETURN content;
END;
$$;
DO $$
DECLARE table_name text; f record;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['comparison_runs','comparison_state','comparison_cases','comparison_targets','comparison_dispatches','comparison_cancellations','comparison_reports','comparison_artifacts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',table_name);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated,service_role',table_name);
    EXECUTE format('DROP POLICY IF EXISTS tastecase_owner_read ON public.%I',table_name);
    EXECUTE format('CREATE POLICY tastecase_owner_read ON public.%I FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.projects WHERE id=project_id AND owner_id=(SELECT auth.uid())))',table_name);
    IF table_name<>'comparison_state' THEN
      EXECUTE format('DROP TRIGGER IF EXISTS tastecase_immutable ON public.%I',table_name);
      EXECUTE format('CREATE TRIGGER tastecase_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.tastecase_immutable()',table_name);
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS tastecase_immutable_truncate ON public.%I',table_name);
    EXECUTE format('CREATE TRIGGER tastecase_immutable_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.tastecase_immutable()',table_name);
  END LOOP;
  FOR f IN SELECT oid::regprocedure AS signature,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND
    (proname LIKE 'tastecase\_comparison\_%' ESCAPE '\' OR proname IN ('create_comparison','get_comparison','list_comparisons','cancel_comparison','comparison_target_claimable','reserve_comparison_dispatch','finalize_comparison','export_comparison_artifact')) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
    IF f.proname IN ('create_comparison','get_comparison','list_comparisons','cancel_comparison','comparison_target_claimable','reserve_comparison_dispatch','finalize_comparison','export_comparison_artifact') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
    END IF;
  END LOOP;
END;
$$;
DROP TRIGGER IF EXISTS tastecase_comparison_guard_state ON public.comparison_state;
CREATE TRIGGER tastecase_comparison_guard_state BEFORE UPDATE OR DELETE ON public.comparison_state FOR EACH ROW EXECUTE FUNCTION public.tastecase_comparison_guard_state();
DROP TRIGGER IF EXISTS tastecase_comparison_guard_lease ON public.target_attempts;
CREATE TRIGGER tastecase_comparison_guard_lease BEFORE UPDATE ON public.target_attempts FOR EACH ROW EXECUTE FUNCTION public.tastecase_comparison_guard_lease();
