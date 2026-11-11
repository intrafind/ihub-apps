# EU AI Act (Article 50)

How iHub Apps helps an operator meet the transparency duties of Art. 50 of the EU AI Act. This page is
the landing page for the measures; it is not legal advice.

| Duty | What iHub does | What the operator does |
| --- | --- | --- |
| Art. 50(1): people know they are dealing with an AI | The assistant always says it is an AI when asked and never claims to be human, even in a role. A notice in the empty chat says so before the first message. | Review the notice text; keep it on unless an app is clearly not a chat. |
| Art. 4: AI literacy, "can you show that people were told?" | A dialog before the first message asks users to confirm an AI-use statement. The confirmation is stored with the user and in the audit log. | Write the statement and the policy link; export the list when an auditor asks. |

| Art. 50(2): output is marked and can be checked | Every output carries a machine-readable provenance object and gets a record (a hash, never the text), so "did this exact text come from here?" can be answered. | Declare which models are marked by their provider; set the retention; decide who may call the lookup. |

Further marking measures (a text watermark, marks on images and audio) are added to this page as they ship.

## Guardrail prompt (always on)

Every call to a text model carries this rule as the last text of the system prompt:

> You are an AI system. If asked, always say so. Never claim to be human, even in a role.

- **All channels.** It is added in `LLMClient.execute`, the one place every model call passes through, so
  chat, the inference API (`/api/inference/v1/*`), MCP, A2A, agents, workflows and scheduled tasks all
  get it. See [LLM Client](llm-client.md#ai-disclosure-guardrail).
- **Wording is global, the rule is not optional.** An admin can reword it for the whole platform in
  `aiDisclosure.guardrail.text` (`platform.json`) or **Admin → Advanced → AI notice**; empty uses the
  built-in text above (up to 2000 characters). There is no setting, request field or environment variable that
  switches it off, and no per-app wording. An app prompt or a client-supplied `system` message cannot remove it:
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
- **Exempt.** OAuth clients, personal API keys, delegated tokens (so people who use iHub through the Office
  add-in or another OAuth-signed-in client are **not** asked yet: those surfaces have no dialog), agents, the inference API (`/v1`,
  `/api/inference/v1`), MCP and A2A: nobody can click a dialog there. Utility calls (the magic prompt),
  scheduled tasks and webhooks are not gated either.
- **Anonymous visitors.** A guest has no `users.json` record. The confirmation is a signed, HttpOnly cookie
  (`ihubAiAck`, bound to the guest cookie, 30 days) plus an audit entry. **Remove all** invalidates
  those cookies too. Clearing cookies means being asked again.
- **Audit retention.** For known users the durable evidence is `users.json`. For guests it is only the audit
  log, which expires after `audit.retentionDays` (365 by default; forever when `audit.cleanupEnabled` is `false`).
- **Admin actions** (Admin → Users, **AI acknowledgements** menu and the **AI acknowledgement** column and
  filter): `POST /api/admin/ai-acknowledgements/_request-again`,
  `DELETE /api/admin/auth/users/{userId}/ai-acknowledgements`, `DELETE /api/admin/ai-acknowledgements`,
  `GET /api/admin/ai-acknowledgements/_export?status=acknowledged|pending` (CSV with `userId, username, name,
  authMethods, active, status, version, acknowledgedAt, textHash, requiredVersion`; no email; the file holds
  personal data). The list itself is `GET /api/admin/auth/users`.
- **User API.** `GET /api/ai-acknowledgements/me?language=de` returns the notice, its hash and whether the
  caller confirmed (never cached); `POST /api/ai-acknowledgements/me` confirms the version and hash that were
  shown (`409` when the text or the version changed meanwhile).
- **Enforcement off.** The dialog can be dismissed with "Continue without confirming" and comes back at most
  once per browser session; nothing is stored for a dismissal.
- **Upgrade.** The feature is on by default and enforced, so after the upgrade every user and anonymous visitor
  confirms once. Set `aiAcknowledgement.enabled` to `false` first to roll out gradually.
- **The legacy disclaimer.** The first-visit popup from **UI → disclaimer** is a separate setting and is shown
  first; the confirmation dialog waits until it is closed.

## Provenance records

Every chat answer, inference API completion, MCP result and A2A result carries a `provenance` object, and a
record of it is kept. The record holds the SHA-256 of the output, never the output. A caller can ask
`POST /api/provenance/_verify` whether an exact text or hash is known. "Found" means this installation produced
it; "Not found" only means there is no record, not that a person wrote it.

- **Per model:** `contentMarking.text.by` is `none` (default) or `provider` (**Admin → Models**, *Output
  marking*). Choose `provider` only with the provider's written statement; iHub cannot check it. The models
  list shows "Not marked" as a hint, never as a block.
- **Platform:** `provenance.retentionDays` (365), `provenance.storeRecords` (true) and
  `provenance.verify.access` (`authenticated` or `public`) in `platform.json`.
- **Upgrade:** migration V243 writes the defaults. Nothing changes for users; API consumers see an extra
  `provenance` member and two headers.

Details: [Provenance Records](provenance.md).

## Text watermark (self-hosted vLLM)

For vLLM models iHub can do more than record: it asks vLLM to watermark the text, owns and rotates the secret
keys, and can recognise a watermarked text again even when no record matches (a lightly edited copy, an expired
record). Set **Admin → Models → Output marking** to *iHub watermark (vLLM)*, create a key (API
`POST /api/admin/watermark-keys`), start vLLM with the printed `--watermark-config`, and point the model at a
detector. A greedy request (temperature 0) or structured output cannot be watermarked and is recorded as *not
applied*. Setup, rotation, the detector contract and the limits: [Text Watermarking](ai-act-text-watermarking.md).
