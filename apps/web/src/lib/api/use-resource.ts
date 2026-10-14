'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResult, UiError } from './result';

export type Resource<T> =
  | { status: 'loading'; data?: undefined; error?: undefined; updatedAt?: undefined; reloading: true }
  | { status: 'ready'; data: T; error?: UiError; updatedAt: Date; reloading: boolean }
  | { status: 'error'; data?: undefined; error: UiError; updatedAt?: undefined; reloading: boolean };

interface Options<T> {
  /** Poll while this returns true for the last confirmed data. Paused while the tab is hidden. */
  pollWhile?: (data: T) => boolean;
  pollMs?: number;
  enabled?: boolean;
}

/**
 * Loads one API resource. A failed refresh keeps the last confirmed data and exposes the
 * error separately, so a network blip never replaces saved work with an empty or zero state.
 */
export function useResource<T>(load: () => Promise<ApiResult<T>>, deps: readonly unknown[], options: Options<T> = {}) {
  const { pollWhile, pollMs = 5000, enabled = true } = options;
  const [state, setState] = useState<Resource<T>>({ status: 'loading', reloading: true });
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);

  const run = useCallback(async () => {
    const id = ++generation.current;
    setState(previous => (previous.status === 'loading' ? previous : { ...previous, reloading: true }) as Resource<T>);
    const result = await loadRef.current();
    if (id !== generation.current) return;
    setState(previous => {
      if (result.ok) return { status: 'ready', data: result.data, updatedAt: new Date(), reloading: false };
      if (previous.status === 'ready') return { ...previous, error: result.error, reloading: false };
      return { status: 'error', error: result.error, reloading: false };
    });
  }, []);

  // Invalidates in-flight responses so a stale request can never overwrite newer state.
  const invalidate = useCallback(() => { generation.current += 1; }, []);

  useEffect(() => {
    if (!enabled) return;
    setState({ status: 'loading', reloading: true });
    void run();
    return invalidate;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callers pass the identity inputs explicitly.
  }, [enabled, run, invalidate, ...deps]);

  const data = state.status === 'ready' ? state.data : undefined;
  const shouldPoll = data !== undefined && pollWhile ? pollWhile(data) : false;
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
  const failure = results.find(result => !result.ok);
  if (failure && !failure.ok) return failure;
  return { ok: true, data: results.map(result => (result as { ok: true; data: unknown }).data) as unknown as T };
}
