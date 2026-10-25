CREATE OR REPLACE FUNCTION public.tastecase_validate_discovery_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE d jsonb := NEW.data; input jsonb; ref text; mapped jsonb; missing jsonb; unmapped jsonb; a jsonb; b jsonb; c jsonb; allowed text[]; h jsonb;
BEGIN
  SELECT pinned_input->'targetInput' INTO input FROM public.discovery_jobs WHERE project_id=NEW.project_id AND id=NEW.job_id;
  allowed := CASE d->>'kind'
    WHEN 'rank' THEN ARRAY['kind','providerStatus','profileId','scope','requestedEntryIds','orderedEntryIds','missingEntryIds','unmappedEntryIds','mappingConfirmationIds','anchorConfirmationIds','error','http','affinities','entryTags']
    WHEN 'resolve' THEN ARRAY['kind','providerStatus','anchorId','candidates','error','http']
    WHEN 'facts' THEN ARRAY['kind','rankingEvidenceIds','contrasts','missingEntryIds','unmappedEntryIds','unsupportedReason']
    WHEN 'model_decision' THEN ARRAY['kind','selectedContrastId','rationale'] END;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(d) k WHERE NOT k=ANY(allowed)) THEN RAISE EXCEPTION 'Only normalised task evidence may be stored' USING ERRCODE='23514'; END IF;
  IF d ? 'http' THEN
    h := d->'http';
    IF jsonb_typeof(h) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Malformed Qloo HTTP receipt' USING ERRCODE='23514'; END IF;
    IF NOT (h ?& ARRAY['maxAttempts','attempts','cacheHits','requests']) OR
      EXISTS(SELECT 1 FROM jsonb_object_keys(h) k WHERE NOT k=ANY(ARRAY['maxAttempts','attempts','cacheHits','requests'])) OR
      h->'maxAttempts' IS DISTINCT FROM '2'::jsonb OR jsonb_typeof(h->'attempts') IS DISTINCT FROM 'number' OR
      jsonb_typeof(h->'cacheHits') IS DISTINCT FROM 'number' OR jsonb_typeof(h->'requests') IS DISTINCT FROM 'array'
      THEN RAISE EXCEPTION 'Malformed Qloo HTTP receipt' USING ERRCODE='23514'; END IF;
    IF (h->>'attempts')::numeric<>jsonb_array_length(h->'requests') OR jsonb_array_length(h->'requests')>2 OR
      (h->>'cacheHits')::numeric NOT BETWEEN 0 AND 15 OR trunc((h->>'cacheHits')::numeric)<>(h->>'cacheHits')::numeric
      THEN RAISE EXCEPTION 'Invalid Qloo HTTP counts' USING ERRCODE='23514'; END IF;
    FOR c IN SELECT value FROM jsonb_array_elements(h->'requests') LOOP
      IF jsonb_typeof(c) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Malformed Qloo HTTP request receipt' USING ERRCODE='23514'; END IF;
      IF NOT (c ?& ARRAY['endpoint','status','retryAfterSeconds']) OR
        EXISTS(SELECT 1 FROM jsonb_object_keys(c) k WHERE NOT k=ANY(ARRAY['endpoint','status','retryAfterSeconds'])) OR
        (c->>'endpoint' IN ('/entities','/search','/v2/insights')) IS NOT TRUE OR
        (jsonb_typeof(c->'status') IN ('number','null')) IS NOT TRUE OR
        (jsonb_typeof(c->'retryAfterSeconds') IN ('number','null')) IS NOT TRUE
        THEN RAISE EXCEPTION 'Unsafe Qloo HTTP request receipt' USING ERRCODE='23514'; END IF;
      IF jsonb_typeof(c->'status')='number' AND ((c->>'status')::numeric NOT BETWEEN 100 AND 599 OR trunc((c->>'status')::numeric)<>(c->>'status')::numeric)
        THEN RAISE EXCEPTION 'Invalid Qloo HTTP status' USING ERRCODE='23514'; END IF;
      IF jsonb_typeof(c->'retryAfterSeconds')='number' AND ((c->>'retryAfterSeconds')::numeric NOT BETWEEN 0 AND 9007199254740991 OR trunc((c->>'retryAfterSeconds')::numeric)<>(c->>'retryAfterSeconds')::numeric)
        THEN RAISE EXCEPTION 'Invalid Qloo retry delay' USING ERRCODE='23514'; END IF;
    END LOOP;
  END IF;
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
    IF d ? 'affinities' THEN
      IF jsonb_typeof(d->'affinities') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Malformed rank affinities' USING ERRCODE='23514'; END IF;
      IF jsonb_array_length(d->'affinities')>10 OR
        (SELECT count(*) FROM jsonb_array_elements(d->'affinities'))<>(SELECT count(DISTINCT value->>'entryId') FROM jsonb_array_elements(d->'affinities') AS rows(value))
        THEN RAISE EXCEPTION 'Invalid rank affinity count or duplicate entries' USING ERRCODE='23514'; END IF;
      FOR c IN SELECT value FROM jsonb_array_elements(d->'affinities') LOOP
        IF jsonb_typeof(c) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Malformed rank affinity' USING ERRCODE='23514'; END IF;
        IF NOT (c ?& ARRAY['entryId','affinity','interests']) OR EXISTS(SELECT 1 FROM jsonb_object_keys(c) k WHERE NOT k=ANY(ARRAY['entryId','affinity','interests']))
          OR jsonb_typeof(c->'entryId') IS DISTINCT FROM 'string' OR NOT ((d->'orderedEntryIds') @> jsonb_build_array(c->>'entryId'))
          OR jsonb_typeof(c->'affinity') IS DISTINCT FROM 'number' OR jsonb_typeof(c->'interests') IS DISTINCT FROM 'array'
          THEN RAISE EXCEPTION 'Invalid rank affinity fields' USING ERRCODE='23514'; END IF;
        IF (c->>'affinity')::numeric NOT BETWEEN 0 AND 1 OR jsonb_array_length(c->'interests')>5
          THEN RAISE EXCEPTION 'Rank affinity outside bounds' USING ERRCODE='23514'; END IF;
        IF (SELECT count(*) FROM jsonb_array_elements(c->'interests'))<>(SELECT count(DISTINCT value->>'anchorConfirmationId') FROM jsonb_array_elements(c->'interests') AS rows(value))
          THEN RAISE EXCEPTION 'Duplicate rank interest anchors' USING ERRCODE='23514'; END IF;
        FOR b IN SELECT value FROM jsonb_array_elements(c->'interests') LOOP
          IF jsonb_typeof(b) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Malformed rank interest' USING ERRCODE='23514'; END IF;
          IF NOT (b ?& ARRAY['anchorConfirmationId','score']) OR EXISTS(SELECT 1 FROM jsonb_object_keys(b) k WHERE NOT k=ANY(ARRAY['anchorConfirmationId','score']))
            OR jsonb_typeof(b->'anchorConfirmationId') IS DISTINCT FROM 'string'
            OR NOT ((d->'anchorConfirmationIds') @> jsonb_build_array(b->>'anchorConfirmationId'))
            OR jsonb_typeof(b->'score') IS DISTINCT FROM 'number'
            THEN RAISE EXCEPTION 'Invalid rank interest fields' USING ERRCODE='23514'; END IF;
          IF (b->>'score')::numeric NOT BETWEEN 0 AND 1 THEN RAISE EXCEPTION 'Rank interest score outside bounds' USING ERRCODE='23514'; END IF;
        END LOOP;
      END LOOP;
    END IF;
    IF d ? 'entryTags' THEN
      IF jsonb_typeof(d->'entryTags') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Malformed rank entry tags' USING ERRCODE='23514'; END IF;
      IF jsonb_array_length(d->'entryTags')>10 OR
        (SELECT count(*) FROM jsonb_array_elements(d->'entryTags'))<>(SELECT count(DISTINCT value->>'entryId') FROM jsonb_array_elements(d->'entryTags') AS rows(value))
        THEN RAISE EXCEPTION 'Invalid rank tag count or duplicate entries' USING ERRCODE='23514'; END IF;
      FOR c IN SELECT value FROM jsonb_array_elements(d->'entryTags') LOOP
        IF jsonb_typeof(c) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Malformed rank entry tags' USING ERRCODE='23514'; END IF;
        IF NOT (c ?& ARRAY['entryId','tags']) OR EXISTS(SELECT 1 FROM jsonb_object_keys(c) k WHERE NOT k=ANY(ARRAY['entryId','tags']))
          OR jsonb_typeof(c->'entryId') IS DISTINCT FROM 'string' OR NOT ((d->'requestedEntryIds') @> jsonb_build_array(c->>'entryId'))
          OR jsonb_typeof(c->'tags') IS DISTINCT FROM 'array'
          THEN RAISE EXCEPTION 'Invalid rank entry tag fields' USING ERRCODE='23514'; END IF;
        IF jsonb_array_length(c->'tags')>12 THEN RAISE EXCEPTION 'Too many rank entity tags' USING ERRCODE='23514'; END IF;
        FOR b IN SELECT value FROM jsonb_array_elements(c->'tags') LOOP
          IF jsonb_typeof(b) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Malformed rank entity tag' USING ERRCODE='23514'; END IF;
          IF NOT (b ?& ARRAY['type','name']) OR EXISTS(SELECT 1 FROM jsonb_object_keys(b) k WHERE NOT k=ANY(ARRAY['type','name']))
            OR jsonb_typeof(b->'type') IS DISTINCT FROM 'string'
            OR b->>'type' NOT IN ('urn:tag:cuisine:qloo','urn:tag:genre:place','urn:tag:category:place','urn:tag:ambience:qloo','urn:tag:culinary_style:qloo')
            OR jsonb_typeof(b->'name') IS DISTINCT FROM 'string' OR b->>'name' IS DISTINCT FROM btrim(b->>'name')
            OR char_length(b->>'name') NOT BETWEEN 1 AND 80
            THEN RAISE EXCEPTION 'Invalid rank entity tag fields' USING ERRCODE='23514'; END IF;
        END LOOP;
      END LOOP;
    END IF;
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
