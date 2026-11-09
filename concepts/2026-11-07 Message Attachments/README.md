# Message Attachments: files on a sent message are data, shown by one component

**Date:** 2026-11-07
**Status:** Implemented (variant A), with follow-ups listed in [What is still open](#what-is-still-open)
**Tickets:** GitHub [intrafind/ihub-apps#1786](https://github.com/intrafind/ihub-apps/issues/1786) (re-scoped by this concept); draft PR [#1933](https://github.com/intrafind/ihub-apps/pull/1933) is superseded
**Related:** [Chat and Scheduled-Task Files](../chat-files/README.md) (§3.4 amended by this concept), [AttachedFilesList collapse](../attached-files-list-collapse/2026-06-02%20AttachedFilesList%20Collapse%20Redesign.md) (the composer side), [Chat and Scheduled-Task Files (docs)](../../docs/chat-files.md)

---

## Summary

Issue #1786 asked to tidy the code in `AppChat.handleSubmit` that pastes an HTML "badge" for each
attached file into the text of the user's message. The issue was still relevant four months later,
but its fix (extract helpers that keep emitting the same HTML) would have polished the wrong thing.
The badge itself was the defect: the same message looked different before and after a reload, the
badge said nothing the composer chip had said a moment earlier, it could not be opened, it was not
accessible or translated, and it carried an unescaped file name and base64 images inside the message
text.

The product owner's direction was that the badge must not be in the message at all. The result:

- A message's `content` is **exactly the text that was typed**. There is no markup in any message and
  no `dangerouslySetInnerHTML` for user turns.
- The files of a message are **`message.attachments`**: plain data derived once where a message
  enters the chat (a turn sent now, a turn read back from the store, a shared snapshot).
- One component, **`MessageAttachments`**, shows them as a block of cards **above the bubble**
  (variant A), outside its text. A stored document opens in the Files drawer.

## Decisions

| # | Decision | Who | Where it is argued |
| --- | --- | --- | --- |
| 1 | **Variant A**: the files are a block above the bubble, outside its coloured background | Product owner | [UX concept](03-ux-concept.md) §3 |
| 2 | More cards than fit fold into **+N more files** (5+ wide, 4+ narrow); the summary-chip variant the UI engineer proposed was not built | Chosen to match A; UX and UI differed | [UX concept](03-ux-concept.md) §6, [UI spec](04-ui-spec.md) §0 |
| 3 | **Clean break, no compatibility shim**: nothing stored or in flight ever contained the badge HTML | Default taken; the architect found no data to tolerate | [Architecture](05-architecture.md) §D |
| 4 | **Images and audio are cards.** First release: an image had a thumbnail only for a message sent in the current session, because the server stored neither images nor audio. **Since the follow-up the server keeps the picture** (as sent to the model, origin `image`; see decision 8), so the thumbnail survives a reload. Audio is still not stored and has no inline player (the old player was never reachable) | Default taken; storing user images was decided in the follow-up | [Architecture](05-architecture.md) §B |
| 5 | What the assistant got from a file (the composer's line) shows on the card for a message sent now. First release: a reopened message showed name, type and size only; the follow-up persists the numbers, so the line is back after a reload | Default taken; persisted in the follow-up | [UX concept](03-ux-concept.md) §4 |
| 6 | The Outlook task pane showed static cards (no Files drawer mounted there). **Since the follow-up the pane mounts the same Files drawer** (`OfficeFilesView`), a full-pane sheet on the narrow surface, with Attach to email while composing | Default taken; built in the follow-up | [UX concept](03-ux-concept.md) §5 |
| 7 | An image attached before the model was switched to one without vision **stops the message** with a note, as audio already did | Requested: images and audio only where the model supports them | [Architecture](05-architecture.md) §G |
| 8 | **User pictures are stored under the policy of an original**: `original_and_text` only, bytes count against every quota but no file slot, kept `originalRetentionDays` and then removed whole, owner-only, in a share only with `original` access, never a document for the model, only raster types by their bytes (never SVG), best effort (a refusal never stops the message) | Delegated to the engineers by the product owner ("do them too") | [Chat files](../../docs/chat-files.md#pictures) |

`concepts/chat-files/README.md` §3.4 said the bubble should show "compact clickable file chips"; it is
amended to say the cards sit above the bubble.

## How to read this folder

| Document | Answers |
| --- | --- |
| [01 · Product brief](01-product-brief.md) | Is #1786 still relevant, what is wrong for users, goals, scope, risks |
| [02 · Research](02-research.md) | How ChatGPT, Claude, Gemini, Copilot, Open WebUI, LibreChat, Slack, Teams and others show a sent file; accessibility checklist |
| [03 · UX concept](03-ux-concept.md) | Placement scorecard, information layers, interaction, folding, states with EN/DE copy, test script |
| [04 · UI spec](04-ui-spec.md) | Card anatomy, Tailwind classes light and dark, states, contrast numbers, forced colours, print, embeds |
| [05 · Architecture](05-architecture.md) | Producers and consumers, the attachment view model, options, compatibility, slices, and §G: what was built and what the real run found |
| [Mockup](mockups/attachments.html) | Open from disk: placements A/B/C, light and dark, widths 900/640/360/280, eight file sets, a states gallery |
| [Screenshots](screenshots/) | The implementation in the real app: sent, reopened, phone, dark |

## What was built

| Slice | Content | State |
| --- | --- | --- |
| 1 | `attachmentPayload.js`: `classifyFiles`, `toApiFileField`, `payloadFieldsOf`; the three IIFEs in `handleSubmit` are gone, the payload sent to the server is unchanged | Done |
| 2a | `attachmentViews.js` (the view model), `attachmentDescription.js` (what the assistant got, free of download and API code), `MessageAttachments.jsx`; i18n en/de | Done |
| 2b | `handleSubmit` sends `content` as typed and builds no HTML; `addUserMessage` and `transformStoredMessage` fill `message.attachments`; `ChatMessage` draws the block above the bubble; `userMessageContent.js`, `hasHTMLContent`, `sharedAttachments` and the unreachable audio card are deleted | Done |
| 3 (part) | Copy and copy-link give the typed text (they read a field nothing sets); the drawer says "This file is no longer in the chat" instead of opening the first file; the drawer heading wraps; print and embed CSS | Done |
| 4 | Server: the images and audio of a turn were stored **twice** on the message; the stored size of a file was its text and original together | Done |
| Guard | An image staged for a model without vision stops a typed message; capability gating verified in the real UI | Done |

## What the real run found

Unit tests passed throughout; running the app with Playwright found what they could not:

- **Duplicate descriptors were real.** A turn with a document, a document, an image and a sound
  came back after a reload as six cards. `prepareTurnFiles` and the route both added the media. The
  route's copy is removed (slice 4).
- **Sizes after a reload were wrong.** A 2 KB file showed 4 KB: a stored file's `bytes` is its text
  and its original together. `describeStored` now gives the original's size while it is kept.
- **A fixed-width block cannot measure itself.** The first fold logic measured the block's own
  parent, which shrink-wraps its content, so it was always "narrow". Narrow is now the window width
  or the `compact` flag of a narrow surface.
- **The same stored file twice gives two cards.** The server keeps one copy of identical files, so
  the card key is position plus id.
- **Capability gating works in both directions.** With the model confirmed in the page, a model
  without vision and audio refuses an image and a sound file; a model with both takes them. (My first
  runs raced the `?model=` switch and showed a misleading result; the check was repeated until the
  model was confirmed.)

## Where the specialists differed, and how it was settled

| Question | UX engineer | UI engineer | Architect | Settled |
| --- | --- | --- | --- | --- |
| Many files | Fold: "+N more files" | Summary chip beyond three | Left to UX | The fold (variant A as chosen) |
| Images after a reload | Assumed stored, lazy thumbnails | Thumbnail "when stored" | Not stored: no id, bytes never kept | First release: named tile after a reload (verified in the real app). Follow-up: stored, lazy thumbnail, as the UX and UI engineers assumed |
| "What the assistant got" after a reload | Fetch the file list or persist numbers | Facts line | No server change | Not shown after a reload yet; persisting three numbers is the follow-up |
| Thumbnail `alt` | `alt=""` | `alt=""` | `alt` = file name | `alt=""`: the name is in the card's own text |
| Audio | Plain card | Optional player, off | Chip only | Plain card |

## What is still open

Done since the first release:

- **What the assistant read survives a reload.** `describeStored` writes `textBytes`,
  `pageImageCount` and `truncated` on the descriptor (additive; `normalizeAttachments` keeps them),
  and `attachmentViews.readOfStored` rebuilds the same line the composer chip shows. A message stored
  before that shows no line and claims nothing, not even that the original was discarded.
- **JSON and JSONL export** no longer dump file contents. `exportableMessage` replaces
  `fileData`/`imageData`/`audioData` by a short `attachments` list (a deliberate clean break, listed
  in the breaking changes; one generator now serves the export dialog and `chatExport.js`).
- **The refusal says why.** An image, sound or video the app allows and the selected model cannot
  take is refused with the model-specific text. The cause was two layers: the format list is empty
  exactly when the upload is switched off, and `Uploader` checked it before the processor ran.
  `createUploadConfig` now marks `blockedByModel`, `uploadGate.capabilityRefusal` decides, and
  `Uploader` asks its `refuseFile` prop before the format check. An app that does not offer the type
  still gets the generic list of accepted formats.
- **Sonar:** `AttachmentCard` (complexity 28) is split into `TileContent`, `GridBody`, `RowBody`,
  `RowMeta` and `RowLine` with the DOM unchanged (checked against the old render for rows, grid,
  openable and plain, wide and compact). The other seven findings in the product code are fixed:
  nested ternaries, the two `role="status"` paragraphs that are `<output>` now, and the print
  `!important` that a more specific selector replaces. The 65 findings in the static prototype
  `mockups/attachments.html` are fixed too, except one (see below): nested ternaries and template
  literals, repeated `push` calls, the `!important` declarations (specificity instead), the
  complexity of `rowCard` and `block`, and more. The prototype renders the same: 3,466 states
  (four widths, both themes, all placements and file sets, keyboard tours, print, forced colors,
  reduced motion) match the original screenshot for screenshot.

- **User pictures survive a reload.** `prepareTurnFiles` stores each picture of a turn
  (`storeTurnImage`: raster types only, sniffed from the bytes, deduplicated by content and name,
  never an error) as a chat file of origin `image`; its descriptor now has an `id`, so the card
  fetches the thumbnail lazily (`useStoredThumbnail`, through the files context so a shared chat
  uses the share's route) and opens in the Files drawer. The repository gives the origin its two
  rules: no file slot, and removal of the whole file when its original expires. Model-facing code
  (history hydration, regenerate, `chat_files_list`) skips it; the share viewer may open it only
  with `original` access. Audio is still not stored. A picture sent in this session is shown from
  memory and is not openable until the next reload (the client does not learn the id).
- **The Outlook task pane has a Files view.** `OfficeFilesView` wraps the message list, provides
  the files context and mounts the same `ArtifactsPanel`, a full-pane sheet on a 380 px pane,
  with Attach to email while a mail is being written.

Still open:

1. **Audio** is not stored, so it has no card that opens and no player. Storing it would follow
   the picture's rules.
2. A picture **sent in this session** opens only after a reload; showing its id live needs the
   server to answer the turn with the stored descriptors.
3. **Regenerating a turn after a reload** sends no picture to the model: the browser has none, and
   the vision check exists only in the client. The server holds the bytes, so it could send the
   stored picture again once it knows that the selected model takes images. Until then the card
   keeps the thumbnail and does not say "sent to the model".
4. **Edit-and-resend** of a turn that is only files: an empty or unchanged edit is a deliberate
   no-op and the Resend button covers it, so this is not treated as a defect.
5. **One Sonar finding in the mockup**: `role="group"` on `#frame` wants a `<fieldset>`, which
   repaints the four anti-aliased corners of the dashed frame (a couple of dozen pixels per
   screenshot). The prototype is not shipped, so it is left as it is.
6. PR #1933 is closed as superseded and #1786 is closed by the first release.
