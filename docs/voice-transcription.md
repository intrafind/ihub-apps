# Realtime Voice & Transcription (Voxtral)

This guide covers iHub Apps' realtime speech-to-text stack end to end: what users see, how audio flows through the system, how to deploy and configure a self-hosted Voxtral (vLLM) backend, how to put it behind a reverse proxy such as nginx, and how it behaves under load. It is written for administrators running iHub Apps in production.

Three user-facing features share one server-side pipeline:

| Feature                     | What the user does                                                     | Where the text goes                              |
| --------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| **Dictation**               | Clicks the microphone icon and speaks                                  | Into the chat **input field**                    |
| **Record → transcribe**     | Clicks the record button, speaks, clicks stop                          | Streams into an **assistant chat message**       |
| **File/video transcription**| Uploads an audio file or a video (audio track is extracted in-browser) | Streams into an **assistant chat message**       |

All three send audio to the same iHub WebSocket endpoint, `/api/voice/realtime`, which relays it to a vLLM realtime endpoint (e.g. Voxtral). The browser **never** connects to vLLM directly, and the vLLM URL / API key **never** reach the browser.

## Architecture

```
Browser                          iHub Apps server                     GPU host
┌───────────────────────┐       ┌──────────────────────────┐        ┌─────────────────┐
│ mic / file / video    │       │ /api/voice/realtime      │        │ vLLM            │
│  → AudioWorklet /     │  WS   │  · JWT auth on upgrade   │   WS   │  /v1/realtime   │
│    decodeAudioData    │──────▶│  · Origin (CSWSH) guard  │───────▶│  Voxtral model  │
│  → 16 kHz mono PCM16  │       │  · per-model permissions │        │                 │
│                       │◀──────│  · connection caps       │◀───────│ transcription.* │
│ transcript (deltas)   │ JSON  │  · relay + backpressure  │  JSON  │ frames          │
└───────────────────────┘       └──────────────────────────┘        └─────────────────┘
```

Key properties:

- **All audio processing happens in the browser.** Decoding uploaded files (`decodeAudioData`), extracting the audio track from videos, downmixing to mono, and resampling to 16 kHz run client-side (AudioWorklet / `OfflineAudioContext`). The server only relays already-prepared PCM16 frames — there is no server-side decoding, no ffmpeg, and no CPU-heavy work on the Node.js event loop.
- **The server is a thin, per-connection bridge.** Each browser connection gets its own dedicated upstream socket and closure-scoped state. There is no broadcast and no shared session registry — one user can never receive another user's transcript frames.
- **Nothing is persisted.** Audio is relayed and discarded; transcripts stream to the requesting client only. Server logs record frame counts and text lengths (at debug level), never transcript content.

### WebSocket protocol (browser ↔ iHub)

The protocol is iHub-defined (both ends are ours):

| Direction        | Frame                                | Meaning                                                        |
| ---------------- | ------------------------------------ | -------------------------------------------------------------- |
| client → server  | `{"type":"start", "modelId"?}`       | Begin a session. With `modelId`: use that transcription model. Without: use the platform dictation backend. |
| client → server  | binary frames                        | PCM16 audio, 16 kHz mono, little-endian                        |
| client → server  | `{"type":"stop"}`                    | No more audio; flush and finish                                 |
| server → client  | `{"type":"ready"}`                   | Upstream session initialized — safe to stream at full speed     |
| server → client  | `{"type":"delta","text":"..."}`      | Streaming partial transcript                                    |
| server → client  | `{"type":"final","text":"..."}`      | A completed utterance/segment                                   |
| server → client  | `{"type":"done"}`                    | Transcript complete (sent after `stop` once the upstream settles) |
| server → client  | `{"type":"error","code","message"}`  | Setup or upstream failure (connection closes afterwards)        |

Error frames carry a stable machine-readable `code` alongside the human-readable `message`:

| `code`                                          | Meaning                                                     |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `not-configured`                                | No dictation backend configured (dictation sessions)        |
| `unknown-model` / `not-transcription-model` / `model-disabled` | The requested `modelId` is invalid for transcription |
| `not-permitted`                                 | The user's groups don't grant the model                     |
| `unsupported-provider` / `no-endpoint` / `resolve-failed` | Model misconfiguration                            |
| `upstream-unreachable` / `upstream-rejected` / `upstream-closed` / `upstream-error` | vLLM connectivity/protocol failures |
| `session-limit`                                 | The `maxSessionSeconds` cap was hit                          |

