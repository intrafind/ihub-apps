# EU AI Act (Article 50)

How iHub Apps helps an operator meet the transparency duties of Art. 50 of the EU AI Act. This page is
the landing page for the measures; it is not legal advice.

| Duty | What iHub does | What the operator does |
| --- | --- | --- |
| Art. 50(1): people know they are dealing with an AI | The assistant says it is an AI when asked and never claims to be human, even in a role. A notice in the empty chat says so before the first message. | Review the notice text; keep it on unless an app is clearly not a chat. |
| Art. 4: AI literacy, "can you show that people were told?" | A dialog before the first message asks users to confirm an AI-use statement. The confirmation is stored with the user and in the audit log. | Write the statement and the policy link; export the list when an auditor asks. |

| Art. 50(2): output is marked and can be checked | Every output carries a machine-readable provenance object and gets a record (a hash, never the text), so "did this exact text come from here?" can be answered. | Declare which models are marked by their provider; set the retention; decide who may call the lookup. Generated images keep the provider's own marks (C2PA, SynthID) untouched, are recorded, and can be checked by upload; see [Provenance Records](provenance.md#images-provider-marks-3328). |

One audited master switch turns all of these features off; see [Switching the features off](#switching-the-features-off).

Further marking measures are added to this page as they ship.

## Guardrail prompt

Every call to a text model carries this rule as the last text of the system prompt:

> You are an AI system. If asked, always say so. Never claim to be human, even in a role.

- **All channels.** It is added in `LLMClient.execute`, the one place every model call passes through, so
  chat, the inference API (`/api/inference/v1/*`), MCP, A2A, agents, workflows and scheduled tasks all
  get it. See [LLM Client](llm-client.md#ai-disclosure-guardrail).
- **Wording is global, the rule is not optional.** An admin can reword it for the whole platform in
  `aiDisclosure.guardrail.text` (`platform.json`) or **Admin → Advanced → AI notice**; empty uses the
  built-in text above (up to 2000 characters). There is no app setting, request field, environment variable or
  per-feature switch for it, and no per-app wording. The only way to turn it off is the audited
  [master switch](#switching-the-features-off), which records who, when and why. An app prompt or a client-supplied `system` message cannot remove it:
  the rule is appended after them. A reworded rule still has to say that the assistant is an AI and never
  claims to be human; iHub does not check that.
- **iAssistant.** The `iassistant-conversation` provider does not use iHub's system message (its adapter
  sends only the last user message), so the rule does not reach it that way; iAssistant handles its own
  disclosure.
- **A reduction, not a guarantee.** A model can still ignore a prompt rule in a strong role-play. Check
  the models you use with the question "Are you a human?".

## First-turn notice

A short text in the empty chat, above the message box: *You are chatting with an AI system, not a person.
Answers can be wrong, so please check important information.*

- It is interface only: never a message, never sent to the model, never stored. A stored chat with
  messages does not show it; an empty chat shows it again.
- **Platform:** `aiDisclosure.firstTurnNotice` in `platform.json`, or **Admin → Advanced → AI notice**.
  `enabled: false` hides it in every app. `text` is `{ "en": "…", "de": "…" }`; an empty map uses the
  built-in text in the user's language. Inline Markdown (links) is allowed.
- **Per app:** `aiDisclosure.firstTurnNotice` in the app, or the *AI notice* section of the app editor:
  use the platform notice (no key), a custom `text`, or `enabled: false` for this app. The platform switch
  wins: an app cannot turn the notice on when the platform has it off.
- **Shown in:** the app chat (also above a start form). Not shown for apps that start by themselves
  (`autoStart`), in the Office add-in panel, in compare mode or for `iframe` and `redirect` apps; the guardrail applies to
  all model calls regardless.

```json
{ "aiDisclosure": { "firstTurnNotice": { "enabled": true, "text": { "en": "You are talking to an AI." } } } }
```

## AI-use acknowledgement

Before their first chat message, users confirm a short statement about using AI. It is the evidence
that people were told, not a legal opinion: the wording is yours.

- **Platform:** `aiAcknowledgement` in `platform.json`, or **Admin → Advanced → AI acknowledgement**.
  `enabled` switches the whole feature, `enforce` decides whether the server refuses messages without
  a confirmation (`true`, the default) or the dialog only asks (`false`). `text` is `{ "en": "…", "de": "…" }`
  in plain text (never HTML); `policyUrl` is an `https://` URL or a `/path`, shown as a link in the dialog.
- **Versioning.** A confirmation is valid when the user confirmed a version at or above
  `requiredVersion`. Editing the text never asks anyone again; **Request again** raises the version by one
  and everybody is asked at their next message. `requiredVersion` and `resetAt` are written only by the
  admin actions, never by a settings save.
- **What is stored.** On the user in `users.json`: `aiAcknowledgements: [{ version, textHash,
  acknowledgedAt, language }]`, one entry per version. `textHash` is the SHA-256 of the exact text the user
  saw in that `language`. It proves that a stored text is the one that was shown, but it cannot bring back wording that was changed or removed: keep a copy of each version's text (for example in your change history) if you need to show it later. Every confirmation
  and every admin action is also an audit entry (`resource: aiAcknowledgement`).
- **Enforcement.** One middleware answers `428` with `code: AI_ACKNOWLEDGEMENT_REQUIRED`
  (`application/problem+json`) before any side effect on: the chat message
  (`POST /api/apps/{appId}/chat/{chatId}`), starting a workflow (`POST /api/workflows/{id}/execute`) and its
  chat step (`POST /api/workflows/executions/{executionId}/chat/{appId}`), restarting a workflow execution (`POST /api/workflows/executions/{executionId}/_restart`), and starting
  or resuming an agent run (`POST /api/agents/profiles/{profileId}/runs`, `POST /api/agents/runs/{runId}/_resume`). The web app asks first, so a 428 only shows up for a stale
  tab or after **Request again**; it then re-opens the dialog and sends the message once more.
- **Exempt.** OAuth clients (client credentials), personal API keys, agents, delegated tokens of any
  other OAuth client, the inference API (`/v1`, `/api/inference/v1`), MCP and A2A: nobody can click a dialog
  there. Utility calls (the magic prompt), scheduled tasks and webhooks are not gated either. The three
  first-party clients below are **not** exempt.
- **Client integrations.** Every surface a person types a prompt into asks once and records on the same
  per-user record, so one confirmation counts in all of them (the Outlook pane re-reads the state before it
  opens the dialog and when it regains focus, so a confirmation made in the web app is picked up).

  | Surface | Signs in with | Asked | Enforced (`428`) |
  | --- | --- | --- | --- |
  | Web app, Teams tab, `?embed=true` frames | cookie / SSO session | yes | yes |
  | Outlook add-in (task pane, pop-out window) | OAuth code + PKCE, client `officeIntegration.oauthClientId` | yes | yes |
  | Browser extension side panel | same, `browserExtension.oauthClientId` | yes | yes |
  | Nextcloud embed | same, `nextcloudEmbed.oauthClientId` | yes | yes |
  | Microsoft 365 Copilot agent, MCP, A2A, personal API keys, client credentials, inference API | token / key | no | no |

  The three first-party clients are recognised by the client ids stored in `platform.json`; no other OAuth
  client is treated as a person, and there is nothing to configure. Before this was added they counted as
  delegated tokens and were exempt, so users there were neither asked nor recorded. A user who only uses
  Copilot and never opens one of the surfaces above is not asked. The entry records which first-party client
  the confirmation came from (`client: office | extension | nextcloud`, read from the token, absent for the
  web app and Teams). Anonymous guests exist only in `?embed=true` frames; see
  [Embed Mode](embed-mode.md#ai-use-acknowledgement).
- **Anonymous visitors.** A guest has no `users.json` record. The confirmation is a signed, HttpOnly cookie
  (`ihubAiAck`, bound to the guest cookie, 30 days) plus an audit entry. **Remove all** invalidates
  those cookies too. Clearing cookies means being asked again.
- **Audit retention.** For known users the durable evidence is `users.json`. For guests it is only the audit
  log, which expires after `audit.retentionDays` (365 by default; forever when `audit.cleanupEnabled` is `false`).
- **Admin actions** (Admin → Users, **AI acknowledgements** menu and the **AI acknowledgement** column and
  filter): `POST /api/admin/eu-ai-act/acknowledgements/_request-again`,
  `DELETE /api/admin/eu-ai-act/users/{userId}/acknowledgements`, `DELETE /api/admin/eu-ai-act/acknowledgements`,
  `GET /api/admin/eu-ai-act/acknowledgements/_export?status=acknowledged|pending` (CSV with `userId, username, name,
  authMethods, active, status, version, acknowledgedAt, textHash, requiredVersion`; no email; the file holds
  personal data). The list itself is `GET /api/admin/auth/users`.
- **User API.** `GET /api/eu-ai-act/acknowledgements/me?language=de` returns the notice, its hash and whether the
  caller confirmed (never cached); `POST /api/eu-ai-act/acknowledgements/me` confirms the version and hash that were
  shown (`409` when the text or the version changed meanwhile). `policyUrl` is always absolute (a `/path` is
  resolved against the public address, base path included, so it opens from the extension too) and `appUrl`
  is the public address of iHub.
- **Enforcement off.** The dialog can be dismissed with "Continue without confirming" and comes back at most
  once per browser session; nothing is stored for a dismissal.
- **Upgrade.** The feature is on by default and enforced, so after the upgrade every user and anonymous visitor
  confirms once, and so does every Outlook, extension and Nextcloud user at their next message. Set `aiAcknowledgement.enabled` to `false` first to roll out gradually.
- **The legacy disclaimer.** The first-visit popup from **UI → disclaimer** is a separate setting and is shown
  first; the confirmation dialog waits until it is closed.

## Switching the features off

An admin can turn every EU AI Act feature of iHub off with one switch on **Admin → EU AI Act**. This is for
deployments where the measures do not apply (internal-only tools, non-EU operation, research sandboxes). The
switch is deliberate and attributable: the person, the time and a written reason are stored on the server.

> **Legal note (draft wording, [LEGAL] pending legal review, not legal advice).** Regulation (EU) 2024/1689
> places transparency duties on providers and deployers of AI systems according to their role and use. Turning
> these measures off does not remove those duties. By turning them off you confirm that you have assessed that
> they are not required for your use of this system, or that you meet them in another way, and that you accept
> responsibility for this decision. Your name, the time and your reason are stored on this server and in the
> audit log.

- **Who.** An admin in an interactive session. Personal API keys, OAuth client tokens, delegated tokens and agents
  get `403 INTERACTIVE_SESSION_REQUIRED`. The name comes from the session, never from the request.
- **How.** Switch off needs a reason of 20-1000 characters and `acceptResponsibility: true`; switch on takes an
  optional note. A second switch to the state the server is already in is a `409`, so two admins clicking at once
  leave one record.
- **What stops.** The guardrail rule in prompts, the first-turn notice, the acknowledgement dialog and the `428`
  enforcement, provenance records and the `provenance` member and `X-AI-*` headers on every channel, the text
  watermark flag to vLLM, image marking and records, `POST /api/eu-ai-act/provenance/_verify` (answers `403
  FEATURE_DISABLED`), the detector test and self-test (same answer) and the configuration check (no probes).
  Runtime paths skip silently; nothing errors for a user or a machine caller.
- **What stays.** Acknowledgements already given, provenance records already written, watermark keys and their
  management, all settings and texts (they stay editable but have no effect), the retention sweep, the CSV
  export of acknowledgements and the history of the switch. While off, the admin actions that delete or reset
  acknowledgements (remove one, remove all, request again) answer `403 FEATURE_DISABLED`.
- **Switching on again.** Everything resumes with the saved settings. Acknowledgements that are still valid stay
  valid; only users without a valid one are asked, at their next message. `requiredVersion` is not changed.
  Outputs from the off period have no provenance; the history is the statement of that gap.
- **Where it is stored.** `contents/config/eu-ai-act-conformity.json`, its own file, not `platform.json`: a
  generic settings save or an `IHUB_*` override cannot flip it or erase the record. The record holds the current
  state, who, when, why and the last 100 switches. A file that says "off" without a complete record (who, when,
  why) is treated as **on**. Every switch also writes one `toggle` audit entry (`resource: euAiActConformity`);
  that is the only notification. No end user sees a hint.
- **API.** `GET /api/admin/eu-ai-act/conformity`, `POST /api/admin/eu-ai-act/conformity/_disable`, `POST
  /api/admin/eu-ai-act/conformity/_enable` (the API says `conformity`, the UI says "EU AI Act features").
  `GET /api/configs/platform` carries `euAiAct: { enabled }`, never who or why.
- **vLLM keeps watermarking if you started it that way.** A vLLM server started with `--watermark-config` and
  `"enforce": true` marks every output regardless of iHub. Restart vLLM without that option to stop marking at
  the source.
- **Backups.** A backup restore replaces `contents/`, including this record.

## Provenance records

Every chat answer, inference API completion, MCP result and A2A result carries a `provenance` object, and a
record of it is kept. The record holds the SHA-256 of the output, never the output. A caller can ask
`POST /api/eu-ai-act/provenance/_verify` whether an exact text or hash is known. "Found" means this installation produced
it; "Not found" only means there is no record, not that a person wrote it.

- **Per model:** `contentMarking.text.by` is `none` (default) or `provider` (**Admin → Models**, *Output
  marking*). Choose `provider` only with the provider's written statement; iHub cannot check it. The models
  list shows "Not marked" as a hint, never as a block.
- **Platform:** edit these in **Admin → EU AI Act → Provenance settings** (see below) or in `platform.json`.
  Defaults and bounds (the form and the server refuse values outside them):

  | Setting | Default | Allowed | Meaning |
  |---|---|---|---|
  | `provenance.retentionDays` | 365 | 0 to 36500 | Days records are kept; 0 keeps them forever. |
  | `provenance.storeRecords` | true | on/off | Off still attaches the provenance object but keeps no record. |
  | `provenance.verify.access` | `authenticated` | `authenticated`, `public` | Who may call `POST /api/eu-ai-act/provenance/_verify`. |
  | `provenance.media.maxVerifyBytes` | 52428800 (50 MiB) | 1024 bytes to 1 GiB | Largest uploaded file; the form shows MiB. |
  | `provenance.media.readC2pa` | true | on/off | Read C2PA marks of images. |
  | `provenance.watermark.alpha` | 0.0001 | above 0, below 1 | False-positive limit of the text detector. |
  | `provenance.watermark.minScoredTokens` | 200 | 1 to 100000 | Shorter texts are "too short to tell". |
  | `provenance.watermark.detectorTimeoutMs` | 15000 | 1000 to 120000 | Wait for a detector. |

  All of them apply at once; no restart is needed. The watermark tunables are optional: empty in the form
  removes the key and the default applies.
- **Upgrade:** migration V243 writes the defaults. Nothing changes for users; API consumers see an extra
  `provenance` member and two headers.

Details: [Provenance Records](provenance.md).

## Text watermark (self-hosted vLLM)

For vLLM models iHub can do more than record: it asks vLLM to watermark the text, owns and rotates the secret
keys, and can recognise a watermarked text again even when no record matches (a lightly edited copy, an expired
record). Set **Admin → Models → Output marking** to *iHub watermark (vLLM)*, create a key (API
`POST /api/admin/eu-ai-act/watermark-keys`), start vLLM with the printed `--watermark-config`, and point the model at a
detector. A greedy request (temperature 0) or structured output cannot be watermarked and is recorded as *not
applied*. Setup, rotation, the detector contract and the limits: [Text Watermarking](ai-act-text-watermarking.md).

## Admin page

**Admin → EU AI Act** (`/admin/eu-ai-act`) is the one place to see and operate the measures above. Five cards:

- **Configuration check.** One row per check with a level (OK, Attention, Failing) and a link to where it is fixed.
  The server decides every level (`GET /api/admin/eu-ai-act/status`, admin only, never a key or token). Failing is
  reserved for the watermark chain of models marked "iHub" (no active key, detector missing, rejected or
  unreachable, last self-test failed); a model that is not marked, a provider mark without a statement, the
  notice or acknowledgement being off, or records not being stored is Attention. A retention of 0 means "kept
  without limit" and is OK. Detectors are probed with a throwaway key (3 s timeout, cached 30 s; *Check again*
  probes again) through the SSL whitelist and proxy. **Green means "configured as designed", not "legally
  compliant".** Disabled models are not checked.
- **Acknowledgements.** Counts for registered users and the same actions as the Users page (shared component).
- **Watermark keys.** Generate, add, reveal, delete retired keys and **Make active** on a retired key
  (rollback, for example when vLLM was not updated in time). Making a key active retires the current one,
  asks you to update vLLM's `--watermark-config` (the printed option can be shown again, which is audited) and
  until then the self-test shows a mismatch. Per model: test connection and self-test (about 400 tokens). The last
  self-test result is kept per model; after a key change it shows as outdated until run again. Detector URL and
  credential are edited in the model editor.
- **Provenance settings.** The settings of the table above as a form, with defaults and units next to each
  field. The save validates on the client and the server with the same bounds and merges into `platform.json`,
  so keys the form does not own are kept. Lowering the retention (records older than the new limit are deleted
  at the next daily clean-up, irreversibly) and changing who may check outputs ask for a confirmation that names
  the consequence. Every change is written to the audit log (resource `provenanceSettings`, old and new values),
  and the configuration check refreshes after saving.
- **Verification.** Text or image/audio upload against `POST /api/eu-ai-act/provenance/_verify`. Rows: output record, watermark
  (text), C2PA (media), SynthID "declared, not detectable". Too short or detector unreachable is "no conclusion",
  never "not watermarked".

The other two platform settings of this feature have forms of their own on **Admin → Advanced**: the first-turn
notice (`aiDisclosure`) and the AI-use acknowledgement (`aiAcknowledgement`).

Image marking is declared per model in the model editor (*Image marking*, shown for image-generating models).

