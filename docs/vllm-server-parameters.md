# vLLM Server Start Parameters (Tool Calling, Images & Audio)

This guide explains the **vLLM server start parameters** that most often cause support
requests when running models behind iHub Apps. If tool/function calling, image input, or
audio input "does not work" with a vLLM-served model, the cause is almost always a missing
or mismatched start flag on the vLLM side — **not** the iHub configuration.

> **TL;DR** — vLLM only enables these capabilities when you start it with the right flags.
> iHub talks to vLLM through the standard OpenAI-compatible API, so it can only use what the
> server was started with. Match the model config flags in iHub (`supportsTools`,
> `supportsImages` / `supportsVision`, `supportsAudio`) to the vLLM start parameters below.

**Official vLLM documentation (always check for the parameters that match your version):**

- Server / CLI reference: <https://docs.vllm.ai/en/latest/configuration/engine_args.html>
- `vllm serve` arguments: <https://docs.vllm.ai/en/latest/cli/serve.html>
- Tool / function calling: <https://docs.vllm.ai/en/latest/features/tool_calling.html>
- Multimodal inputs (image / video / audio): <https://docs.vllm.ai/en/latest/features/multimodal_inputs.html>
- Supported models (check per-model capabilities): <https://docs.vllm.ai/en/latest/models/supported_models.html>

> vLLM parameter names occasionally change between releases. The flags below reflect recent
> vLLM versions. Always cross-check against the docs for **your** installed version
> (`vllm --version`).

---

## How iHub Apps maps to vLLM

iHub Apps connects to vLLM using the OpenAI-compatible endpoint
(`http://<host>:8000/v1/chat/completions`) with `"provider": "openai"` (or the dedicated
`"provider": "local"` for reasoning models). The capability flags in the model config are
**hints to iHub's UI and request builder** — they tell iHub it is allowed to send tools,
images, or audio. They do **not** configure vLLM. Both sides must agree:

| Capability        | iHub model config flag          | vLLM start parameter(s)                                  |
| ----------------- | ------------------------------- | -------------------------------------------------------- |
| Tool calling      | `"supportsTools": true`         | `--enable-auto-tool-choice` + `--tool-call-parser <p>`   |
| Image / vision    | `"supportsImages": true` and/or `"supportsVision": true` | `--limit-mm-per-prompt '{"image": N}'` (multimodal model) |
| Audio input       | `"supportsAudio": true`         | `--limit-mm-per-prompt '{"audio": N}'` (audio-capable model) |
| Reasoning/thinking | `"thinking": { "enabled": true }` | `--reasoning-parser <p>` (see local-llm-providers.md)   |

**Common failure mode:** the iHub model has `"supportsTools": true` (so the UI offers tools),
but vLLM was started **without** `--enable-auto-tool-choice`. vLLM then ignores the `tools`
field or errors, and the user reports "tool calling does not work." Fixing this is a vLLM
restart with the correct flags — see below.

How iHub sends each modality over the OpenAI-compatible API:

- **Images** → OpenAI `image_url` content parts (base64 data URLs).
- **Audio** → OpenAI `input_audio` content parts (`{ data: <base64>, format: "wav"|"mp3"|... }`).
- **Tools** → standard OpenAI `tools` array with `tool_choice: "auto"`.

---

## 1. Tool / Function Calling

### Required start parameters

```bash
--enable-auto-tool-choice          # REQUIRED: turns on automatic tool selection
--tool-call-parser <parser>        # REQUIRED: must match the model family
--chat-template <path>             # Recommended for some models (handles tool-role messages)
```

`--enable-auto-tool-choice` is mandatory, and it **must** be paired with a
`--tool-call-parser` that matches the model you are serving. Picking the wrong parser is the
second most common cause of broken tool calling — vLLM will start fine but fail to parse the
model's tool-call output.

### Choosing the right `--tool-call-parser`

| Model family                         | `--tool-call-parser` value |
| ------------------------------------ | -------------------------- |
| Nous Hermes models                   | `hermes`                   |
| Mistral / Mixtral                    | `mistral`                  |
| Llama 3.1 / 3.2                      | `llama3_json`              |
| Llama 4                              | `llama4_pythonic`          |
| IBM Granite (3.x / 4)                | `granite`, `granite4`, `granite-20b-fc` |
| Qwen3-Coder                          | `qwen3_xml`                |
| DeepSeek V3 / V3.1                   | `deepseek_v3`, `deepseek_v31` |
| InternLM                             | `internlm`                 |
| AI21 Jamba                           | `jamba`                    |
| Salesforce xLAM                      | `xlam`                     |
| GLM 4.5 / 4.7                        | `glm45`, `glm47`           |
| Kimi K2                              | `kimi_k2`                  |
| Generic Python-list-format models    | `pythonic`                 |

