-- Releasing or terminating a lease must retain outstanding reservations visibly.
-- Never rewrite accepted evidence, refund counters or claim exactly-once dispatch.
CREATE OR REPLACE FUNCTION public.tastecase_close_discovery_dispatches() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.lease_id IS NULL AND OLD.lease_id IS NOT NULL)
    OR NEW.state IN ('awaiting_review','no_useful_contrast','unavailable','partial','budget_exhausted','deadline_exceeded','cancelled','failed') THEN
    UPDATE public.discovery_provider_attempts
      SET status=CASE WHEN status='reserved' THEN 'interrupted' ELSE 'uncertain' END,
        finished_at=clock_timestamp()
      WHERE project_id=NEW.project_id AND job_id=NEW.job_id AND status IN ('reserved','dispatched');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tastecase_close_discovery_dispatches() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER discovery_close_dispatches AFTER UPDATE ON public.discovery_job_state
  FOR EACH ROW EXECUTE FUNCTION public.tastecase_close_discovery_dispatches();

-- One-time reconciliation of pre-fix interrupted work without touching job inputs,
-- execution counters, immutable evidence or still-owned active dispatches.
UPDATE public.discovery_provider_attempts a
  SET status=CASE WHEN a.status='reserved' THEN 'interrupted' ELSE 'uncertain' END,
    finished_at=clock_timestamp()
  FROM public.discovery_job_state s
  WHERE a.project_id=s.project_id AND a.job_id=s.job_id AND a.status IN ('reserved','dispatched')
    AND (s.lease_id IS NULL OR s.state IN ('awaiting_review','no_useful_contrast','unavailable','partial','budget_exhausted','deadline_exceeded','cancelled','failed'));
