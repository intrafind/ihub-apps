# STT Models

iHub Apps supports on-device speech recognition through three in-browser ML engines (Whisper, Parakeet, Moonshine). Model files are large ONNX binaries that must be downloaded once and stored on the server before users can activate voice input.

## Supported Models

| Model ID | Engine | HuggingFace Repo | Approx. Size | Notes |
|---|---|---|---|---|
| `whisper-tiny` | Whisper | `onnx-community/whisper-tiny` | ~150 MB | Fastest; good for most languages |
| `whisper-base` | Whisper | `onnx-community/whisper-base` | ~290 MB | Better accuracy than tiny |
| `parakeet-tdt-0.6b` | Parakeet | `onnx-community/parakeet-tdt-0.6b` | ~620 MB | English only; high accuracy |
| `moonshine-tiny` | Moonshine | `onnx-community/moonshine-tiny-onnx` | ~90 MB | Smallest; English only |
| `moonshine-base` | Moonshine | `onnx-community/moonshine-base-onnx` | ~190 MB | Better accuracy than moonshine-tiny |

## Browser Requirements

- **WebGPU (recommended):** Chrome/Edge 113+, requires `--enable-unsafe-webgpu` on some platforms
- **WASM fallback:** All modern browsers; automatic when WebGPU is unavailable (slower inference)

## Directory Structure

Downloaded models are stored under `contents/models/stt/`:

```
contents/models/stt/
├── whisper-tiny/
│   ├── config.json
│   ├── tokenizer.json
│   └── onnx/
│       └── encoder_model.onnx
│       └── decoder_model.onnx
├── moonshine-tiny/
│   ├── config.json
│   └── ...
└── parakeet-tdt-0.6b/
    ├── vocab.txt
    └── ...
```

## Downloading Models

### Via Admin UI (Recommended)

1. Navigate to **Admin → Models → STT**
2. Click **Download** next to the desired model
3. A progress stream shows each file as it downloads from HuggingFace
4. Once complete, the model is immediately available to users

### Via Admin API

```bash
# List all known models and their local availability
curl -H "Authorization: Bearer <token>" \
  http://localhost:3000/api/admin/models/stt

# Download a specific model (server-side, streams SSE progress)
curl -H "Authorization: Bearer <token>" \
  -X POST \
  http://localhost:3000/api/admin/models/stt/whisper-tiny/_download
```

### Manually via huggingface-cli

```bash
pip install huggingface-hub
huggingface-cli download onnx-community/whisper-tiny \
  --local-dir contents/models/stt/whisper-tiny
```

### Manually via git lfs

```bash
git lfs install
git clone https://huggingface.co/onnx-community/whisper-tiny \
  contents/models/stt/whisper-tiny
```

## Platform Configuration

Control STT behaviour in `contents/config/platform.json`:

```json
{
  "speechRecognition": {
    "defaultService": "whisper",
    "defaultModel": "whisper-tiny",
    "modelsBasePath": "/api/assets/models/stt",
    "allowAnonymousModelDownload": false
  }
}
```

| Field | Default | Description |
|---|---|---|
| `defaultService` | `"default"` | Service to use when no app-level override is set. `"default"` means browser-native Web Speech API. |
| `defaultModel` | `"whisper-tiny"` | Model ID for Whisper and Moonshine engines. |
| `modelsBasePath` | `"/api/assets/models/stt"` | URL path from which the browser fetches model files. Change only if you serve models from a CDN or different path. |
| `allowAnonymousModelDownload` | `false` | When `true`, unauthenticated users can fetch model files. Leave `false` in most deployments to prevent DoS from large file transfers. |

## Per-App Configuration

Override the platform defaults for a specific app in its JSON config:

```json
{
  "settings": {
    "speechRecognition": {
      "service": "moonshine",
      "model": "moonshine-tiny"
    }
  }
}
```

## Security Notes

- Model files are served through an authenticated endpoint (`GET /api/assets/models/stt/:modelId/:filePath`).
- `allowAnonymousModelDownload` must be explicitly set to `true` to allow unauthenticated downloads. Keep it `false` unless your deployment has no user accounts.
- Admin download endpoint requires admin credentials. Model IDs are validated against a hardcoded registry; HuggingFace URLs are constructed server-side and never interpolated from user input (SSRF protection).