### Connection lifecycle and guards

A transcription session pins a GPU-backed upstream socket, so the bridge is deliberately strict about lifecycle:

| Guard                       | Default   | Behavior                                                                                       |
| --------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| Lazy upstream open          | —         | The upstream socket opens on `start` (model-based) or first audio frame (dictation) — an idle browser tab never pins a GPU session. |
| No-audio grace              | 15 s      | A connection that never sends audio is closed.                                                 |
| Idle timeout                | 60 s      | No audio and no upstream activity → close both legs.                                           |
| Keepalive ping/pong         | every 25 s| Server pings the browser (browsers auto-pong). A client that misses a whole interval (crashed tab, suspended laptop) is terminated. Pings also keep reverse-proxy read timeouts from killing quiet sessions while the GPU processes a long tail. |
| Post-stop settle            | 2.5 s     | After `stop`, the transcript is complete once the upstream stays quiet this long (long files produce many segments). Then `{"type":"done"}` is sent and the session closes. |
| Session duration cap        | 3600 s    | Hard ceiling on one session's lifetime (configurable, see below).                              |
| Frame size cap              | 256 KB    | `maxPayload` on the WebSocket server; oversized frames terminate the connection.               |
| Connection caps             | 50 total / 3 per user | Enforced **before** the handshake completes; excess upgrades get HTTP 429. Anonymous users are capped per client IP (first `X-Forwarded-For` hop behind a proxy), not as one shared bucket. |
| Upstream backpressure       | 4 MB high water | If iHub→vLLM is the slow hop, the client socket is paused (real TCP flow control) until the upstream send buffer drains below 1 MB — per-connection memory stays bounded instead of buffering a whole file. |

Everything on the relay path is asynchronous and O(one frame): per-frame work is a ≤256 KB base64 encode and a JSON stringify. The Node.js event loop is never blocked by file-sized work.

## Deploying Voxtral with vLLM

Run Voxtral's realtime model on a GPU host with a recent vLLM release that includes the realtime API:

```bash
vllm serve mistralai/Voxtral-Mini-4B-Realtime-2602 \
  --host 0.0.0.0 \
  --port 8080
```

This exposes a WebSocket endpoint at `ws://<gpu-host>:8080/v1/realtime`. Verify it accepts connections before wiring it into iHub (the admin UI has a **Test connection** button that performs the protocol handshake for you).

Recommendations for production:

- **Network placement:** keep the vLLM endpoint on an internal network reachable only by the iHub server(s). It does not need to be — and should not be — reachable from user browsers.
- **TLS:** if the endpoint crosses a network boundary, front it with TLS and use a `wss://` URL. iHub verifies upstream certificates using Node's default trust store; for a private CA, set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` in the iHub server environment. Never disable TLS verification.
- **Authentication:** if you front vLLM with an authenticating gateway, configure the key in the iHub model config (sent upstream as `Authorization: Bearer <key>`); it is encrypted at rest in iHub.

## Configuring the transcription model

Transcription models are first-class model configs with `modelType: "transcription"`. A disabled default ships at `contents/models/voxtral-mini-realtime.json`:

```json
{
  "id": "voxtral-mini-realtime",
  "modelId": "mistralai/Voxtral-Mini-4B-Realtime-2602",
  "name": { "en": "Voxtral Mini (Transcription)" },
  "description": { "en": "Self-hosted Voxtral realtime speech-to-text." },
  "url": "ws://localhost:8080/v1/realtime",
  "provider": "vllm-realtime",
  "modelType": "transcription",
  "apiKey": "",
  "enabled": false
}
```

Field notes:

- **`url`** — the vLLM realtime WebSocket endpoint (`ws://` or `wss://`). Supports `${ENV_VAR}` placeholders (e.g. `"url": "${VOXTRAL_URL}"`), which is the recommended way to vary the endpoint across environments. This URL is **never** sent to browsers — the public models API strips it.
- **`modelId`** — the upstream model name announced to vLLM in the session handshake.
- **`apiKey`** — optional. Plaintext values are encrypted at rest (AES-256-GCM `ENC[...]`) when saved through the admin UI; `${ENV_VAR}` placeholders are also supported. Sent upstream as a Bearer token, never to browsers.
- **`enabled`** — must be `true` for the model to be usable.

Configure it in **Admin → Models** (select model type "Transcription"), or edit the JSON directly — changes are hot-reloaded. Use the **Test connection** button in Admin → Voice/Models to validate reachability and protocol without streaming audio.

