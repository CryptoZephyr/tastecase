import { SCHEMA_VERSION, type ApiError } from '@tastecase/contracts';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: ApiError['error']['code'], message: string) {
    super(message);
  }
}

/** Only fixed, safe messages are exposed; SQL and provider error bodies stay private. */
export function safeError(error: unknown): { status: number; body: ApiError } {
  let failure = error instanceof HttpError ? error : new HttpError(500, 'internal_error', 'The request could not be completed.');
  if (!(error instanceof HttpError) && typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === 'FST_ERR_HANDLER_TIMEOUT') failure = new HttpError(503, 'internal_error', 'The request exceeded the time limit.');
    if (error.code === '23505') failure = new HttpError(409, 'conflict', 'The immutable record already exists with different content.');
    if (error.code === '23503') failure = new HttpError(404, 'not_found', 'A referenced resource was not found in this project.');
    if (error.code === '23514' || error.code === '22P02') failure = new HttpError(400, 'invalid_request', 'The request violates a data constraint.');
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') failure = new HttpError(413, 'invalid_request', 'The request body exceeds the size limit.');
    if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') failure = new HttpError(415, 'invalid_request', 'Use an application/json request body.');
    if (error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') failure = new HttpError(400, 'invalid_request', 'The request body must be valid JSON.');
  }
  if (!(error instanceof HttpError) && error instanceof SyntaxError) failure = new HttpError(400, 'invalid_request', 'The request body must be valid JSON.');
  return { status: failure.status, body: { schema_version: SCHEMA_VERSION, error: { code: failure.code, message: failure.message } } };
}

export interface RequestSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown };
}

export function parseRequest<T>(schema: RequestSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'invalid_request', 'The request must match the supported schema and contain only allowed fields.');
  return parsed.data;
}
