import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { QlooHttpDiagnosticsSchema } from '@tastecase/contracts';
import { QlooEntityTagsSchema, QLOO_HOST, childEnvironment, type McpSession } from './qloo.js';
import type { ProviderContext } from './types.js';


export async function openOfficialSession(context: ProviderContext): Promise<McpSession> {
  const key = process.env.QLOO_API_KEY;
  if (!key || (process.env.QLOO_BASE_URL && process.env.QLOO_BASE_URL !== QLOO_HOST)) throw new TypeError('Pinned Qloo configuration required');
  const directory = dirname(fileURLToPath(import.meta.resolve('@qloo/qloo-harness')));
  const installed = z.object({ version:z.literal('0.1.26') }).parse(JSON.parse(await readFile(join(directory,'../package.json'),'utf8')));
  if (!installed.version) throw new TypeError('Unverified Qloo harness');
  const home = await mkdtemp(join(tmpdir(),'tastecase-mcp-'));
  const transport = new StdioClientTransport({ command:process.execPath,args:[fileURLToPath(new URL('../dist/qloo-mcp.js',import.meta.url))],
    env:childEnvironment(key,home,DEFAULT_INHERITED_ENV_VARS),cwd:home,stderr:'pipe',maxBufferSize:context.outputBytes + 16384,
  });
  transport.stderr?.on('data', () => { /* Discard provider diagnostics; never log raw stderr. */ });
  const client = new Client({name:'tastecase-discovery',version:'0.1.0'});
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try { await client.close(); } finally { await transport.close(); await rm(home,{recursive:true,force:true}); }
  })();
  const abort = () => { void close().catch(() => {}); };
  context.signal.addEventListener('abort',abort,{once:true});
  try {
    context.signal.throwIfAborted(); await client.connect(transport,{signal:context.signal,timeout:15000});
    context.signal.throwIfAborted();
  } catch { await close(); throw new TypeError('MCP transport unavailable'); }
  return {
    listTools: signal => client.listTools(undefined,{signal,timeout:15000}),
    async callTool(name,args,requestContext) {
      let response: { structuredContent?: unknown; content: { type: string; text?: string | undefined }[]; _meta?: { tastecaseHttp: unknown; tastecaseEntityTags: z.infer<typeof QlooEntityTagsSchema> } | undefined };
      try {
        response = z.object({structuredContent:z.unknown().optional(),content:z.array(z.object({type:z.string(),text:z.string().optional()}).passthrough()),
          _meta:z.strictObject({tastecaseHttp:z.unknown(),tastecaseEntityTags:QlooEntityTagsSchema}).optional()}).parse(
          await client.callTool({name,arguments:args},undefined,{signal:requestContext.signal,timeout:60000}));
      } catch { await close(); throw new Error('MCP dispatch outcome unavailable'); }
      const raw = response.structuredContent ?? (() => {
        const texts = response.content.filter(item => item.type === 'text');
        if (texts.length !== 1 || !texts[0] || texts[0].text === undefined) throw new TypeError('Missing MCP envelope');
        return JSON.parse(texts[0].text) as unknown;
      })();
      // Reject accidental credential echo before normalisation/persistence.
      if (JSON.stringify(raw).includes(key)) throw new TypeError('Unsafe MCP echo');
      const http = QlooHttpDiagnosticsSchema.parse(response._meta?.tastecaseHttp);
      const entityTags = response._meta?.tastecaseEntityTags ?? [];
      return { ...z.record(z.string(),z.unknown()).parse(raw), http, entityTags };
    },
    async close() { context.signal.removeEventListener('abort',abort); await close(); },
  };
}
