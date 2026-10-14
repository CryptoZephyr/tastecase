import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { fail, ok } from '@/lib/api/result';
import { fixtureApi } from '@/test/fixture-api';
import * as fx from '@/test/fixtures';
import { loadComparisonSuite } from './comparison-evidence';
import { loadOwnerHistory } from './owner-history';
import { loadProjectFacts, nextAction } from './project-facts';
import { quotePosix } from './shell-quote';

describe('bounded owner paging', () => {
  it('continues beyond a full first page and confirms an exactly-full last page', async () => {
    const rows = Array.from({ length: 40 }, (_, index) => `Fixture row ${index}`);
    const page = vi.fn(async ({ limit, offset }: { limit?: number; offset?: number }) => ok(rows.slice(offset ?? 0, (offset ?? 0) + (limit ?? 20))));
    expect(await loadOwnerHistory(page)).toEqual(ok(rows));
    expect(page.mock.calls.map(([window]) => window)).toEqual([{ limit: 20, offset: 0 }, { limit: 20, offset: 20 }, { limit: 20, offset: 40 }]);
  });
  it('fails visibly rather than turning a later-page error into a partial success', async () => {
    const page = vi.fn().mockResolvedValueOnce(ok(Array(20).fill('Fixture row'))).mockResolvedValueOnce(fail({ kind: 'forbidden' }));
    expect(await loadOwnerHistory(page)).toEqual(fail({ kind: 'forbidden' }));
  });
  it('stops at the API offset bound and never claims completion', async () => {
    const page = vi.fn(async () => ok(Array(20).fill('Fixture row')));
    const result = await loadOwnerHistory(page);
    expect(result.ok).toBe(false);
    expect(page).toHaveBeenCalledTimes(501);
    expect(page).toHaveBeenLastCalledWith({ limit: 20, offset: 10000 });
  });
  it('includes older saved cases in project readiness, not just the first twenty', async () => {
    const api = fixtureApi();
    const reviewed = Array.from({ length: 20 }, (_, index) => ({ ...fx.approvedCase, case: { ...fx.approvedCase.case, id: `Fixture reviewed ${index}` } }));
    api.cases.list = vi.fn(async (_project, window) => ok(window?.offset ? [fx.caseResponse()] : reviewed));
    const result = await loadProjectFacts(api, fx.ids.project);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.cases).toHaveLength(21);
    expect(nextAction(fx.ids.project, result.data).title).toBe('Review a saved case');
  });
});

describe('exact published comparison evidence', () => {
  it('resolves an older version through bounded history, then fetches only the pinned immutable snapshot', async () => {
    const api = fixtureApi();
    api.suites.versions = vi.fn(async (_project, _suite, window) => ok(window?.offset ? [fx.suiteVersion] : Array.from({ length: 20 }, (_, index) => ({ ...fx.suiteVersion, id: `Fixture newer version ${index}`, version: index + 2 }))));
    api.suites.version = vi.fn(async () => ok(fx.suiteVersion));
    api.discovery.get = vi.fn();
    expect(await loadComparisonSuite(api, fx.ids.project, fx.plan)).toEqual(ok(fx.suiteVersion));
    expect(api.suites.version).toHaveBeenCalledWith(fx.ids.project, fx.ids.suite, fx.ids.suiteVersion);
    expect(api.discovery.get).not.toHaveBeenCalled();
  });
  it('rejects a mismatched published checksum rather than refreshing or substituting evidence', async () => {
    const api = fixtureApi();
    api.suites.version = vi.fn(async () => ok({ ...fx.suiteVersion, checksum: 'Fixture wrong checksum' }));
    const result = await loadComparisonSuite(api, fx.ids.project, fx.plan);
    expect(result).toMatchObject({ ok: false, error: { kind: 'conflict' } });
  });
});

describe('POSIX literal release labels', () => {
  it.each(['Fixture review-$(printf SAFE_MARKER)', 'Fixture `printf SAFE_MARKER`', 'Fixture apostrophe\' and "double quotes"', 'Fixture $HOME \\ backslash', 'Fixture line one\nline two\n', 'Fixture Unicode café'])('preserves exact bytes without shell evaluation: %s', value => {
    const output = execFileSync('/bin/sh', ['-c', `export TASTECASE_ASSISTANT_VERSION=${quotePosix(value)}; printf '%s' "$TASTECASE_ASSISTANT_VERSION"`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', NODE_ENV: 'test' } });
    expect(output).toBe(value);
  });
  it('rejects NUL, which cannot be represented in an environment variable', () => {
    expect(() => quotePosix('Fixture\0label')).toThrow(/NUL/);
  });
});
