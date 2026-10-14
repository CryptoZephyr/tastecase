'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isUncertain, type ApiResult, type UiError } from './result';

export type Resource<T> =
  | { status: 'loading'; data?: undefined; error?: undefined; updatedAt?: undefined; reloading: boolean; stale: false }
  | { status: 'ready'; data: T; error?: UiError; updatedAt: Date; reloading: boolean; stale: boolean }
  | { status: 'error'; data?: undefined; error: UiError; updatedAt?: undefined; reloading: boolean; stale: false };

interface Options<T> {
  /** Poll while this returns true for the last confirmed data. Paused while the tab is hidden. */
  pollWhile?: (data: T) => boolean;
  pollMs?: number;
  enabled?: boolean;
}

const sameIdentity = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
const accessLost = (error: UiError) => ['unauthorized', 'forbidden', 'not_found'].includes(error.kind) || [401, 403, 404].includes(error.status ?? 0);

/** A network refresh may keep marked-stale saved work. Access failures and identity
 * changes discard it, including in the render before effects run. Callers must include
 * their API/session and owner/project/resource identity in deps.
 */
export function useResource<T>(load: () => Promise<ApiResult<T>>, deps: readonly unknown[], options: Options<T> = {}) {
  const { pollWhile, pollMs = 5000, enabled = true } = options;
  const identity = [enabled, ...deps];
  const initial: Resource<T> = { status: 'loading', reloading: enabled, stale: false };
  const [stored, setStored] = useState<{ identity: readonly unknown[]; value: Resource<T> }>({ identity, value: initial });
  const current = useRef({ load, identity, enabled });
  current.current = { load, identity, enabled };
  const generation = useRef(0);

  const run = useCallback(async () => {
    const context = current.current;
    if (!context.enabled) return;
    const id = ++generation.current;
    setStored(previous => ({ identity: context.identity, value: sameIdentity(previous.identity, context.identity)
      ? { ...previous.value, reloading: true, stale: previous.value.status === 'ready' } as Resource<T>
      : { status: 'loading', reloading: true, stale: false } }));
    const result = await context.load();
    if (id !== generation.current || !sameIdentity(context.identity, current.current.identity)) return;
    setStored(previous => {
      if (result.ok) return { identity: context.identity, value: { status: 'ready', data: result.data, updatedAt: new Date(), reloading: false, stale: false } };
      if (!accessLost(result.error) && isUncertain(result.error) && previous.value.status === 'ready') {
        return { identity: context.identity, value: { ...previous.value, error: result.error, reloading: false, stale: true } };
      }
      return { identity: context.identity, value: { status: 'error', error: result.error, reloading: false, stale: false } };
    });
  }, []);

  const invalidate = useCallback(() => { generation.current += 1; }, []);
  useEffect(() => {
    setStored({ identity: current.current.identity, value: { status: 'loading', reloading: enabled, stale: false } });
    if (enabled) void run();
    return invalidate;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callers pass identity inputs explicitly.
  }, [enabled, run, invalidate, ...deps]);

  const state = sameIdentity(stored.identity, identity) ? stored.value : initial;
  const shouldPoll = enabled && state.status === 'ready' && !state.error && Boolean(pollWhile?.(state.data));
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void run(); }, pollMs);
    return () => window.clearInterval(timer);
  }, [shouldPoll, pollMs, run]);

  return { ...state, reload: run, polling: shouldPoll } as Resource<T> & { reload: () => Promise<void>; polling: boolean };
}

/** Parallel resources resolved together for derived views such as the project next step. */
export async function all<T extends readonly unknown[]>(calls: { [K in keyof T]: Promise<ApiResult<T[K]>> }): Promise<ApiResult<T>> {
  const results = await Promise.all(calls);
  // An earlier network error must not mask a concurrent loss of private access.
  const failure = results.find(result => !result.ok && accessLost(result.error)) ?? results.find(result => !result.ok);
  if (failure && !failure.ok) return failure;
  return { ok: true, data: results.map(result => (result as { ok: true; data: unknown }).data) as unknown as T };
}
