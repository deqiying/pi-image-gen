# PI Image Generation

`@deqiying/pi-image-gen` adds one native pi agent tool named `image_gen`. It supports:

- `action: "generate"` for text-to-image requests;
- `action: "edit"` for requests with explicitly selected local PNG, JPEG, or WebP references.

## Transports

The tool prefers the Responses API contract that Codex and other Responses providers speak, and keeps the OpenAI-compatible Images API as its fallback:

1. **Responses (primary)** — `POST <baseUrl>/responses` with `stream: true` (set `stream` to `false` to wait for a single JSON response instead), `parallel_tool_calls: false`, `tool_choice: { "type": "image_generation" }`, and the server-side tool `{ "type": "image_generation", "model": ..., "size": ..., "quality": ..., "output_format": "png", "partial_images": ... }` declared in `tools[]`. The prompt travels in `input`, references travel as `input_image` data URLs with `detail: "auto"`, and the result is read from the streamed `image_generation_call` item. `partial_images` is the `partialImages` configuration key; it makes the provider emit preview frames so a long generation does not look idle to an intermediate proxy. This is the only image surface a ChatGPT/Codex backend exposes.
2. **Images API (fallback)** — `POST <baseUrl>/images/generations`, streamed as SSE for every model except DALL-E, plus multipart `POST <baseUrl>/images/edits`. It is used directly when the provider is not Responses-capable, and as the fallback when a Responses request fails for a capability reason: a missing endpoint (404/405/501) or a provider that rejects the `image_generation` tool. A response the provider already fulfilled is never retried on another endpoint, so an unparseable body and a stream cut short by an intermediate hop do not trigger the fallback. The fallback is remembered per provider and endpoint, so such a provider is not probed again on every call.

Failures a retry cannot fix are never retried: cancellation, timeout, authentication, rate limit, and oversized responses. Transport-level failures are not retried by default either, because a gateway may already have completed and billed the generation, which makes a retry a duplicate charge; set `retryOnTransportFailure` to `true` to opt in. Streaming keeps bytes flowing through proxies, which avoids the gateway/CDN timeouts that a single long non-streaming request hits. Both transports request one inline base64 PNG and verify the PNG signature, IHDR dimensions, and IEND chunk before writing the artifact. `image_variation` is intentionally outside the supported tool contract.

## Install

Native pi:

```bash
pi install npm:@deqiying/pi-image-gen
```

The npm package ships the extension source under `src/` and declares it through `pi.extensions`, so pi loads it with its own TypeScript loader: no build step and no runtime dependency to install.

