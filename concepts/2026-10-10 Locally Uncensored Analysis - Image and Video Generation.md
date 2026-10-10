# Locally Uncensored: How It Works and What iHub Apps Can Learn

**Date:** 2026-10-10
**Scope:** Architecture study of [PurpleDoubleD/locally-uncensored](https://github.com/PurpleDoubleD/locally-uncensored) (v3.0.5), with a focus on image and video generation, and a gap analysis against iHub Apps.
**Status:** Analysis / planning input. No implementation decisions are made here.

> **License note.** Locally Uncensored (LU) is **AGPL-3.0-only**. Nothing in this document proposes copying code. The value is in the architecture, the contracts and the hard-won edge cases, all of which can be re-implemented independently in iHub Apps.

---

## 1. Summary

Locally Uncensored is a **Tauri v2 desktop app** (Rust backend, React 19, Zustand) that bundles four surfaces in one window: Chat, Create (images, video, music), Code (coding agent) and Agent (tools + MCP). Everything runs locally by default; a paid "LU Cloud" relays heavy jobs to hosted GPUs.

For image and video generation it does **not** ship its own diffusion runtime. It installs, launches, repairs and drives **ComfyUI** as a sidecar, and hides ComfyUI's node graphs behind a lane-based UI ("Image", "Edit / Image to Image", "Video", "Animate Image", "Extend", "Talking Character", "Motion Control", "Music", "Character Studio"). The core intellectual property is:

1. A **dynamic graph builder** that turns `(model file, lane, params)` into a ComfyUI API-format graph, per model family (SDXL, FLUX 1/2, Z-Image, Qwen-Image 2.1, Wan 2.1/2.2, LTX 2.3/2.5, HunyuanVideo, MiniMax H3, SVD, FramePack, AnimateDiff, ACE-Step, YuE2, and more), following the official Comfy-Org workflow templates.
2. **Capability discovery against the live ComfyUI instance** (`/object_info`), so the app never guesses what nodes, samplers, limits or model files exist; it reads them, and refuses with an actionable reason (plus a one-click fix) when something is missing.
3. A **VRAM hand-off orchestrator** that evicts the local chat LLM before a render and reloads it after, so chat and image generation share one consumer GPU.
4. A **chat integration** where plain chat detects "draw me…" intents and routes just that turn through `image_generate` / `video_generate` tools, then feeds the generated picture back to a vision-capable LLM so the model can see what it produced.
5. A **cloud job contract** (upload, quote, submit with idempotency key, poll, signed result URL, cancel) and a **schema-driven parameter UI** for 120 hosted endpoints.

**iHub Apps today** has image generation only as a side effect of Google Gemini "Nano Banana" models (`supportsImageGeneration` on the model, images returned inline with the chat response). There is no image-generation *tool*, no video generation, no local or self-hosted diffusion provider, no masks or inpainting, no LoRA handling, and no gallery. Generated images are already persisted as chat artifacts and rendered in the chat UI.

The most valuable things to take from LU, in priority order:

| # | Learning | Why it matters for iHub Apps |
|---|----------|------------------------------|
| 1 | **Treat media generation as an async job with a provider abstraction**, not as a chat-response side effect | Video takes minutes; hosted and local providers need the same submit/poll/result contract. Gemini-inline stays as one adapter. |
| 2 | **A ComfyUI provider** (self-hosted, on-prem GPU) using API-format graphs and `/object_info` capability probing | The enterprise angle: image/video generation where data never leaves the customer's network. LU proves this is workable without exposing node graphs. |
| 3 | **Schema-driven model/endpoint parameters** | Matches iHub's config-driven design: a model config declares lanes (t2i, i2i, edit, t2v, i2v), durations, resolutions and a JSON-schema of options; the UI renders itself. |
| 4 | **Honest capability handling**: discover real limits, reject out-of-range values *with the limit*, map common failures to actionable hints, offer the fix in place | Replaces silent clamping and opaque provider errors. Directly applicable to the Gemini path too. |
| 5 | **Chat integration patterns**: curated media tools only when intent is detected, "media continuation" for follow-ups, vision feedback of the result | iHub already has tool calling and an image-lift seam; these are small additions with a large UX effect. |
| 6 | **Gallery with reproducibility metadata** (prompt, seed, model, params, "regenerate", "edit with mask", "animate") | iHub has artifacts but no gallery and no round-trip from a result back into a new generation. |

What **not** to copy: the filename-based model classification (fragile, 30-way heuristics with a long history of misclassification fixes), the desktop-only VRAM juggling, the regex-based intent detection as the primary mechanism (iHub has real tool calling), and the sheer size of the single-file graph builder (~2,700 lines).

---

## 2. What Locally Uncensored Is

| Aspect | Detail |
|--------|--------|
| Product | "All-in-one local AI studio": chat, image/video/music creation, coding agent, tool agent, remote access from phone |
| Positioning | Uncensored/abliterated local models, no refusals; privacy ("your data stays on your machine") |
| Tech stack | Tauri v2 (Rust), React 19, TypeScript, Tailwind 4, Vite 8, Zustand, ComfyUI (images/video), faster-whisper (STT), Piper (TTS), optional MLX on Apple Silicon |
| Platforms | Windows and Linux desktop builds; macOS has no ComfyUI path (MLX only, text-to-image/video) and is pushed to the cloud |
| Size | ~1,900 files under `src/`, 72 Rust source files, ~1,170 unit test files, 87 Playwright e2e specs, a 285 KB CHANGELOG |
| Chat engines | Ollama, LM Studio, vLLM, KoboldCpp, llama.cpp, LocalAI, Jan, TabbyAPI, and more; bundled "LU Engine"; cloud keys for OpenAI, Anthropic, OpenRouter, Groq, Together, DeepSeek, Mistral |
| Cloud | "LU Labs" at lu-labs.ai, Supabase auth, credits; relays to WaveSpeed, Alibaba, ByteDance, Vidu, PixVerse, HeyGen, ElevenLabs, MiniMax, Mureka, Black Forest Labs and others |
| License | AGPL-3.0-only |

Engineering culture worth noting: nearly every non-trivial decision is written down **in the code comment at the point of decision**, with the date, the reporter (Discord/GitHub issue) and the failed alternative. Many comments are in German. Tests are named after the behavior they protect ("a-turbo-checkpoint-starts-at-four-steps.test.ts"). This makes the codebase unusually readable as a catalogue of real-world failure modes in local image/video generation.

---

## 3. Architecture Overview

```
┌──────────────────────────────── React (WebView) ────────────────────────────────┐
│  Chat ──► useChat ──► chat-tool-intent ──► agent tool executor                   │
│                                              │ image_generate / video_generate   │
│  Create ─► useCreate (local) ───────────┐    ▼                                   │
│           useCloudCreate (cloud) ──┐    │  vram-handoff orchestrator             │
│                                    │    │    │                                   │
│  stores: createStore (gallery,     │    │    ▼                                   │
│          params, intents), …       │    └─► dynamic-workflow (graph builder)     │
│                                    │          │  component-registry              │
│                                    │          │  family-components               │
│                                    │          ▼                                   │
│                                    │       api/comfyui (HTTP) + comfyui-ws (WS)  │
└────────────────────────────────────┼──────────┼─────────────────────────────────┘
                                     │          │  Tauri invoke / events
                                     ▼          ▼
                     lu-labs.ai jobs API    Rust: proxy, WS proxy, comfy install/
                     (upload/quote/submit/        launch/repair, GPU detect, torch
                      poll/cancel)                wheel pick, ffmpeg, gallery files
                                                        │
                                                        ▼
                                                 ComfyUI (python venv)
                                                 :8188 /prompt /history
                                                 /object_info /ws /upload /view
```

Two orthogonal axes drive the Create surface:

- **Backend**: `local` (ComfyUI on this machine, or MLX on a Mac) vs `cloud` (LU Labs). Runtime-only, never persisted.
- **Intent / lane**: `image`, `edit` (image-to-image + inpaint), `removebg`, `upscale`, `eraser`, `video`, `animate`, `character`, `lipsync`, `music`, `extend`, `motion`. Each intent declares `needsSource`, `needsPrompt`, `allowsMask`, `isVideo`, the custom-node capability it depends on (`rmbg`, `inpaint-nodes`, `dwpose`), whether it is cloud-only, and whether it has a local lane (`src/components/create/experimental/intents.ts`).

A pure function `visibleIntents(backend, mlxHost, cloudFeatures)` decides which lanes are shown, locked as "cloud teaser", or hidden. Lanes that cannot run on the host are never shown as working tabs.

---

## 4. Local Generation Path (ComfyUI)

### 4.1 ComfyUI as the engine

LU uses ComfyUI purely through its HTTP/WS API, never through its canvas UI:

| Endpoint | Use in LU |
|----------|-----------|
| `GET /object_info` | The full node catalogue with input specs (types, enums, min/max/default). Cached 5 minutes. The single source of truth for "what can this install do". |
| `POST /prompt` | Submit an API-format graph with a `client_id`. Returns `prompt_id`. |
| `GET /history/<id>` | Status (`success` / `error`), `execution_error` messages, output files per node. Polled as fallback and for final results. |
| `WS /ws?clientId=` | Live events: `executing` (node), `progress` (step value/max), `executed`, `execution_error`. |
| `POST /upload/image` | Stage a source image / mask for I2I, inpaint, I2V. |
| `GET /view?filename=&subfolder=&type=` | Fetch an output file. Used as the image URL in chat and gallery. |
| `POST /free`, `POST /interrupt`, queue delete | Free VRAM after a run, cancel a render, abandon a job, sweep orphaned jobs left by a crashed session (identified by a `lu-` client-id prefix). |
| `/system_stats` | VRAM totals, device (CPU vs GPU), ComfyUI version. |

Graphs are the **API format** (`{ "3": { class_type: "KSampler", inputs: { seed: 1, model: ["4", 0] } } }`). LU deliberately does *not* support the canvas "web" format for imported workflows; the import dialog tells users to re-export with "Save (API Format)". Every walk over a graph goes through type guards because a graph may be a user-dropped file (`src/types/comfy-graph.ts`).

Control-plane calls carry explicit short timeouts (15–30 s). A wedged `/object_info` right after a ComfyUI restart once froze the whole chat-agent hand-off for minutes with the text model unloaded; bounding each call turns that into a fast, clean error whose `finally` can restore the chat model.

### 4.2 Model classification

`classifyModel(filename)` (`src/api/comfyui.ts`) maps a model file name to one of ~30 `ModelType`s (`sdxl`, `sd15`, `flux`, `flux2`, `krea2`, `zimage`, `qwenimage`, `qwenimage1`, `chroma`, `hidream`, `sd3`, `lumina2`, `ernie_image`, `wan`, `wan22`, `hunyuan`, `ltx`, `ltx25`, `mochi`, `cosmos`, `svd`, `framepack`, `minimaxh3`, `ace`, `yue2`, `wans2v`, `wananimate`, `wanvace`, `animatediff`, `unknown`). It is a long, ordered chain of substring and regex checks, and a Rust **safetensors header sniff** (`model_sniff.rs`) supplements it: tensor names and shapes identify families whose file names say nothing (community finetunes, CivitAI renames), and whether an all-in-one checkpoint carries its own text encoder and VAE.

Per type there is a defaults table (`MODEL_TYPE_DEFAULTS`: steps, cfg, sampler, scheduler, width, height, frames, fps), taken from the official Comfy-Org templates. Distilled models (FLUX, Z-Image, Krea 2, LTX 2.5) default to cfg 1 and few steps; SDXL to cfg 7 and 25 steps.

The git history shows this is the most fragile part of the system: a large share of fixes are "model X was classified as Y and loaded with the wrong loader". **Lesson:** classification by file name alone is a liability. Where possible, ship explicit metadata with the model (bundle manifest, header sniff, or admin-declared type) and only fall back to name heuristics.

### 4.3 Component registry

`COMPONENT_REGISTRY` (`src/api/component-registry.ts`) declares, per model type, which loader to use (`CheckpointLoaderSimple` / `UNETLoader` / `ImageOnlyCheckpointLoader`), whether a separate VAE and text encoder are needed, the `CLIPLoader` type string, and for each companion file: match patterns against the live ComfyUI enum, the canonical download file name, a verified Hugging Face URL, the target subfolder and size. `family-components.ts` does the same for families with multiple encoders (HiDream needs four).

This table used to exist twice (once for the builder, once for the downloader), drifted, and caused a bug. It was consolidated into one data module both sides import. **Lesson:** keep "what this model family needs" as one declarative table; the builder, the downloader and the error messages all read it.

### 4.4 Strategy detection against the live instance

`determineStrategy(modelType, isVideo, categorizedNodes, availableModels)` (`src/api/dynamic-workflow.ts`) picks a `WorkflowStrategy` (`checkpoint`, `unet_flux`, `unet_qwenimage`, `wan22`, `ltx25`, `svd`, `framepack`, `animatediff`, …) by checking which node classes the ComfyUI instance actually registers. Node presence doubles as a **version check**: `TextEncodeQwenImage21` exists → ComfyUI ≥ 0.37; `LTXVDualCFGGuider` exists → ≥ 0.32. If the nodes are missing the result is `{ strategy: 'unavailable', reason, installHint?, needsComfyUpdate? }` with a sentence the UI can act on ("Update ComfyUI in Settings" becomes a one-click update; a missing wrapper pack becomes an install link).

Three families (CogVideoX, Pyramid Flow, Allegro) are deliberately closed with an honest message because their builders emitted node names the wrappers never registered. The comment explains that a clear "not supported in this build" beats an opaque ComfyUI 400.

### 4.5 Dynamic graph builder

`buildDynamicWorkflow(params, modelType)` returns a `ComfyApiGraph`. Per strategy it wires the official template: loaders → (LoRA chain) → text encode → empty latent or `LoadImage` + `VAEEncode` (I2I) / `VAEEncodeForInpaint` + `InpaintModelConditioning` (mask) → sampler → decode → `SaveImage` / video output. Notable details:

- **LoRA stacking**: a list of `{name, strength}`; names are resolved against the installed list with extension-tolerant matching; an unknown name is rejected with the installed list. A persisted LoRA that was deleted from disk is skipped with a progress line, not sent (it used to produce "Value not in list").
- **Video output**: if `VHS_VideoCombine` (VideoHelperSuite) is installed the output is a real `.mp4`; otherwise it falls back to `SaveAnimatedWEBP` and the UI warns. Two user reports of "video generation produced a .webp no player opens" drove a one-click install of the node pack.
- **Frame snapping**: Wan accepts `4n+1` frames, MiniMax H3 and LTX 2.5 have their own grids; `snapWanLength` etc. snap the request instead of letting ComfyUI reject it.
- **Native Hi-Res Fix** (`src/api/hires-fix.ts`): a graph *transform* that finds the terminal `VAEDecode → SaveImage` path, inserts `LatentUpscale → KSampler(low denoise)` and rejects graphs with zero or multiple terminal decodes rather than guessing.
- **Prompt enhancer for Qwen-Image 2.1** (`src/api/qwen-enhancer.ts`): runs the 9B enhancer as its *own* short ComfyUI job before the render so the rewritten prompt can be shown, a failed rewrite falls back to the user's text, and the enhancer is freed from VRAM before the image model loads.
- **Transparent background** for Qwen-Image 2.1, **remove background** via the `RMBG` node pack (pinned to a known-good commit because the pack's head broke on Windows).
- **Imported custom workflows** (`src/api/workflows.ts`): a user can drop an API-format JSON; `autoDetectParameterMap` finds the KSampler, prompt, model, size and seed inputs so the normal UI can drive a foreign graph.

### 4.6 Progress and completion

`useCreate` (`src/hooks/useCreate.ts`) and the agent path both use the same pattern:

1. Connect the WebSocket **before** submitting and take a `mark()`; after submit, subscribe with `since: mark` so the frames that arrived between submit and listener registration are **replayed** from a 400-entry ring buffer. (Without this, the first render after app start showed no "Loading model / text encoder / VAE" lines for ~30 s.)
2. Map `executing` node ids to class types from the submitted graph to derive a phase: `queued` → `loading-model` → `loading-clip` → `loading-vae` → `sampling` (with `progress` value/max) → `decoding` → `complete`.
3. A **heartbeat** polls `/history` every 10 s to catch missed WS events and checks `/queue` once a minute to confirm the prompt is still alive.
4. The timeout is an **activity watchdog** (no event for N minutes), not a wall-clock cap. A wall-clock cap once killed a real 60-minute render seconds before the file landed.
5. A **pace tracker** (`src/lib/render-budget.ts`) projects total sampling time from the first steps and aborts (and abandons the ComfyUI job, freeing the GPU) when an agent-triggered render would clearly blow the budget, with a message naming the device (CPU fallback renders are called out explicitly).
6. On the desktop the WebSocket goes through a **Rust proxy** because ComfyUI ≥ 0.19 rejects cross-origin upgrades from the WebView (`tauri.localhost`) unless started with `--enable-cors-header`.

### 4.7 Capability discovery and "reject with the limit"

`getModelCapabilities(model)` (`src/api/comfyui-nodes.ts`) reads sampler/scheduler enums and steps/cfg/width/height/frame ranges from `/object_info` for the sampler node the family uses. The agent tool path then validates every user-supplied setting against these and **rejects out-of-range values with the actual limit** ("steps 200 exceeds max 100 for this model") instead of silently clamping. Where a limit is only a heuristic (video frame caps), the code says so in `discoveryErrors`.

### 4.8 Fixups: make it work, don't just explain

`buildWithFixups(build, deps)` (`src/lib/render-fixups.ts`) wraps the graph build. When the builder throws `WorkflowUnavailableError` with `missing: ComponentSpec[]` or `needsComfyUpdate: true`, the app asks once ("One more file is needed: qwen_image_2.1_vae_bf16.safetensors (0.3 GB). Download and render?"), downloads into the right ComfyUI subfolder (or, for a remote ComfyUI, downloads locally and tells the user where to copy), refreshes the node cache and retries the build, up to three rounds. The motivating quote in the source is the maintainer's "not just say what is wrong, make it work".

### 4.9 Error hints

`comfyErrorHint(nodeType, exceptionType, message, gpuArch)` maps raw ComfyUI exceptions to actionable text: CUDA/HIP OOM → "shorter clip, lower resolution, set VRAM hand-off to always, or lighter model"; AMD ROCm "invalid device function" / `hipErrorInvalidValue` → the card's gfx target is not in the PyTorch build, with the exact command to verify and the CPU fallback; Windows "paging file too small" → the Windows virtual-memory setting; FramePack wrapper loader/sampler mismatch → upstream node bug, not LU's. Each hint cites the user report that produced it.

### 4.10 Model catalogue, bundles, custom nodes

`src/api/model-bundles.ts` is a hand-curated catalogue of **bundles** (a main model plus every companion file it needs, each with URL, subfolder, size, optional SHA-256), tagged with `vramRequired`, `tier` (`best` / `standard` / `older`), `uncensored`, `verified` (e2e tested), `i2v`, and `customNodes` keys. `withVramNeed` derives numeric `vramMinGB` / `vramComfortGB` from the human text so the "fits your card" badge can never disagree with the description. `CUSTOM_NODE_REGISTRY` lists node packs with the node classes they must register (so an install can be verified) and optional pinned commits with the date and reason.

### 4.11 Rust side: install, launch, repair

The Tauri backend (`src-tauri/src/commands/`) owns everything that touches the OS.

**Install** (`install/comfy_install.rs`): one process-wide job mutex makes Install, Repair and Update mutually exclusive (RAII guard released on panic). Pre-flight checks disk space, a real Python (the Windows Store `python.exe` stub is filtered out; `winget` installs 3.12 if needed) and git (distro-specific hints on Linux). Then: `git clone` ComfyUI (**at HEAD, no version pin**; an existing checkout is classified and pulled or refused), create a venv, pick a **torch wheel index per GPU** (`torch_wheels.rs`: NVIDIA compute capability → cu130/cu128/cu126 chain; AMD Linux → ROCm 7.2/7.1/6.4 unless the card is known to have no kernels; AMD Windows RDNA3+ → AMD's multi-arch index; otherwise CPU wheels; each index is probed for liveness), `pip install torch torchvision torchaudio` with retries and streamed byte counters, then ComfyUI's `requirements.txt`, then an **import-probe-and-heal** pass (`env_check.rs`: try importing torch, numpy, einops, transformers, safetensors…, reinstall what fails, start probe, GPU runtime probe). Progress is a single status slot `{status, logs[], notice, download_progress}` that the UI polls every 2 s. DirectML is not installed; ComfyUI-Manager is not installed. Everything is cancellable; child processes are tracked and killed as a tree.

**Custom nodes** are installed on demand from the TS registry (git clone or pull, optional pinned commit, requirements installed under a torch constraints file so a node pack cannot downgrade torch), and verified by checking that the required node classes appear in `/object_info` after a restart.

**Launch** (`process.rs`): `main.py --listen 127.0.0.1 --port <port> --enable-cors-header * [--cpu] [--use-flash-attention] --extra-model-paths-config <appdata>/lu_extra_model_paths.yaml`, GPU pinned via `CUDA_VISIBLE_DEVICES` / `HIP_VISIBLE_DEVICES`, stdout and stderr in a 400-line ring buffer used for crash verdicts ("Cannot import … IMPORT FAILED" is parsed out of it). The extra-model-paths file is how a user-chosen "Model Storage" folder is made visible to ComfyUI without copying or symlinks. Status is `running` (answers `/system_stats`) / `starting` / `stalled` (300 s) / `found` (a carcass with `main.py` and torch) / `remote` / `not_ours` / `adoptable` (an orphan ComfyUI started by a previous LU session, recognised by its exact arguments). No `--lowvram` / `--highvram` flags; VRAM is released with `POST /free` after each run. **There is no idle shutdown**; ComfyUI stays up once started and is only stopped on demand (Update, node install) when `/queue` is empty and the process is LU's own.

**Repair** (`comfy_repair.rs`): retire the venv to `venv.lu-old-*`, rebuild with the same torch plan, reinstall "passenger" packages that share the venv (faster-whisper, Piper), re-run every custom node's requirements under constraints, verify, and only then delete the old venv; any failure restores it. Repair is auto-offered after a crash only when a classifier (`pip_failure_kind`) says the environment is at fault (a missing VC++ runtime, for example, is not). **Update** is `git pull --ff-only` plus requirements, with `git reset --hard` rollback on cancel.

**Model files**: downloads land in the subfolder the running ComfyUI reports via `GET /internal/folder_paths` (so a relocated models directory is respected), with sanitised names, `.download` temp files, resume, SHA-256 verification and CivitAI tokens sent only to the CivitAI host. Discovery is always the live `/object_info` enums, never a disk scan. A remote ComfyUI (another machine) is supported: downloads go to a local mirror of the ComfyUI layout and the user is told what to copy.

**Media**: ComfyUI outputs are shown straight from `http://host:port/view?...` in `<img>` / `<video>`; on a CORS 403 the file is refetched through the Rust proxy into a blob URL and the user is offered the CORS fix. Deleting a gallery item moves the file to the Recycle Bin. There is no ffmpeg, thumbnailing or frame extraction on the ComfyUI path; `video.rs` is the Apple-Silicon MLX video runner.

**Lessons**: pin what you depend on (ComfyUI at HEAD and unpinned torch are the two unpinned things in an otherwise careful setup); read folder layout and capabilities from the running instance; classify failures once and reuse the classifier for install, crash and repair decisions; make every status honest (`remote`, `not_ours`, `adoptable`) instead of collapsing them into "running".

---

## 5. Chat and Agent Integration

### 5.1 `image_generate` / `video_generate` tools

Two built-in agent tools (`src/api/mcp/builtin-tools.ts`). Design points visible in the schema:

- A shared `settings` sub-object (steps, cfg, sampler, scheduler, seed, width, height, negativePrompt) plus tool-specific keys (image: `denoise`, `lora` as string or array, `loraStrength`, `vae`; video: `seconds` preferred over `frames`, `fps`). The description tells the model: "Set ONLY what the user asked for", "a value beyond the installed model's real limit is REJECTED with the actual limit, never silently changed", "rate-limit yourself to 1 call per turn, generations serialize internally".
- `inputImage` takes **a filename from an earlier result**, which makes "now animate that" and "edit the image you just made" work as tool chains.
- The tool description sets expectations honestly: "EXPECT A PAUSE: LU may briefly unload the chat model from VRAM… typically a 30–90 s swap".
- `video_generate` does **not** require a prompt (image-to-video works without one; small models omit it), and defaults a gentle-motion prompt.
- The result is a **stable text contract**: `Image generated: <file> (prompt: "...")\n<comfyui /view URL>`. The chat renders any trusted localhost `/view` URL inline (image or `<video>`), and the same string is fed back to the model unchanged. On the Mac path the URL is a `file://` path, never a `blob:` URL (which leaked and died on restart, silently emptying every generated picture out of history).

### 5.2 Plain-chat intent routing

`detectChatToolCapability(text, hasImages)` (`src/lib/chat-tool-intent.ts`) detects, in English and German, whether a message asks for an image, a video, a web lookup or a file write, and only then routes that single turn through the tool executor with a **curated allow-list of five tools** (`web_search`, `web_fetch`, `file_write`, `image_generate`, `video_generate`) and a chat-style prompt. The rationale: exposing every tool on every message "degrades pure conversation and over-triggers small models".

`resolveChatToolRoute` adds **media continuation**: a short follow-up ("again", "2 seconds", "nochmal", "ok go", "zoom in") after a media turn re-routes to the same tool with the previous generation's exact arguments, so "regenerate" is deterministic. Praise or thanks ends the exchange.

### 5.3 VRAM hand-off orchestrator

`vramHandoffGenerate(kind, args, conversationId)` (`src/api/vram-handoff.ts`, 2,500 lines) is the heart of "chat that draws your images" on one GPU:

1. **Decide** (pure, unit-tested): `decideUnload({ textVramBytes, modelFootprintGB, systemVramGB, mode })`. Mode `auto` unloads only when `text + image > VRAM` and all three numbers are known; unknown inputs mean "do not evict on a guess, let a real OOM surface". `always` / `never` override.
2. **Hand off out**: unload the Ollama / LM Studio / bundled-engine model and **poll until it is really gone** before starting ComfyUI (a race here reproduced the OOM it was meant to avoid).
3. **Generate**: ensure ComfyUI is up, build, submit, poll; surface ComfyUI errors verbatim plus a hint.
4. **Hand off back** in `finally`: `POST /free`, then best-effort reload of the chat model, with a grace period and idle timer so a second render does not immediately re-evict.
5. A module-level mutex serialises renders; a per-conversation cancel token lets "Stop" in one chat abort only its own render.

### 5.4 Vision feedback

After `image_generate` succeeds, `buildVisionFeedback` (`src/api/vision-feedback.ts`) fetches the result as base64 and injects a follow-up user message carrying the picture ("Here is the image you just generated… describe what you actually see… if the user asked to turn it into a video, call `video_generate` with `inputImage` set to `<file>`"). It is gated on the model genuinely supporting vision (Ollama `/api/show` capabilities, a declared projector, or a strict name match), with a text-only fallback line so a text model never receives an image payload and errors.

### 5.5 Run lanes

`src/lib/run-lanes.ts` has one rule: cloud runs always start; **local runs are serialised** (one GPU, two concurrent runs just swap weights and both get slower). The lock is held per *visible run* (conversation + identity token), not per provider call, because a parent agent run that waits on a foreground sub-agent would otherwise deadlock on its own lock. Queue position is surfaced in the UI ("waiting for the GPU, position 2").

---

## 6. Cloud Path (LU Labs "Create Studio")

The desktop never calls fal, Replicate or similar directly. It calls one first-party relay (`lu-labs.ai`) with a Supabase JWT; the relay forwards to WaveSpeed and a dozen other providers. What transfers as a pattern:

**Job contract** (`src/api/cloud/jobs.ts`, `studio.ts`):

| Step | Endpoint | Notes |
|------|----------|-------|
| Stage inputs | `POST /api/jobs/upload?role=source\|mask\|train\|audio\|video` | Raw octet-stream body, returns a storage path. |
| Quote | `POST /api/jobs/studio-quote` | Returns `credits` (and estimated seconds). A changed quote is a 409 `quote_changed`. |
| Submit | `POST /api/jobs` `{ kind, model, prompt, params: { op, studio_options, source_path, …, max_credits, client_request_id } }` | Idempotency key; retried up to 3× on 0/408/502/503/504 with the same id, server replays. `count` 1–4 returns `jobs[]`. |
| Poll | `GET /api/jobs/:id` | `status: queued\|running\|succeeded\|failed\|canceled`, `result_url` (signed, ~1 h, re-signed on each GET), `attestation` (TEE receipt), `cost_units`. 2.5 s interval, 15 min default / 45 min for video and training, 5 consecutive failures tolerated. |
| Cancel | `POST /api/jobs/:id/cancel` | Queued cancels refund; 409 means the GPU already took it, keep polling. |
| Quota | `GET /api/jobs/quota` | Limits, used, remaining, video sub-budget, trainings; 429 `code` distinguishes burst guard from `credits_exhausted`. |

**Catalogue and schema-driven UI** (`src/lib/render/`): a live catalogue (`/api/jobs/catalog`) with per-model `kind`, lanes (`edit`, `t2v`, `i2v`, `maskless`, `ops`), clip durations, credits, `tier`, `weights` (open / closed) and an `adult` flag; plus a static registry of 61 "Studio" endpoints, each pointing to a **JSON-schema** entry in `provider-schemas.json` (120 endpoints). `SchemaControl` renders enum → select, number → bounded input (dice for `seed`), boolean → checkbox, `loras` → repeatable rows; media/URL fields are filtered out so a raw POST cannot smuggle foreign URLs. The client validates for the price preview only; the server is authoritative.

**Roles instead of fixed models**: presets name a model per step, but each step carries a *role* (`image`, `animate`, `video`, `reference`, `soundtrack`, `speech`, `talking`, `extend`, `motion`, `restyle`, `edit`, `upscale`, …), and role membership is derived from the schema (image-to-video = video kind whose only required input is `source_path`). The customer can swap any member of the role.

**Safety**: a CSAM gate (minor + sexual conjunction with Unicode/leet/letter-spacing normalisation) runs client-side for UX and server-side as the authority; an adult policy (`strict` / `soft` / `off`) is per account and applies only to hosted rendering.

**Improve prompt**: a small chat call to the user's own chat model with a kind-specific brief (tags for SD 1.5/SDXL/Pony, prose for everything else, present-tense shot description for video), strict rules (keep every subject, never censor, translate to English, answer with the prompt only), 90 s timeout, think-block stripping and refusal detection; the outcome is stored on the gallery item.

---

## 7. iHub Apps Today

| Capability | Status in iHub Apps |
|------------|---------------------|
| Image generation | Only via Google Gemini image models (`supportsImageGeneration`): `server/adapters/google.js` sets `responseModalities: ['TEXT','IMAGE']` and `imageConfig { aspectRatio, imageSize }`; images come back inline with the chat stream. Apps: `server/defaults/apps/image-generator.json`. |
| Controls | Aspect ratio and quality (Low/Medium/High → 1K/2K/4K) per request, model or app (`RequestBuilder.js`, `ImageGenerationControls.jsx`). |
| Image input / editing | Reference images via vision upload (`maxReferenceImages`); editing is "prompt Gemini with the reference". No masks, inpainting, outpainting. |
| Persistence | Generated images are stored as chat artifacts (`chatMaterializer.js` → `ArtifactRepository`), served from `/api/chats/:chatId/artifacts/:id`, rendered lazily by `GeneratedImage.jsx`. Non-durable chats drop them. |
| Tool-based generation | **None.** Tools are JSON definitions dispatched by `server/toolLoader.js`; `imageLiftSeam.js` can already turn a tool result with `imageData` into a vision message. |
| Video generation | **None.** |
| Local / self-hosted diffusion (ComfyUI, A1111, vLLM-omni) | **None.** |
| LoRA, gallery, regenerate / edit-with-mask / animate round-trips | **None.** |
| Planning docs | `concepts/2026-09-27 EU AI Act Content Marking.md` plans C2PA manifests and invisible watermarks for generated images. |

---

## 8. What We Can Learn, and How It Maps to iHub Apps

### 8.1 Media generation as a first-class, provider-agnostic job

LU's single most transferable idea is that image and video generation is an **asynchronous job with staged inputs, a submit/poll/result contract and a gallery entry**, regardless of whether the backend is a hosted API or a local ComfyUI. iHub's current model (image bytes arrive inside a chat completion) cannot carry video, cannot show progress, cannot be cancelled, and ties every capability to one vendor.

Proposed shape for iHub (server-side, Node):

- `MediaGenerationService` with a `MediaProvider` interface: `capabilities(modelConfig)`, `stageInput(file)`, `submit(job)`, `status(jobId)`, `cancel(jobId)`, `result(jobId)`.
- Adapters: **Gemini** (wraps the existing inline path; completes synchronously), **OpenAI `gpt-image`**, **a hosted relay adapter** (fal / WaveSpeed / Replicate style, one class per API family), and **ComfyUI** (section 8.2).
- A job store (the persistence layer already exists) and progress over the existing SSE run channel (`STEP_DELTA` kinds would gain `media_progress`).
- Results land in the existing artifact repository with **reproducibility metadata** (prompt, negative prompt, model, seed, steps, size, duration, LoRAs, provider job id) so a gallery and "regenerate / variations / animate this" become possible.

### 8.2 A ComfyUI provider (the enterprise angle)

iHub is a server product; the natural deployment is **ComfyUI as a sidecar service on an on-prem GPU box**, configured like any other provider in `platform.json` (base URL, optional auth). From LU, take:

- API-format graphs built server-side from **declarative lane templates per model family**, starting with two or three families (SDXL checkpoint, FLUX/Z-Image via UNET + separate encoders, Wan 2.2 for video) rather than LU's thirty.
- **`/object_info` probing** on connect: which nodes, samplers, schedulers and model files exist; expose that as the model's capabilities and parameter ranges; refuse unsupported lanes with an admin-readable reason.
- **Explicit model metadata in iHub's model config** (`family`, `lanes`, companion files) instead of file-name sniffing. Admins know what they installed.
- WebSocket progress forwarded over iHub's SSE; `/history` polling as fallback; activity-based (not wall-clock) timeouts; a serial queue per ComfyUI instance.
- `/upload/image` for sources and masks, `/view` proxied through iHub (never exposed to the browser), outputs copied into the artifact store.
- Error-hint mapping for OOM and missing files, phrased for admins and users separately.

What **not** to carry over: the Python/venv/torch installer, the VRAM hand-off against a chat LLM (iHub's LLMs are remote or served by a separate inference server), and MLX.

### 8.3 Schema-driven parameters

LU renders 120 hosted endpoints from JSON schemas with one generic control component. iHub's model config (`modelConfigSchema.js`) already carries `imageGeneration { aspectRatio, quality, maxReferenceImages }`. Generalise it into a `media` block:

```jsonc
"media": {
  "lanes": ["text-to-image", "image-to-image", "edit", "text-to-video", "image-to-video"],
  "inputs": { "source": "image", "mask": "image" },
  "durations": [4, 6, 8],
  "resolutions": ["720p", "1080p"],
  "options": { /* JSON schema: steps, cfg, seed, negativePrompt, style, … */ },
  "pricing": { /* optional, for a quote */ }
}
```

The client renders `options` generically (as LU's `SchemaControl` does), apps can pin or hide fields, and the server validates against the same schema before calling the provider.

### 8.4 Honest capability handling

Four concrete rules from LU that apply even to the Gemini path:

1. Discover real limits and **reject out-of-range values with the limit**; never silently clamp (the model and the user both learn what is possible).
2. **Map known provider errors to actionable hints** and keep the raw error visible.
3. When something is missing but fixable, **offer the fix in place** (download the VAE, install the node pack, update ComfyUI). For iHub this becomes admin notifications with the exact remediation.
4. **Never show a lane as working when it cannot run** on this deployment; show it locked with the reason or hide it.

### 8.5 Chat integration

iHub already has real tool calling, so the regex intent detector is not needed as the primary mechanism. Three smaller patterns are worth adopting:

- Offer `generate_image` / `generate_video` as **opt-in tools per app** with a schema modelled on LU's (shared `settings` object, `inputImage` referencing an earlier artifact id, `seconds` over frames, prompt optional for image-to-video, honest expectations in the description).
- **Media continuation**: carry the last generation's arguments in the message metadata so "again", "make it 9:16", "animate it" resolve deterministically.
- **Vision feedback**: after a generation, lift the result into the next turn as an image for vision-capable models (iHub's `imageLiftSeam` already does this for tool results with `imageData`), with a text fallback for non-vision models.

### 8.6 Gallery and round-trips

LU's gallery stores every result with its full parameter set and offers "Edit with mask", "Animate", "Extend", "Regenerate", "Use as reference". iHub has the artifact store but no gallery view and no path from a result back into a generation request. A per-user media gallery (filterable by app, lane, model) with these actions is a modest UI addition on top of the job model.

### 8.7 Safety and compliance

Even in an enterprise deployment a **server-side CSAM gate on prompts** is table stakes before any image/video provider is wired in, and an adult-content policy should be per deployment (platform config), not per user. LU's conjunction approach (minor term + sexual term, with Unicode/leet normalisation) is simple and documented. This complements, not replaces, the planned EU AI Act C2PA marking.

### 8.8 Video

Start hosted: Google Veo is reachable through the same Gemini API iHub already speaks, and OpenAI/others expose video endpoints. Model the request as a job from day one (video is never synchronous). Local video (Wan 2.2 5B on 12 GB, LTX 2.5 on 16 GB) comes through the ComfyUI provider later; LU's defaults table and frame-snapping rules are a good reference for the first two families.

### 8.9 Things not to copy

- File-name based model classification as the primary mechanism.
- A single 2,700-line graph builder; split lanes per family from the start.
- Regex intent routing as the main way to reach tools.
- Desktop VRAM juggling, installer and MLX code paths.
- Any code verbatim (AGPL-3.0).

---

## 9. Suggested Phasing

| Phase | Deliverable | Depends on |
|-------|-------------|-----------|
| 0 | Model config `media` block + generic options UI; `generate_image` tool wrapping the Gemini path; reject-with-limit validation; artifact metadata (prompt, seed, params) | nothing |
| 1 | `MediaGenerationService` + job store + SSE progress + cancel; hosted video adapter (Veo); gallery view with regenerate / variations | Phase 0 |
| 2 | ComfyUI provider (SDXL and FLUX text-to-image, image-to-image with mask), `/object_info` capability probing, admin diagnostics | Phase 1 |
| 3 | ComfyUI video (Wan 2.2 / LTX), LoRA selection from the ComfyUI `loras` folder, "animate this image" chain, vision feedback | Phase 2 |
| 4 | Content marking (C2PA) per the EU AI Act concept; per-deployment adult policy; CSAM gate | can run in parallel from Phase 0 |

---

## 10. Appendix: Key Files in Locally Uncensored

| Area | File |
|------|------|
| ComfyUI HTTP client, model classification, defaults | `src/api/comfyui.ts` |
| Graph builder, strategy detection | `src/api/dynamic-workflow.ts` |
| Node catalogue, capability discovery | `src/api/comfyui-nodes.ts`, `src/api/comfyui-enum.ts` |
| Component registry (VAE / encoders per family) | `src/api/component-registry.ts`, `src/api/family-components.ts` |
| WebSocket progress with replay | `src/api/comfyui-ws.ts`, `src-tauri/src/commands/comfy_ws.rs` |
| Graph types and guards | `src/types/comfy-graph.ts` |
| Create hook (local), cloud hook | `src/hooks/useCreate.ts`, `src/hooks/useCloudCreate.ts` |
| Create state, gallery item | `src/stores/createStore.ts` |
| Lanes / intents | `src/components/create/experimental/intents.ts` |
| Agent tools | `src/api/mcp/builtin-tools.ts` |
| Chat intent routing, continuation | `src/lib/chat-tool-intent.ts` |
| VRAM hand-off, error hints | `src/api/vram-handoff.ts` |
| Vision feedback | `src/api/vision-feedback.ts` |
| Fixups (download / update and retry) | `src/lib/render-fixups.ts` |
| Render budget / pace tracker | `src/lib/render-budget.ts` |
| Hi-res fix transform | `src/api/hires-fix.ts` |
| Qwen prompt enhancer | `src/api/qwen-enhancer.ts`, `src/lib/render/improve-prompt.ts` |
| Model bundles, custom node registry | `src/api/model-bundles.ts` |
| LoRA stack rules | `src/lib/lora-stack.ts` |
| Run lanes (local serialisation) | `src/lib/run-lanes.ts`, `src/stores/generationStore.ts` |
| Cloud job API | `src/api/cloud/jobs.ts`, `src/api/cloud/studio.ts` |
| Cloud catalogue, schema UI, roles, pricing | `src/lib/render/cloud-models.ts`, `studio-contract.ts`, `studio-roles.ts`, `preset-models.ts`, `create-presets.ts`, `provider-schemas.json`, `studio-models.json` |
| Safety gate | `src/lib/render/safety.ts` |
| ComfyUI install / repair / custom nodes | `src-tauri/src/commands/install/comfy_install.rs`, `comfy_repair.rs`, `custom_nodes.rs`, `torch.rs` |
| Media / ffmpeg / gallery files | `src-tauri/src/commands/video.rs`, `media_cmds.rs`, `gallery_files.rs` |
