import { z } from 'zod';
import { ComputedDiscoveryFactsSchema, IdSchema, validateModelContrastDecision, type ComputedDiscoveryFacts } from '@tastecase/contracts';
import type { DecisionAdapter, ProviderContext } from './types.js';
import { UnknownDispatch } from './types.js';

const selectedIdSchema = z.strictObject({ selectedContrastId:IdSchema.nullable() });
const responseSchema = z.object({ choices:z.array(z.object({ message:z.object({
  content:z.string(),tool_calls:z.array(z.unknown()).max(0).optional(),refusal:z.null().optional(),
}).passthrough() }).passthrough()).length(1) }).passthrough();

/** IDs only. No model-authored ranking, classification, claim or rationale is persisted. */
export function parseSelection(value: unknown, facts: ComputedDiscoveryFacts) {
  const selection = selectedIdSchema.parse(value);
  return validateModelContrastDecision({kind:'model_decision',selectedContrastId:selection.selectedContrastId,
    rationale:selection.selectedContrastId === null ? 'No supported contrast selected for human investigation.' : 'Selected an observed within-query order reversal for human investigation; this is advisory, not a correctness verdict.',
  },ComputedDiscoveryFactsSchema.parse(facts));
}

export async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new TypeError('Provider body unavailable');
  let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new TypeError('Provider output exceeds budget'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export class OpenRouterDecisionAdapter implements DecisionAdapter {
  readonly #key: string;
  constructor(key: string, private readonly request: typeof fetch = fetch) {
    if (!key || /[\s\u0000-\u001f\u007f]/.test(key)) throw new TypeError('Backend OpenRouter credential required');
    this.#key = key;
  }
  async select(facts: ComputedDiscoveryFacts, context: ProviderContext) {
    context.signal.throwIfAborted();
    const verified = ComputedDiscoveryFactsSchema.parse(facts);
    const response = await this.request('https://openrouter.ai/api/v1/chat/completions',{
      method:'POST',redirect:'error',headers:{Authorization:`Bearer ${this.#key}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:'nvidia/nemotron-3-super-120b-a12b:free',temperature:0,max_tokens:512,
        provider:{allow_fallbacks:false,require_parameters:true,max_price:{prompt:0,completion:0,request:0}},
        reasoning:{enabled:false,exclude:true},
        messages:[{role:'system',content:'Choose one id from the supplied, software-verified contrasts to investigate. Prefer an observed order reversal when one is available; selecting it does not mean the assistant failed. Use null if no supported contrast is worth investigating. Reply ONLY with valid JSON exactly in this format: {"selectedContrastId":"a listed id"} or {"selectedContrastId":null}. Do not explain the choice. This selects an advisory synthetic investigation, not a correctness verdict.'},
          {role:'user',content:JSON.stringify(verified)}],
        response_format:{type:'json_object'},
      }),signal:AbortSignal.any([context.signal,AbortSignal.timeout(60000)]),
    }).catch(()=>{ throw new UnknownDispatch(); });
    // Gateway HTTP flags are not official retryable Qloo envelopes. Never retry them automatically.
    if (!response.ok) { await response.body?.cancel(); throw new TypeError(response.status === 401 || response.status === 403 ? 'MODEL_AUTH' : 'MODEL_UNAVAILABLE'); }
    if (response.redirected) { await response.body?.cancel(); throw new TypeError('MODEL_UNAVAILABLE'); }
    try {
      const result = responseSchema.parse(await boundedJson(response,context.outputBytes));
      const message = result.choices[0]?.message;
      if (!message || message.content.includes(this.#key)) throw new TypeError('Unsafe or missing model selection');
      return parseSelection(JSON.parse(message.content) as unknown,verified);
    } catch { throw new TypeError('Invalid model selection'); }
  }
}
