# EU AI Act — client side of server exports and the `/verify` page

Status: implemented and committed, 2026-09-30. Epic intrafind/ihub-apps#2563, issues
#2571, #2576 (exports), #2573 (detection page). Design: `concepts/2026-09-27 EU AI Act Content
Marking.md` §5.3, §8.3, §8.4. Server contract: `server/routes/exports.js`,
`server/routes/provenance.js`.

## What changed, in one paragraph

The browser no longer generates any export file. Every download (chat, single message, canvas,
workflow report, markdown viewer, agent artifact) is a `POST /api/exports` request; the server
renders, labels and signs the file and the client only saves the bytes. The browser
print-to-PDF paths are gone. The new public page `/verify` checks files or text for AI markings
through `POST /api/provenance/verify`.

## Where things live

| Concern | File |
|---|---|
| HTTP calls for exports (`fetchExport`, `requestExport`, `requestExportText`, `signClipboardText`) | `client/src/api/endpoints/exports.js` |
| HTTP calls for detection (`fetchProvenanceInfo`, `verifyProvenanceContent`, `verifySignedReport`) | `client/src/api/endpoints/provenance.js` |
| Chat export request building (pure, tested) | `client/src/features/chat/utils/exportRequest.js` |
| Export dialog (message selection, format, PDF template, EU icon, editorial responsibility) | `client/src/features/chat/components/ExportDialog.jsx` |
| One-document exports (markdown / workflow / artifact / canvas) | `client/src/shared/utils/markdownExports.js` |
| Clipboard write that survives an async fetch (Safari) | `client/src/shared/utils/clipboardText.js` |
| Fallback filename helpers | `client/src/utils/exportFormats.js` (+ `exportFormats.test.js`, run by `npm run test:export-formats`) |
| `/verify` page and its parts | `client/src/features/verify/pages/VerifyPage.jsx`, `components/*`, `utils/verifyResult.js` |
| Tests | `tests/unit/client/chat-export-request.test.jsx`, `tests/unit/client/verify-result.test.jsx` |

## The rule that matters most: stored vs. unstored exports

`buildChatExportRequest()` decides the request shape:

- **Stored**: the chat is server-backed (`useChatPersistence()`, or the `serverBacked` prop) and
  **every** selected message has `serverId` (set by `transformStoredMessage` on hydration). The
  request carries `{ chatId, messageIds }` and the server loads the content itself. No `title`
  is sent unless the conversation has one, so the server uses the stored chat title.
- **Unstored**: anything else, including a turn made in this session (it has no `serverId` yet).
  The request carries `messages: [{ id, role, content, timestamp, model }]`, and the server
  checks each assistant message against its provenance records.

Messages that never go into an export: greetings, streaming (`loading`), failed (`error`,
`isErrorMessage`), UI-only system notices (role `system` without `fromServer`), empty ones.

## Clipboard "Copy" in the export dialog

It requests the same export in the text format (txt, markdown, json, jsonl) and copies the
response. For txt/markdown, if the clipboard signpost is on (the app override
`app.aiTransparency.signpost.clipboard` wins over `platformConfig.aiTransparency.text.signpost.clipboard`)
and the text has no signpost yet, the text is passed through `POST /api/provenance/signpost`.
The exports signpost (which the server adds on its own) is detected by the U+FEFF + variation
selector wrapper, so a text is never signposted twice. JSON is never signposted, because it
would no longer parse.

## i18n

New keys are under `verify.*` and `pages.appChat.export.*` (plus the pre-existing but
untranslated `canvas.export.downloadOptions`). They are merged into `shared/i18n/{en,de}.json`. Every
`t()` call has an English fallback.

## Open items / next steps

1. Register the route: `App.jsx` outside `Layout` like `share/:shareId`, and `'verify'` in both
   `KNOWN_ROUTES` (`client/src/utils/runtimeBasePath.js`) and the inline `knownRoutes` of
   `client/index.html`, in the same position (right after `'share'`).
2. `fetchArtifactText()` in `client/src/features/admin/utils/artifactDownload.js` still fetches
   `/api/...` without the base path (unchanged behaviour). Consider `buildApiUrl()` for subpath
   deployments.
