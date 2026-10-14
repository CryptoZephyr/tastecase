'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { TasteCaseApi } from './port';
import { defaultApi } from './transport';

const ApiContext = createContext<TasteCaseApi>(defaultApi);

/** Tests and development fixture screens pass an explicit `api`; production uses `defaultApi`. */
export function ApiProvider({ api, children }: { api?: TasteCaseApi; children: ReactNode }) {
  return <ApiContext.Provider value={api ?? defaultApi}>{children}</ApiContext.Provider>;
}

export function useApi(): TasteCaseApi {
  return useContext(ApiContext);
}
