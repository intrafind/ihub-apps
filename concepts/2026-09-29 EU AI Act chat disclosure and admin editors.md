# EU AI Act — chat disclosure, provenance chip and admin editors (client)

**Date:** 2026-09-29
**Status:** Implemented (client), part of epic intrafind/ihub-apps#2563 — sub-issues #2564 (Art. 50(1) disclosure) and #2565 (marking / admin)
**Parent concept:** `concepts/2026-09-27 EU AI Act Content Marking.md` (§2.3, §6 items 1–3 and 9, §8.2)

This note explains the client side of the Art. 50 transparency work so that anyone can pick it up. The server side (config, provenance records, admin endpoints) already existed when this was written. Its contract is summarised in the parent concept and in `server/services/provenance/clientConfig.js` and `server/routes/admin/aiTransparency.js`.

---

## 1. What the user sees

| Where | What | Component |
|---|---|---|
| Empty chat, before the first message | Notice "You are chatting with an AI system … — check important information." It names the operator when `provider.legalEntity` is set; an app can use its own text instead (`aiTransparency.firstTurnNotice`). It cannot be dismissed. | `features/chat/components/AIInteractionNotice.jsx`, rendered by `AppChat.jsx` (`renderInteractionNotice`) |
| Row below the chat input (every surface that renders `ChatInput` with an `app`, including the start page) | "AI" pill with a tooltip and screen-reader text | `AIInteractionBadge.jsx`, placed by `ChatInput.jsx` |
| Every finished assistant answer | "AI generated" chip. Clicking it opens the second layer: model, time, marking status, content id, "Verify content" → `/verify` | `AIProvenanceChip.jsx`, placed by `ChatMessage.jsx` next to `AnswerSourceBadge` |
| Below every Nth answer of a *sensitive* app | Reminder "you are talking to an AI system, not a person…" | `AIReminderNotice.jsx`, placed by `ChatMessageList.jsx` |
| Generated images | "AI generated · Content Credentials", with the markings in the tooltip and as screen-reader text | `GeneratedImage.jsx` (`ImageAiLabel`) |
| Shared chats (`/share/:id`) | AI label at the top with a "Verify" link, plus the per-message chip | `SharedChatPage.jsx` (`SharedChatAiLabel`) |
| Outlook add-in: reply / forward / new / insert | Small grey paragraph at the top: "AI-generated with iHub Apps — please review before sending." | `office/utilities/outlookMailActions.js` (`withAiLabel`), label text from `office/hooks/useOutlookMailActions.js` |

All decisions about *whether* something shows are pure functions in `client/src/features/chat/utils/aiTransparency.js`. Components only render. When a rule changes, change that file and its tests (`tests/unit/client/chat-ai-transparency.test.jsx`).

### Rules in one place

- The disclosure is **active** when `platformConfig.aiTransparency.interactionDisclosure.enabled` is true **and** `app.aiTransparency.disclosure !== false`. The server already folds the feature flag and the platform switch into `enabled`, and sets `disclosure: false` only for an opt-out made on *this* installation.
- First-turn notice: active **and** `interactionDisclosure.firstTurnNotice`.
- Badge: active **and** `interactionDisclosure.persistentBadge`.
- Chip: `labels.messageBadge`.
- Reminders: active **and** `app.aiTransparency.sensitive` is a known category **and** the interval is greater than 0. The interval is `app.aiTransparency.reminderInterval`, or `interactionDisclosure.reminderInterval` when the app sets none. Greetings and error messages do not count as answers. An answer that is still streaming counts, but its reminder appears only once it has finished. Reminders are computed at render time and never stored.
- The shared-chat top label is **fail-safe**: it is shown unless `aiTransparency.enabled === false`, so a public page never loses it just because the config has not loaded yet.

### Where the data comes from

- `platformConfig.aiTransparency`: `PlatformConfigContext.jsx` assembles its object by hand, so `aiTransparency` had to be added there explicitly. The Office task pane has no such provider; see §4.
- `message.provenance`, live: the server sends it on the SSE v2 `run/ended` event. `shared/run/runReducer.js` stores it on the run (`run.provenance`), and `features/chat/runToMessage.js` projects it into `extras.provenance`, which `useAppChat` writes onto the message.
- `message.provenance`, stored: `transformStoredMessage` in `features/chat/hooks/useChatMessages.js` copies it through. `getMessagesForApi` strips it, because the server never takes provenance back from the client.
- Image provenance: taken from `image.provenance` (both the live SSE payload and the stored artifact descriptor carry it). For older transcripts it falls back to `message.provenance.images`, matched by `sha256`, then content id, then position (`findImageProvenance`).

