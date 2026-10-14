-- Published timestamps use milliseconds; discovery tasks retain PostgreSQL microseconds.
-- Compare their canonical representation without changing immutable task or suite rows.
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
      AND v.checksum=task->>'checksum' AND public.tastecase_review_time(v.created_at)=public.tastecase_review_time((task->>'createdAt')::timestamptz)) THEN RAISE EXCEPTION 'Pinned full-profile task identity conflict' USING ERRCODE='23505'; END IF;
    INSERT INTO public.target_attempts(id,project_id,catalog_version_id,task_version_id,pinned_input,input_checksum,created_at)
      VALUES((slot->>'attemptId')::uuid,p_project,(slot->'input'->'catalog'->>'id')::uuid,task_id,slot->'input',slot->>'inputChecksum',created);
    INSERT INTO public.comparison_targets(attempt_id,project_id,comparison_id,case_id,role,assistant_version,profile_id,repeat,catalog_version_id,ordinal)
      VALUES((slot->>'attemptId')::uuid,p_project,comparison_id,(slot->'execution'->>'caseId')::uuid,slot->'execution'->>'role',slot->'execution'->>'assistantVersion',
        slot->'execution'->>'profileId',(slot->'execution'->>'repeat')::int,(slot->'input'->'catalog'->>'id')::uuid,ordinal); ordinal:=ordinal+1;
  END LOOP;
  RETURN receipt;
END;
$$;