Transcription models are deliberately invisible to the chat stack: `GET /api/models` returns chat models only (transcription models via the explicit `?type=transcription` query, with `url`/`apiKey` stripped), so they can never be picked as a chat model, magic-prompt model, or workflow model.

## Enabling transcription on an app

Add a `transcription` block to the app config (Admin → Apps → Edit → Transcription section):

```json
{
  "transcription": {
    "enabled": true,
    "modelId": "voxtral-mini-realtime",
    "defaultEnabled": true,
    "streaming": true,
    "maxDurationSeconds": 900,
    "inputs": { "upload": true, "record": true, "video": true }
  },
  "upload": {
    "enabled": true,
    "videoUpload": {
      "enabled": true,
      "extractAudio": true,
      "maxFileSizeMB": 500,
      "supportedFormats": ["video/mp4", "video/webm", "video/quicktime"]
    }
  }
}
```

| Field                | Default | Meaning                                                                                     |
| -------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `enabled`            | `false` | Master switch for the app.                                                                   |
| `modelId`            | `""`    | Which `modelType: "transcription"` model to route to.                                        |
| `defaultEnabled`     | `true`  | Whether the per-chat **Transcription** toggle starts on. Users can flip it per conversation (like web search). When off, audio/video submissions fall through to the multimodal chat path instead. |
| `streaming`          | `true`  | Stream partial deltas into the assistant bubble.                                             |
| `maxDurationSeconds` | `900`   | Client-enforced cap on recording length / decoded audio duration (max `7200`).               |
| `inputs.upload`      | `true`  | Allow transcribing uploaded audio files.                                                     |
| `inputs.record`      | `true`  | Show the record→transcribe button.                                                          |
| `inputs.video`       | `true`  | Allow transcribing uploaded videos (audio track extracted in the browser).                   |

`upload.videoUpload.maxFileSizeMB` accepts up to `2000`. Note that browsers decode the **entire** file in memory to extract PCM — for very large videos budget roughly 700 MB of tab memory per hour of 48 kHz stereo audio on top of the file itself. The `maxDurationSeconds` cap is the better lever for bounding work.

### What users see

- A **Transcription** toggle in the chat input's actions menu (when the app has it enabled) showing that audio/video will be handled by a separate transcription model.
- A **record button** (red dot → elapsed timer → stop square). Stopping streams the transcript into the chat as an assistant message.
- Attaching an audio/video file and submitting streams its transcript the same way. An in-flight transcription can be **cancelled**; text transcribed so far is kept and a cancellation notice is appended.

## Permissions

Transcription models are permission-checked like chat models, using the same group model lists (`contents/config/groups.json`):

```json
{
  "groups": {
    "users": {
      "permissions": {
        "models": ["gpt-4", "voxtral-mini-realtime"]
      }
    }
  }
}
```

A user whose groups grant neither `voxtral-mini-realtime` nor `*` receives `Not permitted to use transcription model` when a session starts. The check **fails closed**: if permissions cannot be computed for a connection, model-based transcription is denied.

## Dictation backend (platform-level)

Dictation (microphone → input field) predates transcription models and is configured platform-wide under `platform.json` → `speech.realtime`. Sessions started **without** a `modelId` use it:

```json
{
  "speech": {
    "realtime": {
      "enabled": true,
      "url": "ws://voxtral.internal:8080/v1/realtime",
      "model": "mistralai/Voxtral-Mini-4B-Realtime-2602",
      "apiKey": ""
    }
  }
}
```

Both backends can point at the same vLLM deployment. The WebSocket endpoint is available when **either** the dictation backend is enabled **or** at least one enabled transcription model exists.

> **Note:** the dictation backend (`platform.speech.realtime.url/model/apiKey`) and a transcription model's config are **independent copies** — the V073 migration seeds the model from the platform values once, but afterwards updating one does not update the other. When you move the vLLM endpoint, update both places.

## Runtime limits and tuning

All knobs live under `platform.json` → `speech.realtime` and apply to the whole realtime endpoint (dictation and transcription):

| Setting                 | Default   | Applies             | Notes                                                                 |
| ----------------------- | --------- | ------------------- | --------------------------------------------------------------------- |
| `maxConnections`        | `50`      | on server start     | Global concurrent realtime connections per iHub **worker process**.   |
| `maxConnectionsPerUser` | `3`       | on server start     | Per-user concurrent connections per worker process.                   |
| `maxFrameBytes`         | `262144`  | on server start     | Max size of one inbound WebSocket frame.                              |
| `maxSessionSeconds`     | `3600`    | per new connection  | Hard cap on one session's lifetime. Hot-reloaded (no restart needed). |