---

## 2. What the admin sees

### App editor (`AdminAppEditPage` → `AppFormEditor` → `app-form/AiTransparencySection.jsx`)

- **Records** (disclosure opt-out, exemption). Only full admins (`user.isAdmin || user.permissions.adminAccess`) can change them, and every change needs a written reason. They go through the audited endpoints `PUT/DELETE /admin/ai-transparency/apps/:id/disclosure-opt-out` and `…/exemption`, **never** through the normal app save. After a change the app is re-read and only the records are merged into both the edited app and the saved baseline (`applyAiTransparencyRecords`), so the admin's unsaved edits survive and nothing is flagged as dirty. Content admins see the records read-only. A record whose `installationId` differs from this installation's id (read from `GET /admin/ai-transparency/settings`) is flagged as "not in effect here".
- **Plain settings** are saved with the app as usual: `sensitive`, `reminderInterval`, `firstTurnNotice` (localized, uses `DynamicLanguageEditor`) and `signpost.exports` / `signpost.clipboard` (each can follow the platform default or be forced on or off).
- **Save**: `cleanAppData` runs `cleanAppAiTransparencyForSave` first. It strips the records, empty notice languages and empty objects.

### Downloads

App downloads (`AdminAppsPage.downloadAppConfig`, the editor's Download button) and model downloads (`AdminModelsPage.downloadModelConfig`, the model editor's Download button) go through `serializeConfigForDownload(kind, config)`. That function uses `stripInstallationRecords` from `shared/aiTransparency.js`. Cloning a model also drops the acknowledgement.

### Models list and model editor

- `AdminModelsPage` shows a "Not marked" badge (icon, text and tooltip) on chat models where `isTextMarked(model)` is false. Acknowledged models show "Not marked · acknowledged". Transcription models never get the badge.
- The server can answer an enable request with **409 `UNMARKED_MODEL_ACKNOWLEDGEMENT_REQUIRED`**. This applies to the single toggle, bulk "Enable all", uploading a config, and saving in the model editor. In each case the client opens `shared/components/JustificationDialog.jsx` and retries **the same call** with `aiTransparencyJustification`. `toggleModels(ids, enabled, justification)` and the new `toggleModel(id, justification)` in `api/adminApi.js` carry that field.
- The model editor has a "Content marking (EU AI Act)" section (`model-form/ContentMarkingSection.jsx`) that edits `contentMarking`:
  - `textWatermark` is one of `'none'`, `'upstream:<vendor>'` or `{ scheme: 'vllm-gumbel', keyGroup, perRequest }`.
  - `imageWatermark` is `'none'` or `'upstream:<technique>'`.
  - `notes` is free text.
  - The acknowledgement is shown read-only.
  - A warning box explains the gap when the model is not marked.

  The mapping between form state and stored value lives in `features/admin/utils/aiTransparencyAdmin.js` (`parseTextWatermark` / `buildTextWatermark` and the image equivalents).

---

## 3. i18n

Every string uses `t('<key>', 'English fallback')`, under these prefixes: `aiTransparency.*` (chat and shared), `admin.apps.aiTransparency.*` and `admin.models.marking.*`. The key files were handed over for merging into `shared/i18n/{en,de}.json`. Keys built at runtime (categories, exemption types, image markings, exempt reasons) are listed explicitly in those files.

## 4. Known gaps / follow-ups

1. **Office task pane**: it has no `PlatformConfigProvider`, so the badge, the chip and the first-turn notice do not show there. Only the outbound Outlook label is wired, and it fetches the config itself. To close the gap, give `OfficeChatPanel` the config (for example a provider, or props for `ChatInput` / `ChatMessageList`) and render `AIInteractionNotice` in its empty state.
2. **Compare mode**: the first-turn notice appears only on its start form, not in the empty compare panels. The badge still shows.
3. **"AI modified"** chip variant: not implemented (not needed yet).
4. The `/verify` route is added separately (`App.jsx` and the known-routes lists). The chip and the shared page only link to it.

## 5. Tests

- `tests/unit/client/chat-ai-transparency.test.jsx`: the chat rules, the notice, the chip (disclosure pattern, Escape), reminders in `ChatMessageList`, and stored provenance.
- `tests/unit/client/admin-ai-transparency-editors.test.jsx`: download stripping, record merging, save cleanup, the 409 gate, the watermark form model, `JustificationDialog`, the models list gate flow, and the app editor section.
- Additions to `run-reducer.test.jsx`, `run-to-message.test.jsx` (provenance passthrough) and `outlook-mail-actions.test.jsx` (outbound label and the 30000-character cap).
