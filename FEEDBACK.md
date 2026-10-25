# Feedback on Qloo's tools

This comes from building TasteCase on `@qloo/qloo-harness@0.1.26` and the hackathon API at `hackathon.api.qloo.com` in October 2026. Everything below is based on our code, tests and small, bounded live runs. We didn't keep raw API responses.

## What worked well

- The harness lets you inject your own HTTP client through `QlooToolClient`. That let us add a request budget, batching and spacing without forking or patching the package.
- Tool contracts are strict, and results carry provenance (endpoint and parameters), so it was easy to store evidence we could check later.
- `/entities` returns rich, typed tags for places. Our probed restaurants had between 137 and 198 tags each, covering cuisine, genre, category, ambience, culinary style and more.
- `feature.explainability=true` on `/v2/insights` works for places. It returned a 0 to 1 `query.affinity` per result, per-signal scores, and the aggregate effect on the top 3, 5 and 10 results.
- Support in #api-help replied quickly, told us the limit (5 requests per second) and suggested spacing requests at least 200ms apart. That fixed our 429s.

## Friction and suggestions

### 1. Default retries and concurrent lookups make rate limits worse

The bundled `QlooClient` defaults to 3 attempts and treats 429 as retryable. `qloo_rank` also resolves its options and signals concurrently with `Promise.all`. In our tests, a cold ranking of seven restaurants made nine HTTP requests before any retries, which was enough to trip the per-second limit. We replaced the client so a ranking makes two requests: one batched `/entities?entity_ids=` lookup and one `/v2/insights` call.

Suggestion: don't retry 429 by default, and batch ID lookups into a single `/entities` call inside `qloo_rank`.

### 2. It's hard to tell which limit you hit

We didn't find the per-second limit in the developer guide and learned it from support, along with the fact that monthly exhaustion returns a different error. A 429 that says which limit was hit, with a `Retry-After` header, would let clients back off correctly without guessing.

### 3. `X-RateLimit-Remaining-Month` wasn't there

Support suggested checking this header on a successful response. It wasn't present on the successful responses we inspected, and the harness doesn't read it, so we still don't know our monthly allowance. Sending it consistently, or exposing remaining quota through a cheap endpoint, would help teams plan test runs.

### 4. `qloo_rank` can't ask for explainability

The harness keeps `query.explainability` when the API returns it, but `qloo_rank` has no option to set `feature.explainability=true`. We add it in our transport. A tool parameter would make it available to any agent using the MCP server.

### 5. Tags need a custom transport to reach the agent

The place tags we show come from capturing `/entities` responses in our own transport and passing a bounded, allowlisted subset alongside the tool result. If `qloo_rank` returned a short typed tag list per ranked option, agents could explain rankings without extra plumbing.

### 6. Explainability is flat for small profiles

With two interests per fictional guest, the per-interest split was about 51/49 on every restaurant. That's probably correct, but it means explainability says little for small profiles, and the affinity gap between two restaurants was more useful to reviewers. A short guide on reading these scores would help.

### 7. Entity details sometimes lacked a type

Some `/entities` details came back without a type, so we had to bind identity to the resolver's ID, name and type rather than trust the type we asked for. Always including `types` on entity details would make identity checks simpler.
