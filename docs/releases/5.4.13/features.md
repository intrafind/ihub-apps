# Features — 5.4.13

## Chat Exports Are Now Protected Against Spreadsheet Formula Injection

CSV and XLSX chat exports now neutralize cell values that would otherwise be interpreted as
formulas by Excel or LibreOffice. Chat transcripts can contain model output or pasted text a user
doesn't fully control, and a value beginning with `=`, `+`, `-`, or `@` (for example
`=HYPERLINK("http://evil","click")`) previously executed as a formula the moment the exported file
was opened.

- Affected cell values are now prefixed with a single quote before being written, which forces
  spreadsheet applications to render them as plain text.
- Applies to both the CSV and XLSX chat export formats; no configuration change is required.

## Admin Tool Script Paths Are Now Validated Against Traversal

The admin Tools API now validates a tool's `script` filename before reading, writing, or deleting
it on disk. Previously a crafted or hand-edited `script` value (e.g. `../../server/server.js`)
could make the read/update/delete script endpoints touch files outside `server/tools/`.

- Reading, updating, or deleting a tool's script now rejects any path that resolves outside
  `server/tools/`.
- Creating or updating a tool now rejects a `script` value that isn't a bare `<name>.js` filename.

## Marketplace Skill Installs Now Use a Stricter Directory Boundary Check

Installing a multi-file skill package from the marketplace now uses the same separator-aware
boundary check as other content installers, closing a gap where a companion filename could
resolve into a sibling directory that merely shared the skill's directory name as a prefix
(e.g. `foo-evil` next to `foo`).

- No admin action required; existing skill packages install exactly as before.

## Realtime Voice Input via Self-Hosted vLLM (Voxtral)

Apps can now use a new speech-to-text backend that streams microphone audio to the iHub
server, which proxies it to a self-hosted vLLM realtime endpoint (for example Voxtral) and
streams the transcription back live. Unlike the browser and Azure backends, the model URL
and any API key stay on the server and never reach the browser.

- Configure the endpoint under **Admin → Voice Input** (or `platform.json` → `speech.realtime`):
  `enabled`, `url`, `model`, optional `apiKey`; disabled by default.
- Enable it per app by setting the app's Speech Recognition Service to **vLLM Realtime**
  (`settings.speechRecognition.service: "vllm-realtime"`) — no per-app host needed.
- Supports both manual (push-to-talk) and automatic (stops when you pause) microphone modes,
  and works in browsers without the Web Speech API (including Firefox). Requires HTTPS or
  localhost for microphone access.
- **Resource guards** protect the GPU-backed upstream: the vLLM socket opens only once the
  browser sends its first audio frame (an abandoned connection never pins a session), idle and
  no-audio connections are closed automatically, and per-user / global concurrent-connection
  caps bound how many sessions can run at once. Tune them under `speech.realtime`:
  `maxConnections` (default 50), `maxConnectionsPerUser` (default 3), `maxFrameBytes`
  (default 256 KB).

## Admin Page for Voice Input (Speech-to-Text)

A new **Admin → Voice Input** page centralizes speech-to-text backend configuration, so
admins no longer need to edit `platform.json` by hand.

- **vLLM Realtime**: toggle, WebSocket URL, model, and an optional API key (stored encrypted
  at rest).
- **Azure Speech**: toggle, default host/endpoint, region, and the subscription key. The key is
  stored **encrypted at rest** on the server and exchanged for a short-lived authorization token
  per session (`/api/voice/azure/token`), so it never reaches the browser. Apps that select
  Azure without their own host fall back to the platform default host.
- The app editor's **Speech Recognition Service** dropdown now also lists Azure alongside the
  browser default, vLLM Realtime, and custom options.

> **Breaking change:** The Azure subscription key is no longer read from the
> `VITE_AZURE_SUBSCRIPTION_ID` build-time client env var (which baked the key into the browser
> bundle). Move the key into **Admin → Voice Input** (`platform.json` → `speech.azure.subscriptionKey`).
> Existing deployments that relied on the env var must set the key server-side for Azure to keep
> working.

## Outlook Add-in: Manifest Download Restored

Downloading the Outlook add-in manifest works again. The manifest endpoint had started returning a
server error, which blocked installing or sideloading the add-in.

- The generated manifest now uses the correct localized add-in name, task-pane button label, and
  description, with English defaults and German (`de-DE`) overrides.
- No admin action is required — the fix takes effect automatically on upgrade.
