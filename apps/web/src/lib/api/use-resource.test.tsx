import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fail, ok, type ApiResult, type UiErrorKind } from './result';
import { all, useResource } from './use-resource';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('private resource refresh lifecycle', () => {
  it.each(['unauthorized', 'forbidden', 'not_found'] as UiErrorKind[])('discards private ready data after %s', async kind => {
    const load = vi.fn().mockResolvedValueOnce(ok('Fixture private record')).mockResolvedValueOnce(fail({ kind }));
    const { result } = renderHook(() => useResource(load, ['Fixture owner']));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(() => result.current.reload());
    expect(result.current.status).toBe('error');
    expect(result.current.data).toBeUndefined();
  });

  it.each([401, 403, 404])('discards private data for HTTP %s even when the error kind is uncertain', async status => {
    const load = vi.fn().mockResolvedValueOnce(ok('Fixture private record')).mockResolvedValueOnce(fail({ kind: 'internal', status }));
    const { result } = renderHook(() => useResource(load, ['Fixture owner']));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(() => result.current.reload());
    expect(result.current.status).toBe('error');
    expect(result.current.data).toBeUndefined();
  });

  it('does not mask an ownership error with an earlier network error in a derived resource', async () => {
    const load = vi.fn().mockResolvedValueOnce(ok('Fixture private derived view')).mockImplementationOnce(() => all([Promise.resolve(fail({ kind: 'network' })), Promise.resolve(fail({ kind: 'forbidden' }))] as const));
    const { result } = renderHook(() => useResource(load, ['Fixture owner']));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(() => result.current.reload());
    expect(result.current).toMatchObject({ status: 'error', error: { kind: 'forbidden' } });
    expect(result.current.data).toBeUndefined();
  });

  it('retains a marked-stale snapshot only for a network refresh and clears it on recovery', async () => {
    const load = vi.fn().mockResolvedValueOnce(ok('Fixture saved record')).mockResolvedValueOnce(fail({ kind: 'network' })).mockResolvedValueOnce(ok('Fixture newer record'));
    const { result } = renderHook(() => useResource(load, ['Fixture owner']));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(() => result.current.reload());
    expect(result.current).toMatchObject({ status: 'ready', data: 'Fixture saved record', stale: true, error: { kind: 'network' } });
    await act(() => result.current.reload());
    expect(result.current).toMatchObject({ status: 'ready', data: 'Fixture newer record', stale: false });
    expect(result.current.error).toBeUndefined();
  });

  it('clears disabled resources and ignores in-flight data and explicit reloads while disabled', async () => {
    const next = deferred<ApiResult<string>>();
    const load = vi.fn().mockResolvedValueOnce(ok('Fixture private')).mockReturnValueOnce(next.promise);
    const { result, rerender } = renderHook(({ enabled }) => useResource(load, ['Fixture owner'], { enabled }), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    let refresh!: Promise<void>;
    act(() => { refresh = result.current.reload(); });
    rerender({ enabled: false });
    expect(result.current).toMatchObject({ status: 'loading', reloading: false });
    expect(result.current.data).toBeUndefined();
    await act(async () => { next.resolve(ok('Fixture late private')); await refresh; await result.current.reload(); });
    expect(result.current.data).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('never renders the previous owner or project data during an identity change', async () => {
    const next = deferred<ApiResult<string>>();
    const load = vi.fn().mockResolvedValueOnce(ok('Fixture owner A private')).mockReturnValueOnce(next.promise);
    const seen: (string | undefined)[] = [];
    const { result, rerender } = renderHook(({ owner }) => {
      const state = useResource<string>(load, [owner]);
      seen.push(state.data);
      return state;
    }, { initialProps: { owner: 'Fixture owner A' } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    seen.length = 0;
    rerender({ owner: 'Fixture owner B' });
    expect(seen.every(value => value === undefined)).toBe(true);
    await act(async () => { next.resolve(ok('Fixture owner B private')); });
    expect(result.current.data).toBe('Fixture owner B private');
  });
});