For the PI-Desktop plugin path, see [Two hosts, one extension](#two-hosts-one-extension).

## Two hosts, one extension

The same `src/index.ts` module is exposed through:

- PI-Desktop `contributes.agentExtensions`. This is trusted agent-side code and requires the high-risk `agent.extension` grant. Load the repository with **Plugins -> Load development plugin**, then approve that permission.
- Native pi through `package.json`'s `pi.extensions` entry. Install the package or point pi at this directory using the normal pi extension mechanism.

The plugin does not declare a sandboxed `agentTools` contribution. This avoids registering a second copy of the same tool in PI-Desktop.

## Configuration

The shared configuration file for both native pi and PI-Desktop is:

```text
~/.config/pi-image-gen/config.json
```

On Windows, this resolves to `C:\Users\<username>\.config\pi-image-gen\config.json`. Existing installations still fall back to the legacy `~/.pi/agent/extensions/pi-image-gen/config.json` path when the shared file does not exist. The shared path takes precedence when both files exist.

Example:

```json
{
  "enabled": true,
  "imageModel": "gpt-image-2",
  "transport": "auto",
  "defaultSize": "1024x1024",
  "defaultQuality": "high"
}
```

`model` is an optional exact `provider/model-id` binding resolved through the current host's model registry. It is used only to select the provider endpoint and credentials; it is never sent as the image model. If omitted, the active session's provider binding is used.

`imageModel` is required and is the default image model for both transports: the `model` of the Responses `image_generation` tool, and the request `model` of the Images API. Examples are `gpt-image-2`, `gpt-image-1.5`, or a gateway-specific `image-2` SKU.

`textModel` and `toolModel` override the two model roles of the Responses transport:

```json
{
  "enabled": true,
  "imageModel": "gpt-image-2",
  "textModel": "gpt-5.4",
  "toolModel": "gpt-image-1.5"
}
```

- `textModel` is the top-level Responses `model` that hosts the built-in image tool. It must be a Responses-capable text model: OpenAI-compatible gateways reject a body whose top-level model is an image SKU (`gpt-image-2`) while it declares `image_generation`. Defaults to the bound `model`, or to the active session model when `model` is unset.
- `toolModel` is the image model declared by the tool itself (`tools[0].model`). `tool_choice` has no model field — it only selects the built-in tool (`{ "type": "image_generation" }`) — so this is the only place the image model is expressed on the Responses transport. Defaults to `imageModel`.
- Both keys affect the Responses transport only; the Images API and its capability fallback always send `imageModel`. A `toolModel` set to a DALL-E SKU can never be used as the tool and is ignored, so the Images request keeps sending `imageModel`.

`transport` selects the request contract:

- `auto` (default) uses Responses for providers whose API id is `openai-responses` or `openai-codex-responses`, and the Images API for every other provider.
- `responses` forces Responses with the Images API still available as a capability fallback.
- `images` keeps the previous Images API behavior only.

The Responses endpoint is resolved from the provider base URL: a ChatGPT/Codex backend (`.../backend-api`, optionally `/codex`) gets `/codex/responses`, while an OpenAI-compatible gateway that advertises a versioned base URL (`.../v1`) is used directly as `<baseUrl>/responses`. The plugin does not probe alternative codex routes, so such a gateway never pays for a doomed request.

`partialImages` requests partial previews while the image is being generated: `tools[0].partial_images` on the Responses transport and `partial_images` on the streamed `/images/generations` request. It accepts `0` to `3` and defaults to `1`: `0` disables previews, and `1`-`3` is the maximum number of previews requested. An intermediate layer that receives no downstream byte for most of a slow generation is exactly what an idle read timeout cuts off, so preview events keep the stream moving and avoid that class of failure. Previews serve keep-alive and progress only and are never part of result parsing — the final image still comes solely from the provider's result payload. Exact `dall-e-2`/`dall-e-3` requests omit the parameter because those models answer with one non-streaming JSON body.

`stream` defaults to `true` and uses `stream: true` plus SSE. With `false`, the Responses request sends `stream: false` and waits for a single JSON response, and the Images `/images/generations` request omits `stream: true` too (`/images/edits` is always multipart). Trade-off: a non-streaming request is completely silent for the whole generation and is therefore cut off more easily by an idle reverse proxy, but it is useful for telling an overall request duration limit apart from an idle limit. Response parsing accepts both shapes, so a gateway that ignores `stream: false` and streams anyway still parses.

`retryOnTransportFailure` defaults to `false` and controls whether one automatic retry is attempted after a transport-level failure. It is off by default because the gateway may already have finished the generation and billed the upstream provider, which makes the retry a duplicate charge, and because a retry made while the upstream generation is still running tends to hit the same problem. Only transport-level failures qualify: an interrupted connection, a response with no provider verdict, or a response stream that ends before a final result. Authentication, rate limits, parameter rejections, cancellation, the plugin's own timeout, and oversized responses are never retried.

`debug` defaults to `false` and, when enabled, appends one JSONL line of request metadata per generation to `<pi agent dir>/pi-image-gen-debug.jsonl` (`~/.pi/agent/pi-image-gen-debug.jsonl`). A record holds the transport, whether the request streamed, the endpoint, provider, model roles, action/size/quality, the number of partial previews requested, the reference image count, the result status and failure reason, the HTTP status, the total / response-header / first-event / last-event durations, the silence before the end, the longest silence of the whole request (the headroom against an idle timeout), received bytes, the event count, the preview event count, whether the plugin timeout ended the request, and whether the caller cancelled it. The request payload is never recorded: no prompt, no reference or response image data, no base64, no credentials. A failure record does carry the provider's own error text (credential- and base64-redacted), which a provider may derive from the prompt.

The network-facing and diagnostic keys:

```json
{
  "enabled": true,
  "imageModel": "gpt-image-2",
  "transport": "auto",
  "partialImages": 1,
  "stream": true,
  "retryOnTransportFailure": false,
  "debug": false
}
```

`userAgent` overrides the `User-Agent` header of image requests. It is never written into the provider's global model configuration. Header values containing CR/LF or forbidden hop-by-hop/auth keys are rejected. When the effective `User-Agent` announces a Codex client (for example `codex_cli_rs/0.153.4 ...`), the plugin derives the matching `originator` and `version` headers from it, because the ChatGPT backend rejects a request whose `originator` and user agent do not match. API keys are never stored by this plugin.

For a host-independent configuration, omit `model`. PI-Desktop then injects the active provider/model binding and resolves its endpoint plus API key or OAuth headers through its model registry; native pi does the same with its own registry. The selected provider must expose either `/responses` with the `image_generation` tool or compatible `/images/generations` and `/images/edits` endpoints. Credentials are never copied into this shared file.

Set `model` only when image requests must use a different configured provider binding from the active conversation. The configured `imageModel` (and `toolModel` on the Responses transport) remain the only image model identifiers sent in requests.

The feature is disabled by default because a successful provider request may incur charges. Set `enabled` to `true` only after verifying the selected provider and image SKU.

## Long generations and network middle layers

An image generation commonly runs for 30 seconds to several minutes. Any HTTP reverse proxy or CDN in between that enforces an idle read timeout — openresty/nginx `proxy_read_timeout` defaults to 60s and is frequently configured down to 30s — silently closes the client connection once no downstream byte has arrived for that long. The upstream generation still completes and is billed, but the client only sees the connection end and never receives the result. This is a different limit from the total request deadline, which is usually far more generous.

The plugin handles this in three ways. Partial previews are on by default (`partialImages: 1`), so a long silent stretch still has SSE events flowing through the proxy. Failed requests carry a full diagnostic suffix (below). And a transport-level failure neither retries nor triggers the Images fallback by default, so a generation the gateway already billed is not charged a second time.

A failure message is the base reason plus a bracketed diagnostic suffix holding the transport and whether the request streamed, the total elapsed time, the response header time, the first event time, event and preview event counts, received bytes, the silence before the end, and what ended it (provider, plugin timeout, or caller cancellation). For example: `Image provider stream ended without an image result [streamed responses transport, 44.1s elapsed, headers 0.4s, first event 1.2s, 12 event(s), 1 partial preview(s), 2.1 MiB received, silent for 10.0s before ending, ended by provider]`. When that final silence is around 25 seconds or more and the plugin timeout did not end the request, the plugin appends an actionable hint naming a suspected middle-layer idle timeout and suggesting `transport: "images"` or a review of the reverse proxy timeout configuration.

To narrow the cause down:

- Read the failure message first: a long silence points at an idle timeout, while a total duration close to some limit points at a request deadline.
- Set `stream` to `false` and reproduce once to compare the two request shapes.
- If the connection is still cut, raise `partialImages` to `2` or `3`, or set `transport` to `images` (the Images API SSE sends keepalive comment frames) as a comparison.
- Confirm what the upstream provider actually billed before enabling `retryOnTransportFailure`.

A truncation — a connection that ends before the final result arrives — never triggers the Images fallback, because it is not a capability problem. The fallback runs only for 404/405/501, a provider that explicitly rejects the `image_generation` tool, or a provider that ends the turn normally without an image result. A `response.incomplete` turn (for example `max_output_tokens`) counts as such a normal end, so it is reported as a rejection instead of a cut connection and is never retried.

Measured behaviour: with `partialImages: 1` against a multi-model Responses gateway, one generation took 27.7s, the provider sent **three** preview frames (at 3.7s, 3.7s and 16.2s), and the stream was silent for only 2ms before the final result. A provider may send more preview frames than requested, which only helps keep the connection active.

The plugin's own request timeout is `IMAGE_TIMEOUT_MS`, 5 minutes (the constant in `src/image-generation/types.ts`); a request the plugin ends shows as "ended by plugin timeout" in the diagnostic suffix.

## Files and privacy

Generated images are written as unique PNG artifacts under the pi agent artifact directory, in `generated-images/<session>/<tool-call>.png`. An explicit `outputPath` must end in `.png`; paths outside the agent/project roots require interactive confirmation and are never overwritten.

Reference images are read only from paths explicitly supplied by the agent on the user's behalf. Each upload is confirmed in interactive sessions. The limits are five files, 20 MiB per file, and 50 MiB total. Reference bytes, response base64, and credentials are not logged. Buffers are cleared after the request finishes, and streamed responses are bounded by the same byte budget as non-streamed ones.

## Development

```bash
npm install
npm run check
```

The PI-Desktop devkit can validate and package the plugin from the PI-Desktop checkout:

```bash
pnpm --dir E:/Projects/OpenSource/PI-Desktop pi-plugin check E:/Projects/TypeScript/pi-image-gen
pnpm --dir E:/Projects/OpenSource/PI-Desktop pi-plugin pack E:/Projects/TypeScript/pi-image-gen --out E:/Projects/TypeScript/pi-image-gen/dist
```
