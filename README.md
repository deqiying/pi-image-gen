# PI Image Generation

`pi-image-gen` adds one native pi agent tool named `image_gen`. It supports:

- `action: "generate"` for text-to-image requests;
- `action: "edit"` for requests with explicitly selected local PNG, JPEG, or WebP references.

The tool sends a Codex Responses-compatible request using the `image_generation` tool. Editing is represented by `action: "edit"` and `input_image` content. `image_variation` is intentionally not implemented because it is not part of the verified Codex contract used here.

## Two hosts, one extension

The same `src/index.ts` module is exposed through:

- PI-Desktop `contributes.agentExtensions`. This is trusted agent-side code and requires the high-risk `agent.extension` grant. Load the repository with **Plugins -> Load development plugin**, then approve that permission.
- Native pi through `package.json`'s `pi.extensions` entry. Install the package or point pi at this directory using the normal pi extension mechanism.

The plugin does not declare a sandboxed `agentTools` contribution. This avoids registering a second copy of the same tool in PI-Desktop.

## Configuration

The default file is:

```text
~/.pi/agent/extensions/pi-image-gen/config.json
```

Example:

```json
{
  "enabled": true,
  "model": "my-codex-gateway/gpt-5.6",
  "imageModel": "image-2",
  "userAgent": "my-image-client/1.0",
  "defaultSize": "1024x1024",
  "defaultQuality": "high"
}
```

`model` is an exact `provider/model-id` key resolved through pi's model registry. It selects the endpoint and credentials for the image request and may differ from the active conversation model. If omitted, the active conversation model is used.

`imageModel` is the bare nested image SKU sent as `tools[0].model`, such as `image-2`. If omitted, the selected routing model id is used. This separation allows a gateway conversation model and an image model to be configured independently.

`userAgent` overrides only the `User-Agent` header of image requests. It is never written into the provider's global model configuration. Header values containing CR/LF or forbidden hop-by-hop/auth keys are rejected. API keys are never stored by this plugin.

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
