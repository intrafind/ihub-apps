# Features — 5.4.24

## Refreshed Default Models and Gemini Transcription

The shipped model catalog now matches the current lineups from Google, Anthropic and Mistral, and
two Google-hosted speech-to-text models join the self-hosted Voxtral option.

- **Anthropic.** Claude Opus 5, Claude Sonnet 5 and Claude Fable 5.1 are shipped as default model
  configurations, and Claude Haiku 4.5 is described correctly. The retired `claude-4-opus` and
  `claude-4-sonnet` entries are removed. These models reject the `temperature` parameter, which
  previously meant every request to them failed with a `400`; a new *Supports Temperature* model
  setting tells the Anthropic adapter to omit it, and it is preset on the models that need it.
- **Google.** Gemini 3.8 Flash and Gemini 3.5 Flash Lite are added, Gemini 3.1 Pro is kept as the
  most capable Gemini, and the image models are renamed to the Nano Banana line they belong to
  (Nano Banana Pro, Nano Banana 2, and the new Nano Banana 2 Lite). The image models' preview
  endpoint ids are promoted to their stable releases.
- **Mistral.** Mistral Large, Medium and Small now describe the current generations (Large 3,
  Medium 3.5, Small 4) with their real 256K context window and their vision and structured-output
  capabilities.
- **Gemini transcription.** Two new transcription models: **Gemini 3.5 Transcribe Live** streams a
  transcript as the audio arrives (85+ languages with automatic detection and code-switching,
  sessions up to 10 minutes), and **Gemini 3.5 Transcribe** transcribes complete recordings of up
  to one hour in a single request, with an optional custom vocabulary of up to 1,000 domain terms.
  Both ship **disabled** — enabling one sends user audio to Google — and both reuse the Google API
  key the chat models already use. Everything in the product that already worked with Voxtral
  (audio upload, video upload, browser recording) works with them unchanged.
- **Retired defaults removed.** `gpt-4` (8K context) and `gpt-oss-vllm` are gone. The latter
  shipped enabled and pointed at a private development host, so it appeared in every
  installation's model selector and failed on use. `local-vllm` is now shipped disabled, as the
  endpoint template it is.

Existing installations are migrated on upgrade: retired model files are removed, apps that
referenced one are repointed to its replacement, and the new models are added. A model file you
customized is never deleted — it is disabled instead, and the reason is written to the server log.

## Native Web Search: Per-Model Settings, Search Cap, Usage Tracking and Visible Sources

Native web search on Claude, Gemini and GPT models is now configurable per model, capped per
answer, tracked in the usage statistics, and its sources are shown to the user.

- **Sources under the answer.** Chat answers grounded by a provider-run web search show a
  collapsible *Sources* list with the cited pages (title, site and cited passage), next to the
  existing "Grounding" badge.
- **Search cap.** A new *Max Searches per Answer* setting on the app's web search card (default 5)
  caps how many searches Claude may run for one call; workflow prompt nodes have the same setting
  (*Max Web Searches*). Anthropic bills each search, so the cap bounds the cost of a research
  prompt. Existing apps with web search get the default written into their configuration on
  upgrade.
- **Per-model settings.** Model configurations for Anthropic, Google and OpenAI Responses models
  gain a *Native Web Search* section: turn native search off for a model (it then uses Brave
  Search), and for Claude choose the web search tool version — including the newer versions with
  dynamic filtering on Claude 4.6 and later — with direct calls as the safe default.
- **Usage tracking.** The billable search count is recorded per call, in the run log and in the
  admin usage statistics per app, model and user.

## Optional: Log Out of the OIDC Provider Too (RP-Initiated Logout)

Logging out of iHub clears iHub's own session. The OIDC provider's browser SSO session is separate
and stays active, so the next login can be answered from it without a credential prompt. That is
how SSO is meant to work across applications — but on a shared or kiosk device it means the next
person to click "Log in" is signed in as whoever logged out before them.

Deployments that would rather trade the SSO convenience for a real login prompt can now opt in per
provider. Nothing changes for a provider that leaves the field unset.

- Set **Logout URL** on a provider in Admin → Authentication to the provider's
  `end_session_endpoint` (RP-Initiated Logout, per the OIDC spec). For Keycloak:
  `{issuer}/protocol/openid-connect/logout`. See the OIDC Authentication guide for Entra ID, Auth0
  and ADFS endpoints. Google has no such endpoint and cannot be logged out this way.
- The admin page then shows the exact post-logout redirect URI to register at the provider — in
  Keycloak, under the client's **Valid post logout redirect URIs**. Without that entry the browser
  isn't sent back to iHub after logging out; iHub's own session is cleared either way.
- **Post-Logout Redirect URL** overrides that URI for providers that match it exactly, or when iHub
  is reachable under several hostnames.
- Embedded hosts (the Nextcloud and Office add-ins, the browser extension) keep logging out
  locally: an identity provider's logout page can't render inside an add-in frame.
