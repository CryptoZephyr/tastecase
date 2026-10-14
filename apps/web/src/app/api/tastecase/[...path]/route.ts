import { proxyRequest } from '@/lib/api/proxy';

// Next 16.4 route handlers use Web Request/Response; request access prevents prerendering.
export const runtime = 'nodejs';
export const maxDuration = 25;
function handle(request: Request) {
  return proxyRequest(request, process.env.TASTECASE_API_ORIGIN);
}
export const GET = handle;
export const POST = handle;
