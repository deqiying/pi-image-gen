# PI Image Generation

`@deqiying/pi-image-gen` adds one native pi agent tool named `image_gen`. It supports:

- `action: "generate"` for text-to-image requests;
- `action: "edit"` for requests with explicitly selected local PNG, JPEG, or WebP references.

## Transports

The tool prefers the Responses API contract that Codex and other Responses providers speak, and keeps the OpenAI-compatible Images API as its fallback:

1. **Responses (primary)** — `POST <baseUrl>/responses` with `stream: true`, `tool_choice: { "type": "image_generation" }`, and the server-side tool `{ "type": "image_generation", "model": ..., "size": ..., "quality": ..., "output_format": "png" }` declared in `tools[]`. The prompt travels in `input`, references travel as `input_image` data URLs, and the result is read from the streamed `image_generation_call` item. This is the only image surface a ChatGPT/Codex backend exposes.
2. **Images API (fallback)** — `POST <baseUrl>/images/generations`, streamed as SSE for every model except DALL-E, plus multipart `POST <baseUrl>/images/edits`. It is used directly when the provider is not Responses-capable, and as the fallback when a Responses request fails for a capability reason: a missing endpoint (404/405/501), an unparseable response, or a provider that rejects the `image_generation` tool. The fallback is remembered per provider and endpoint, so such a provider is not probed again on every call.

Failures a retry cannot fix are never retried: cancellation, timeout, authentication, rate limit, and oversized responses. Streaming keeps bytes flowing through proxies, which avoids the gateway/CDN timeouts that a single long non-streaming request hits. Both transports request one inline base64 PNG and verify the PNG signature, IHDR dimensions, and IEND chunk before writing the artifact. `image_variation` is intentionally outside the supported tool contract.

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

`userAgent` overrides the `User-Agent` header of image requests. It is never written into the provider's global model configuration. Header values containing CR/LF or forbidden hop-by-hop/auth keys are rejected. When the effective `User-Agent` announces a Codex client (for example `codex_cli_rs/0.153.4 ...`), the plugin derives the matching `originator` and `version` headers from it, because the ChatGPT backend rejects a request whose `originator` and user agent do not match. API keys are never stored by this plugin.

For a host-independent configuration, omit `model`. PI-Desktop then injects the active provider/model binding and resolves its endpoint plus API key or OAuth headers through its model registry; native pi does the same with its own registry. The selected provider must expose either `/responses` with the `image_generation` tool or compatible `/images/generations` and `/images/edits` endpoints. Credentials are never copied into this shared file.

Set `model` only when image requests must use a different configured provider binding from the active conversation. The configured `imageModel` (and `toolModel` on the Responses transport) remain the only image model identifiers sent in requests.

The feature is disabled by default because a successful provider request may incur charges. Set `enabled` to `true` only after verifying the selected provider and image SKU.

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
