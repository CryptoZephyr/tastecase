import type { ApiResult } from '@/lib/api/result';
import type { ListWindow } from '@/lib/api/types';

/** Read every bounded owner window. Never return a partial history as a complete list.
 * The API caps windows at 20 and offsets at 10000. A failure on any page fails the
 * whole read; useResource can retain an explicitly stale prior complete snapshot.
 */
export async function loadOwnerHistory<T>(page: (window: ListWindow) => Promise<ApiResult<T[]>>): Promise<ApiResult<T[]>> {
  const rows: T[] = [];
  for (let offset = 0; offset <= 10000; offset += 20) {
    const result = await page({ limit: 20, offset });
    if (!result.ok) return result;
    if (result.data.length > 20) return { ok: false, error: { kind: 'internal', message: 'The service returned an invalid history window.' } };
    rows.push(...result.data);
    if (result.data.length < 20) return { ok: true, data: rows };
  }
  return { ok: false, error: { kind: 'too_large', message: 'History exceeds the service’s bounded paging limit; a complete list is unavailable.' } };
}
