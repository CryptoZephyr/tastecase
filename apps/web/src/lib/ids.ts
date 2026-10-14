/** Caller-generated request identity. Keep it stable across retries of an unchanged body. */
export function newId(): string {
  return crypto.randomUUID();
}

export const SCHEMA_VERSION = '1.0.0' as const;
