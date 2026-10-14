import type { TasteCaseApi } from './port';
import { unwiredApi } from './unwired';

/**
 * The transport every screen uses through `useApi()`. Backend wiring replaces this export with an
 * HTTP implementation of `TasteCaseApi` (Supabase session + the routes in REST_CONTRACTS).
 * Until then the app reports `not_connected` everywhere rather than showing invented data.
 */
export const defaultApi: TasteCaseApi = unwiredApi;
