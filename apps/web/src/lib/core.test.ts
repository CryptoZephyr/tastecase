import { describe, expect, it } from 'vitest';
import { fromApiError, isUncertain } from './api/result';
import { unwiredApi } from './api/unwired';
import { safeNext } from './routes';
import { parseCatalogJson } from './view/catalog-import';
import { positionChanges, reportRows, outcomeCounts } from './view/comparison-view';
import { nextAction, setupSteps, type ProjectFacts } from './view/project-facts';
import * as fx from '@/test/fixtures';

describe('API result mapping', () => {
  it('maps backend error codes and statuses to distinct UI kinds', () => {
    const body = (code: 'conflict' | 'not_found' | 'unauthorized' | 'credential_revoked') => ({ schema_version: '1.0.0' as const, error: { code, message: 'Safe message.' } });
    expect(fromApiError(409, body('conflict')).kind).toBe('conflict');
    expect(fromApiError(404, body('not_found')).kind).toBe('not_found');
    expect(fromApiError(401, body('unauthorized')).kind).toBe('unauthorized');
    expect(fromApiError(401, body('credential_revoked')).kind).toBe('credential_revoked');
    expect(fromApiError(503, null).kind).toBe('busy');
    expect(fromApiError(413, null).kind).toBe('too_large');
    expect(fromApiError(500, null).kind).toBe('internal');
  });
  it('treats only unknown outcomes as uncertain', () => {
    expect(isUncertain({ kind: 'network' })).toBe(true);
    expect(isUncertain({ kind: 'busy' })).toBe(true);
    expect(isUncertain({ kind: 'conflict' })).toBe(false);
    expect(isUncertain({ kind: 'not_connected' })).toBe(false);
  });
});

describe('unwired transport', () => {
  it('reports not_connected from every method instead of returning data', async () => {
    const groups = Object.entries(unwiredApi).filter(([key]) => key !== 'transport') as [string, Record<string, (...args: unknown[]) => Promise<{ ok: boolean; error?: { kind: string } }>>][];
    let count = 0;
    for (const [, methods] of groups) {
      for (const method of Object.values(methods)) {
        const result = await method('p', 'x', {});
        expect(result.ok).toBe(false);
        expect(result.error?.kind).toBe('not_connected');
        count++;
      }
    }
    expect(count).toBeGreaterThan(40);
  });
});

describe('safeNext', () => {
  it('accepts same-origin paths only', () => {
    expect(safeNext('/projects/abc')).toBe('/projects/abc');
    expect(safeNext('https://evil.example')).toBe('/projects');
    expect(safeNext('//evil.example')).toBe('/projects');
    expect(safeNext('/\\evil.example')).toBe('/projects');
    expect(safeNext(undefined)).toBe('/projects');
  });
});

describe('catalog import checks', () => {
  it('accepts a valid array and an entries object', () => {
    expect(parseCatalogJson('[{"id":"a","name":"A"},{"id":"b","name":"B"}]').ok).toBe(true);
    expect(parseCatalogJson('{"entries":[{"id":"a","name":"A"}]}').ok).toBe(true);
  });
  it('reports readable problems without discarding input', () => {
    const result = parseCatalogJson('[{"id":"a","name":"A"},{"id":"a","name":""},{"id":"c","name":"C","price":3,"qlooEntityId":"nope"}]');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const messages = result.issues.map(issue => issue.message).join(' ');
      expect(messages).toContain('Duplicate');
      expect(messages).toContain('"name"');
      expect(messages).toContain('Unsupported field "price"');
      expect(messages).toContain('qlooEntityId');
    }
    expect(parseCatalogJson('not json').ok).toBe(false);
  });
});

describe('comparison view', () => {
  it('describes moved, added and removed positions', () => {
    expect(positionChanges(['x', 'y', 'z'], ['y', 'x', 'w'])).toEqual([
      { id: 'x', baseline: 1, candidate: 2, status: 'moved' },
      { id: 'y', baseline: 2, candidate: 1, status: 'moved' },
      { id: 'z', baseline: 3, candidate: null, status: 'removed' },
      { id: 'w', baseline: null, candidate: 3, status: 'added' },
    ]);
  });
  it('groups the frozen report by case, brief and repeat without inventing results', () => {
    const rows = reportRows(fx.plan, fx.report);
    expect(rows).toHaveLength(1);
    expect(rows[0].profiles.map(row => row.profile)).toEqual(['a', 'b']);
    const b = rows[0].profiles[1];
    expect(b.candidate?.outcome).toBe('mixed');
    expect(b.repeats[1].candidate?.result.outcome).toBe('pending');
    expect(b.behaviour).toEqual({ changed: 1, unchanged: 0, unavailable: 1 });
    expect(outcomeCounts(fx.report)).toMatchObject({ pass: 1, mixed: 1, not_applicable: 2, fail: 0 });
  });
});

describe('project next step', () => {
  const facts = (patch: Partial<ProjectFacts> = {}): ProjectFacts => ({ credentials: [], catalogs: [], mappings: [], tasks: [], jobs: [], cases: [], suites: [], comparisons: [], ...patch });
  it('starts with the runner and follows saved records only', () => {
    expect(nextAction(fx.ids.project, facts()).title).toBe('Connect your runner');
    expect(nextAction(fx.ids.project, facts({ credentials: fx.credentials })).title).toBe('Import your restaurant catalog');
    const ready = facts({ credentials: fx.credentials, catalogs: [fx.catalog], mappings: fx.mappings, tasks: [fx.task] });
    expect(nextAction(fx.ids.project, ready).title).toBe('Start discovery');
    expect(nextAction(fx.ids.project, { ...ready, jobs: [fx.job('needs_confirmation')] }).title).toBe('Confirm an interest match');
    expect(nextAction(fx.ids.project, { ...ready, jobs: [fx.job()], cases: [fx.caseResponse()] }).title).toBe('Review a saved case');
  });
  it('does not count a revoked credential as connected', () => {
    const revoked = [{ ...fx.credentials[0], revokedAt: '2026-10-13T12:00:00.000Z' }];
    expect(setupSteps(facts({ credentials: revoked }))[0].done).toBe(false);
  });
});
