import type { TasteCaseApi } from './port';
import { browserAuth } from './auth';
import { createHttpApi } from './http';

/** Real same-origin owner transport; the recorded public sample never depends on authentication. */
export const defaultApi: TasteCaseApi = createHttpApi(browserAuth);
