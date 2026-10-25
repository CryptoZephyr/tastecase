# Connect an authorized assistant

The runner executes the owner's adapter locally. TasteCase accepts typed results, not uploaded application code or arbitrary target endpoints. By default it uses NVIDIA Nemotron 3.5 Super VL through OpenRouter's free endpoint. The provider key stays on the runner machine.

## API owner setup

Production owner endpoints require a Supabase access token:

```text
Authorization: Bearer <owner access token>
```

Create a project with `POST /projects`, supplying `{ "schema_version": "1.0.0", "name": "My concierge tests" }`. Under `/projects/:projectId`, create `/catalogs` and `/tasks`; these are immutable versions with caller-generated UUIDs. Tasks reference one catalog version. `/mappings` stores explicit owner confirmations separately from candidate IDs on catalog entries.

`POST /projects/:projectId/runner-credentials` takes `{ "schema_version": "1.0.0", "label": "Local runner" }`. It returns the plaintext token once. Save it in the runner's environment. Only its SHA-256 hash is persisted. Listing credentials returns metadata, not the token or hash.

`POST /projects/:projectId/attempts` queues pinned inputs:

```json
{
  "schema_version": "1.0.0",
  "id": "<attempt UUID>",
  "catalogVersionId": "<catalog version UUID>",
  "taskVersionId": "<task version UUID>",
  "mappingConfirmationIds": [],
  "eligibleCatalogEntryIds": ["restaurant-a", "restaurant-b"]
}
```

The IDs must belong to the same owned project. This example shows the shape, not runnable IDs. Full schemas and [route contracts](../packages/contracts/src/rest.ts) are the source of truth. Candidate mappings are not silently confirmed.

## Runner environment

| Variable | Meaning |
|---|---|
| `TASTECASE_API_ORIGIN` | Direct HTTPS API origin, without path/query/credentials |
| `TASTECASE_RUNNER_TOKEN` | Project-scoped token minted by the API |
| `OPENROUTER_API_KEY` | Local provider credential for the default free-only adapter |
| `TASTECASE_MODEL_PROVIDER` | Optional: `openrouter` (default), or explicitly `litellm` for a separately configured provider |
| `TASTECASE_ASSISTANT_VERSION` | Exact local release label required for comparison claims and offline replay |

After building:

```sh
node packages/runner/dist/cli.js --help
node packages/runner/dist/cli.js handshake
node packages/runner/dist/cli.js run-once
```

The default model is pinned to `nvidia/nemotron-3.5-super-vl:free` at `https://openrouter.ai/api/v1/chat/completions`. Requests require JSON, request low-effort hidden reasoning that is excluded from output, and cap output at 4096 tokens. The runner token budget accounts for reasoning. Requests also disable provider fallback and enforce zero prompt/completion/request price ceilings. There is no paid fallback or automatic provider retry. Provider unavailability is visible, not an empty recommendation success. [Free-tier limits](https://openrouter.ai/docs/api/reference/limits) are shared across free models: 20 requests/minute and 50/day for an account with fewer than $10 in purchased credits. Discovery, comparison and replay all consume requests; budget them together. Free availability is not guaranteed.

Baseline and Candidate can use this same model with different locally configured prompts or settings. The release label only attests that configuration; changing the label alone does not change the prompt. Custom adapters stay local.

The old OpenAI-compatible adapter remains available only by explicitly setting `TASTECASE_MODEL_PROVIDER=litellm`, plus `LITELLM_API_KEY`, `LITELLM_BASE_URL` and optionally `LITELLM_MODEL` (legacy default `nova-micro`). Those settings are ignored by the default OpenRouter adapter. They are not a fallback, and any billing on an explicitly configured legacy provider is the runner owner's responsibility.

For a loopback development API, add `--allow-loopback-http`. External HTTP and all redirects are rejected. Never pass tokens or keys as CLI arguments. Handshake needs no provider key and makes no target call.

`run-once` handshakes, claims at most one attempt, invokes the local adapter once and uploads the result with the same attempt/lease identity. A 204 claim means no work. There is no background daemon or blind target-call retry.

For comparison work, configure the intended adapter and bind its exact release label. Unbound or wrong-label runners cannot claim those slots; the label does not select a model automatically. The [comparison/replay guide](comparison.md) documents private pack/report exports and `replay --pack LOCAL.json --role candidate --pack-checksum SHA256 --report NEW.json`. Offline replay needs local provider configuration but no API/owner/runner credentials, and runs only the selected role.

## Adapter interface

Implement `TargetAdapter` from `@tastecase/contracts` in trusted local runner code:

```ts
interface TargetAdapter {
  readonly name: string;
  readonly version: string;
  run(input: TargetInput, context: { signal: AbortSignal }): Promise<TargetResult>;
}
```

`TargetInput` contains resolved immutable catalog/task versions, explicit synthetic inputs, confirmed mappings and eligible catalog IDs. Its checksums and project boundaries are validated before execution. Custom adapters are selected by the runner owner, not by server-delivered source code.

Results separate:
- `success`: actual structured target output, including outside-catalog or name-only recommendations for later objective checks.
- `malformed_output`: bounded, redacted invalid target output.
- `provider_unavailable`: no usable provider response, with a safe error and retryability flag.

Every result has normalized trace completeness: `complete`, `partial` or `unavailable`. The sample records only observed start/end metadata and labels its trace partial. It does not claim to see model internals or unseen tool calls. Token usage is available through the sample adapter's local `runWithUsage`; this initial persisted result schema does not yet carry usage counters.

## Recovery and revocation

Claims are atomic and leased for 30–900 seconds. Expired work can be reclaimed with a new lease ID; stale uploads fail. Revocation is checked before handshake, claim and upload, including duplicate uploads.

Identical result uploads are idempotent using canonical JSON checksums. Different content for a completed attempt is a conflict. An ambiguous upload leaves `pendingUpload` in the exported runtime for an identical explicit retry; the CLI does not durably save that payload. Do not rerun the target simply to retry an upload.

## Database and hosted limits

The API uses a privileged database connection with explicit owner/project checks. Authenticated database roles have forced row-level owner isolation and cannot read runner token hashes. Apply migrations with a role able to create the tables/functions and grant the documented roles. Use a dedicated Supabase project for hosted work.

The local auth bootstrap is restricted to loopback `tastecase_test` and refuses an existing Supabase auth database. Hosted login, owner isolation, runner project scope and private object read/write denial were verified with two synthetic accounts and a loopback API against a dedicated Supabase project. The temporary accounts and object were removed; labeled immutable test records remain isolated. Use verified TLS with Supabase's CA for the session-pooler database connection, as documented in the [root setup](../README.md#local-setup). Other MIME/size-limit behavior, signed URLs and cloud deployment have not been verified.