Sizing guidance: each concurrent connection holds one vLLM realtime session, so set `maxConnections` to what your GPU deployment sustains. Per-connection server memory is bounded by the backpressure high-water mark (~4 MB worst case, typically far less).

## Reverse proxy configuration (nginx)

`/api/voice/realtime` is a WebSocket endpoint, so the proxy in front of iHub must forward HTTP Upgrade requests. If you followed the [Production Reverse Proxy Guide](production-reverse-proxy-guide.md), the main `location` block already sets the Upgrade headers and voice will work. For clarity and independent tuning, a dedicated block is recommended:

```nginx
# Realtime voice WebSocket (dictation + transcription).
# Adjust /ihub to your subpath, or drop it for root deployments.
location /ihub/api/voice/realtime {
    proxy_pass http://ihub_backend/api/voice/realtime;

    # WebSocket upgrade
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # Identity of the browser-facing host — REQUIRED for the server's
    # same-origin (CSWSH) check when Host is rewritten to an internal name.
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Prefix /ihub;

    # No buffering for a bidirectional stream
    proxy_buffering off;

    # The server pings every 25s, so 60s defaults are already safe; raise
    # anyway so a saturated GPU can't get sessions killed mid-transcription.
    proxy_connect_timeout 30s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;
}
```

Notes:

- **Origin checking:** the server rejects cross-origin browser handshakes. It accepts same-origin (matched against `Host` / `X-Forwarded-Host`) plus any origin in `platform.json` → `cors.origin` (including `${ALLOWED_ORIGINS}`). If voice fails with HTTP 403 behind your proxy, the proxy is most likely rewriting `Host` without setting `X-Forwarded-Host`.
- **Apache:** enable `proxy_wstunnel` and add a websocket rewrite for the voice path (the generic WS rewrite in the reverse-proxy guide covers it). Set `ProxyTimeout` ≥ 300.
- **Traefik / Kubernetes ingress-nginx:** WebSocket upgrades are forwarded by default; only raise the read/send timeouts (ingress-nginx: `nginx.ingress.kubernetes.io/proxy-read-timeout: "300"`).
- **TLS:** browsers require secure contexts for microphone access — in production the site must be HTTPS, which also means the browser↔iHub leg runs over `wss://` automatically (the client derives the WebSocket scheme from the page origin).

## Scaling and high availability

- **Cluster workers (`WORKERS>1`):** the WebSocket handler attaches per worker, and the sticky-session cluster router keeps each connection on one worker. Connection caps are therefore **per worker** — with `WORKERS=4` and `maxConnections=50`, the instance-wide ceiling is 200. Set `maxConnections` to your per-GPU budget divided by the worker count.
- **Multiple iHub instances:** caps are per instance; multiply accordingly, or enforce a global budget at the vLLM deployment (e.g. gateway concurrency limits). WebSocket sessions are connection-oriented, so any load-balancing scheme keeps a session on one instance for its lifetime; no shared state is needed between instances for voice.
- **GPU capacity:** a realtime session is held open for the duration of the transcription. Uploads stream faster than realtime, so sessions are usually short; dictation sessions last as long as the user talks. If the GPU saturates, new sessions still connect but transcribe slowly — the backpressure mechanism keeps server memory flat while they wait, and per-user caps (429 on the fourth concurrent session) keep one user from monopolizing.
- **Failure behavior:** if the upstream is unreachable or closes abnormally, the client receives a diagnostic `{"type":"error"}` (e.g. `Transcription service unreachable: ECONNREFUSED`) and the UI surfaces it — sessions never hang silently. If neither a dictation backend nor an enabled transcription model exists, the endpoint answers upgrades with HTTP 503.

## Security model