> The list of parsers grows with each vLLM release (e.g. `olmo3`, `cohere_command3`,
> `hunyuan_a13b`, `minimax`, `openai`, …). Run `vllm serve --help | grep -A3 tool-call-parser`
> or check the [tool calling docs](https://docs.vllm.ai/en/latest/features/tool_calling.html)
> for the parsers available in your version. If your model isn't listed, use
> `--tool-parser-plugin` to register a custom parser.

### Example: Llama 3.1 with tool calling

```bash
vllm serve meta-llama/Llama-3.1-8B-Instruct \
    --served-model-name llama-3.1-8b \
    --host 0.0.0.0 --port 8000 \
    --enable-auto-tool-choice \
    --tool-call-parser llama3_json \
    --chat-template examples/tool_chat_template_llama3.1_json.jinja
```

### Example: Mistral with tool calling

```bash
vllm serve mistralai/Mistral-Small-Instruct-2409 \
    --served-model-name mistral-small \
    --host 0.0.0.0 --port 8000 \
    --enable-auto-tool-choice \
    --tool-call-parser mistral
```

### Matching iHub model config

```json
{
  "id": "vllm-llama-3-1",
  "modelId": "llama-3.1-8b",
  "name": { "en": "Llama 3.1 8B (vLLM)" },
  "description": { "en": "Llama 3.1 with tool calling via vLLM" },
  "url": "http://localhost:8000/v1/chat/completions",
  "provider": "openai",
  "contextWindow": 32768,
  "maxOutputTokens": 4096,
  "supportsTools": true,
  "enabled": true
}
```

### Verify tool calling works

```bash
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3.1-8b",
    "messages": [{"role": "user", "content": "What is the weather in Paris?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city",
        "parameters": {
          "type": "object",
          "properties": { "city": { "type": "string" } },
          "required": ["city"]
        }
      }
    }],
    "tool_choice": "auto"
  }'
```

A working setup returns a response containing a `tool_calls` array. If you instead get the
model answering in plain text (ignoring the tool) or an error about tool choice, vLLM was
started without `--enable-auto-tool-choice` or with the wrong `--tool-call-parser`.

---

## 2. Image / Vision Input

### Required start parameters

Vision requires a **multimodal (vision-capable) model**. A text-only model cannot accept
images no matter what flags you pass. With a vision model, the relevant flag controls **how
many images** are accepted per prompt:

```bash
--limit-mm-per-prompt '{"image": 4}'   # max 4 images per request (default is often 1)
```

If you only allow 1 image per prompt (the default for many models) but a user uploads
several, vLLM rejects the request. **The number-of-images limit is the most common cause of
image support requests.** Raise `--limit-mm-per-prompt` to the number of images you want to
support.

Other useful flags:

```bash
--max-model-len 8192                       # images consume many tokens; give enough context
--allowed-local-media-path /data/uploads   # only if referencing local files (not needed for iHub base64)
--allowed-media-domains example.com cdn.x  # restrict remote image fetching (SSRF protection)
--media-io-kwargs '{"image": {"rgba_background_color": [0,0,0]}}'  # image decode options
--trust-remote-code                        # required by some vision models' processors
```

> iHub sends images **inline as base64 data URLs**, so `--allowed-local-media-path` and
> `--allowed-media-domains` are generally **not** required for the iHub → vLLM path. They
> only matter if you pass URLs/local paths directly.

### Example: Vision model accepting up to 2 images

```bash
vllm serve microsoft/Phi-3.5-vision-instruct \
    --served-model-name phi-3.5-vision \
    --runner generate --trust-remote-code \
    --host 0.0.0.0 --port 8000 \
    --max-model-len 8192 \
    --limit-mm-per-prompt '{"image": 2}'
```

### Matching iHub model config

```json
{
  "id": "vllm-phi-vision",
  "modelId": "phi-3.5-vision",
  "name": { "en": "Phi-3.5 Vision (vLLM)" },
  "description": { "en": "Phi-3.5 vision model served by vLLM" },
  "url": "http://localhost:8000/v1/chat/completions",
  "provider": "openai",
  "contextWindow": 8192,
  "maxOutputTokens": 4096,
  "supportsImages": true,
  "supportsVision": true,
  "enabled": true
}
```

> Keep the iHub upload limits aligned with the vLLM `--limit-mm-per-prompt` image count.
> If iHub lets users attach 5 images but vLLM allows only 2, requests with 3+ images fail.
> See [Image Upload Feature](image-upload-feature.md) for the iHub-side upload settings.

---

## 3. Audio Input

### Required start parameters

Audio input requires an **audio-capable multimodal model** (e.g. Ultravox, Qwen2-Audio,
Phi-4-multimodal). As with images, the per-prompt count is controlled by
`--limit-mm-per-prompt`:

```bash
--limit-mm-per-prompt '{"audio": 1}'   # max audio clips per request
```

For models that accept **both** audio and images, combine the limits:

```bash
--limit-mm-per-prompt '{"image": 2, "audio": 1}'
```

### Example: Ultravox audio model

```bash
vllm serve fixie-ai/ultravox-v0_5-llama-3_2-1b \
    --served-model-name ultravox \
    --host 0.0.0.0 --port 8000 \
    --limit-mm-per-prompt '{"audio": 1}'
```

### Example: Qwen2-Audio

```bash
vllm serve Qwen/Qwen2-Audio-7B-Instruct \
    --served-model-name qwen2-audio \
    --host 0.0.0.0 --port 8000 \
    --max-model-len 8192 \
    --limit-mm-per-prompt '{"audio": 1}'
```

### Matching iHub model config

```json
{
  "id": "vllm-ultravox",
  "modelId": "ultravox",
  "name": { "en": "Ultravox (vLLM)" },
  "description": { "en": "Ultravox audio model served by vLLM" },
  "url": "http://localhost:8000/v1/chat/completions",
  "provider": "openai",
  "contextWindow": 8192,
  "maxOutputTokens": 4096,
  "supportsAudio": true,
  "enabled": true
}
```

iHub sends audio as OpenAI `input_audio` parts and supports these formats: `wav`, `mp3`,
`flac`, `ogg`, `mp4`, `webm`. Make sure the served model accepts the format users will upload.
See [Audio File Support](audio-file-support.md) for the iHub-side details.

---

## 4. Putting it all together

A model that supports tools **and** images **and** audio needs all the relevant flags at once.
Only do this if the model actually supports every modality:

```bash
vllm serve <multimodal-tool-capable-model> \
    --served-model-name my-model \
    --host 0.0.0.0 --port 8000 \
    --max-model-len 32768 \
    --gpu-memory-utilization 0.9 \
    --enable-auto-tool-choice \
    --tool-call-parser <parser-for-your-model> \
    --limit-mm-per-prompt '{"image": 4, "audio": 1}'
```

Corresponding iHub model config:

```json
{
  "id": "vllm-multimodal",
  "modelId": "my-model",
  "name": { "en": "My Multimodal Model (vLLM)" },
  "description": { "en": "Tool + image + audio capable model via vLLM" },
  "url": "http://localhost:8000/v1/chat/completions",
  "provider": "openai",
  "contextWindow": 32768,
  "maxOutputTokens": 4096,
  "supportsTools": true,
  "supportsImages": true,
  "supportsVision": true,
  "supportsAudio": true,
  "enabled": true
}
```

### Docker Compose example

```yaml
services:
  vllm-server:
    image: vllm/vllm-openai:latest
    command: >
      --model mistralai/Mistral-Small-Instruct-2409
      --served-model-name mistral-small
      --host 0.0.0.0 --port 8000
      --gpu-memory-utilization 0.8
      --max-model-len 32768
      --enable-auto-tool-choice
      --tool-call-parser mistral
      --limit-mm-per-prompt '{"image": 4}'
    ports:
      - '8000:8000'
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

---

## 5. Troubleshooting checklist

When a customer reports a vLLM capability "not working," check in this order:

### Tool calling not working

1. Was vLLM started with **`--enable-auto-tool-choice`**? (Check the launch command / logs.)
2. Does the **`--tool-call-parser`** match the model family? (Wrong parser → tool calls not parsed.)
3. Does the model actually support function calling? (Check the
   [supported models list](https://docs.vllm.ai/en/latest/models/supported_models.html).)
4. Is `"supportsTools": true` set in the iHub model config?
5. Test directly with the `curl` command in [section 1](#verify-tool-calling-works) —
   if `tool_calls` is absent there, it's a vLLM-side issue, not iHub.

### Images not working

1. Is the served model a **vision model**? (Text-only models can't accept images.)
2. Is **`--limit-mm-per-prompt`** set high enough for the number of images users send?
   (Default is often 1.)
3. Is `--max-model-len` large enough? Images consume many tokens.
4. Are `"supportsImages"` / `"supportsVision"` set in the iHub model config?
5. Do iHub's upload limits exceed the vLLM image limit? Align them.

### Audio not working

1. Is the served model **audio-capable** (Ultravox, Qwen2-Audio, Phi-4-multimodal, …)?
2. Is **`--limit-mm-per-prompt`** set with an `"audio"` count ≥ 1?
3. Does the model accept the uploaded format (`wav`/`mp3`/`flac`/`ogg`/`mp4`/`webm`)?
4. Is `"supportsAudio": true` set in the iHub model config?

### General checks

```bash
# Is the server up and which model is loaded?
curl http://localhost:8000/v1/models

# Health check
curl http://localhost:8000/health

# What flags is this vLLM version actually offering?
vllm serve --help

# Confirm your version (flags differ between releases)
vllm --version
```

> Most vLLM "it doesn't work" cases are resolved by **restarting vLLM with the correct start
> parameters** above and aligning the iHub model config flags. iHub cannot enable a capability
> that the underlying vLLM server was not started to support.

---

## Related documentation

- [Local LLM Providers Integration Guide](local-llm-providers.md) — full vLLM setup, reasoning parsers, per-model API keys
- [Models](models.md) — model configuration reference
- [Tool Calling](tool-calling.md) — iHub tool/function calling
- [Image Upload Feature](image-upload-feature.md) — iHub image upload settings
- [Audio File Support](audio-file-support.md) — iHub audio upload settings
</content>
</invoke>
