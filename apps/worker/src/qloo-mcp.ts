import { pathToFileURL } from 'node:url';
import { createQlooTools, startCanonicalMcpServer, type QlooHarnessToolDefinition } from '@qloo/qloo-harness';
import { QlooHttpDiagnosticsSchema, type QlooHttpDiagnostics } from '@tastecase/contracts';
import { z } from 'zod';
import { BoundedQlooClient } from './qloo-http.js';
import { QLOO_HOST } from './qloo.js';

/** Keep the pinned official tools/server; supply only the bounded transport through their public factory. */
export function boundedMcpOptions(key: string, request: typeof fetch = fetch, writeOut = (value: string) => { process.stdout.write(value); }) {
  const client = new BoundedQlooClient(key, request);
  const receipts = new Map<string, QlooHttpDiagnostics>();
  const tools: QlooHarnessToolDefinition[] = createQlooTools({ client }).filter(tool => ['qloo_rank', 'qloo_describe'].includes(tool.name)).map(tool => ({
    ...tool,
    async execute(id, args, signal, onUpdate, context) {
      const { result, http } = await client.run(tool.name === 'qloo_rank' ? 'rank' : 'describe', childSignal => tool.execute(id, args, childSignal, onUpdate, context), signal);
      receipts.set(id, QlooHttpDiagnosticsSchema.parse(http));
      return result;
    },
  }));
  return { tools, writeOut(value: string) {
    const response = z.object({ id: z.union([z.string(), z.number()]).nullable(), result: z.record(z.string(), z.unknown()).optional() }).passthrough().parse(JSON.parse(value));
    const id = `mcp-${response.id === null ? 'request' : String(response.id)}`;
    const http = receipts.get(id); receipts.delete(id);
    if (http && response.result) response.result._meta = { tastecaseHttp: http };
    writeOut(`${JSON.stringify(response)}\n`);
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.QLOO_API_KEY;
  if (!key || process.env.QLOO_BASE_URL !== QLOO_HOST) throw new TypeError('Pinned Qloo configuration required');
  startCanonicalMcpServer({ ...boundedMcpOptions(key), serverVersion: '0.1.26' });
}