- **Endpoint secrecy:** the vLLM `url`/`apiKey` exist only server-side. The public models API strips them; the browser sends only a model **id**, and the server refuses anything else (a raw URL from a client is never accepted).
- **Authentication:** the WebSocket upgrade is authenticated with the same JWT as the HTTP API (`authToken` cookie or `Authorization: Bearer`). Anonymous connections are accepted only when anonymous access is enabled platform-wide.
- **Cross-Site WebSocket Hijacking (CSWSH):** browsers attach cookies to cross-origin WebSocket handshakes, so the server validates the `Origin` header against same-origin and the CORS allowlist and rejects everything else with 403. Unlike HTTP CORS, a `"*"` wildcard in `cors.origin` is deliberately **not** honored on this socket — cross-origin voice requires explicitly listing each origin. (The `authToken` cookie is additionally `SameSite=Lax`, so cross-site handshakes don't carry a victim's session in the first place.)
- **Authorization:** model access is enforced per user from group permissions, failing closed.
- **Isolation:** each connection's state and upstream socket are private to that connection. There is no cross-connection event bus; user A cannot subscribe to user B's transcription events.
- **Resource protection:** connection caps (429), frame-size caps, pending-buffer caps, idle/grace timers, keepalive dead-peer detection, upstream backpressure, and a session duration cap bound CPU, memory, and GPU pinning per user and per instance.
- **Secrets at rest:** model API keys are encrypted (AES-256-GCM) in the config files; `${ENV}` placeholders keep secrets out of files entirely.
- **Admin test endpoint:** `POST /api/admin/voice/realtime/test` requires admin auth and never echoes the stored key back.
- **Privacy:** audio is relayed, never stored; transcript content is never logged (only lengths and frame counts at debug level). Transcripts appear in chat history subject to the same handling as any other chat content.

## Browser requirements

| Capability                    | Requirement                                                       |
| ----------------------------- | ----------------------------------------------------------------- |
| Microphone (dictation/record) | Secure context (HTTPS or `localhost`); AudioWorklet (all evergreen browsers; ScriptProcessor fallback for older ones) |
| File/video transcription      | Web Audio `decodeAudioData` for the container/codec — MP3, WAV, M4A/AAC, OGG, FLAC and MP4/WebM/MOV video audio in evergreen browsers |
| Resampling                    | `OfflineAudioContext` (universal; linear-resample fallback included) |

## Troubleshooting

| Symptom                                                        | Cause / fix                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Record/mic button missing                                      | Page not a secure context (HTTPS), app's `transcription.inputs.record` off, or feature disabled.  |
| Upgrade fails with **503**                                     | No enabled transcription model **and** `speech.realtime` disabled/unset.                          |
| Upgrade fails with **401**                                     | Missing/expired JWT and anonymous access disabled.                                                |
| Upgrade fails with **403**                                     | Origin rejected (CSWSH guard). Add the browser origin to `ALLOWED_ORIGINS`, or set `X-Forwarded-Host` at the proxy. |
| Upgrade fails with **429**                                     | Connection caps reached (`maxConnections` / `maxConnectionsPerUser`).                             |
| `Not permitted to use transcription model: …`                  | User's groups don't grant the model id — update `groups.json`.                                    |
| `Transcription service unreachable: ECONNREFUSED / ENOTFOUND`  | vLLM down or wrong `url` (host/port). Test with the admin **Test connection** button.             |
| `…rejected the connection (HTTP 404)`                          | Wrong upstream path — the URL must point at `/v1/realtime`.                                       |
| `…rejected the connection (HTTP 401/403)`                      | Upstream auth — set/fix the model `apiKey`.                                                       |
| Empty transcript / "no speech detected"                        | Clip silent or extremely short; check input device and vLLM logs.                                 |
| Transcript stops mid-file behind a proxy                       | Proxy killing the WebSocket — verify Upgrade headers and raise `proxy_read_timeout` (see above).   |
| `Transcription session exceeded the maximum duration`          | Session hit `maxSessionSeconds` — raise it for very long recordings.                              |
| Chat stuck on "generating"                                     | The `{"type":"done"}` frame never arrived — usually a proxy dropping the socket after `stop`; check proxy timeouts, then server logs (`component: RealtimeSTT`). |

Server-side, all bridge activity is logged with `component: "RealtimeSTT"` — connection establishment, upstream readiness (with trigger), stop/commit bookkeeping (frame counts), failures with diagnostic reasons, and cap/keepalive/session-limit closures.

## Related documentation

- [Models](models.md) — model configuration reference, including transcription models
- [Microphone Feature](microphone-feature.md) — dictation UI configuration
- [Audio File Support](audio-file-support.md) / [Audio Extraction](audio-extraction.md) — the multimodal upload path and in-browser audio extraction
- [Production Reverse Proxy Guide](production-reverse-proxy-guide.md) — full nginx/Apache/Traefik deployment guide
- [Scaling with Multiple Workers](scaling.md) — cluster mode details
