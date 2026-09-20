# PI Image Generation

`@deqiying/pi-image-gen` adds one native pi agent tool named `image_gen`. It supports:

- `action: "generate"` for text-to-image requests;
- `action: "edit"` for requests with explicitly selected local PNG, JPEG, or WebP references.

The tool calls an OpenAI-compatible Images API directly: `action: "generate"` uses `POST /images/generations`, while `action: "edit"` uploads explicitly approved local references with multipart `POST /images/edits`. Both operations request one inline base64 PNG. `image_variation` is intentionally outside the supported tool contract.

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
  "imageModel": "image-2",
  "defaultSize": "1024x1024",
  "defaultQuality": "high"
}
```

`model` is an optional exact `provider/model-id` binding resolved through the current host's model registry. It is used only to select the provider endpoint and credentials; it is never sent to the Images API. If omitted, the active session's provider binding is used.

`imageModel` is required and is sent directly as the Images API `model`, such as `gpt-image-1.5` or a gateway-specific `image-2` SKU.

`userAgent` overrides only the `User-Agent` header of image requests. It is never written into the provider's global model configuration. Header values containing CR/LF or forbidden hop-by-hop/auth keys are rejected. API keys are never stored by this plugin.

For a host-independent configuration, omit `model`. PI-Desktop then injects the active provider/model binding and resolves its endpoint plus API key or OAuth headers through its model registry; native pi does the same with its own registry. The selected provider base URL must expose compatible `/images/generations` and `/images/edits` endpoints. Credentials are never copied into this shared file.

Set `model` only when image requests must use a different configured provider binding from the active conversation. The configured `imageModel` remains the only model identifier sent in generation and edit requests.

The feature is disabled by default because a successful provider request may incur charges. Set `enabled` to `true` only after verifying the selected provider and image SKU.

## Files and privacy

Generated images are written as unique PNG artifacts under the pi agent artifact directory, in `generated-images/<session>/<tool-call>.png`. An explicit `outputPath` must end in `.png`; paths outside the agent/project roots require interactive confirmation and are never overwritten.

Reference images are read only from paths explicitly supplied by the agent on the user's behalf. Each upload is confirmed in interactive sessions. The limits are five files, 20 MiB per file, and 50 MiB total. Reference bytes, response base64, and credentials are not logged. Buffers are cleared after the request finishes.

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
