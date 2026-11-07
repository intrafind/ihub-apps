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
| 4 | **Images and audio are cards.** An image has a thumbnail only for a message sent in the current session; after a reload it is a named tile, because the server stores neither images nor audio. Audio has no inline player (the old player was never reachable) | Default taken; storing user images is a separate product decision | [Architecture](05-architecture.md) §B |
| 5 | What the assistant got from a file (the composer's line) shows on the card for a message sent now; a reopened message shows name, type and size | Default taken; persisting it is a follow-up | [UX concept](03-ux-concept.md) §4 |
| 6 | The Outlook task pane shows static cards (no Files drawer is mounted there) | Default taken | [UX concept](03-ux-concept.md) §5 |
| 7 | An image attached before the model was switched to one without vision **stops the message** with a note, as audio already did | Requested: images and audio only where the model supports them | [Architecture](05-architecture.md) §G |

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
| Images after a reload | Assumed stored, lazy thumbnails | Thumbnail "when stored" | Not stored: no id, bytes never kept | Verified in the code and the real app: named tile after a reload |
| "What the assistant got" after a reload | Fetch the file list or persist numbers | Facts line | No server change | Not shown after a reload yet; persisting three numbers is the follow-up |
| Thumbnail `alt` | `alt=""` | `alt=""` | `alt` = file name | `alt=""`: the name is in the card's own text |
| Audio | Plain card | Optional player, off | Chip only | Plain card |

## What is still open

1. **Persist what the assistant read** (`textBytes`, `pageImageCount`, `truncated`) on the stored
   descriptor, an additive server change, so the card keeps that line after a reload.
2. **JSON and JSONL export** still dump the whole message object, including the attached files'
   contents for a message sent in the session. Dropping them for the stored descriptors is a small
   breaking change to an accidental contract; it needs a decision.
3. **Images that survive a reload** need user images stored on the server (quota, retention and
   privacy decision).
4. **Office task pane**: the cards are static there; mounting a Files view needs its own design.
5. **Edit-and-resend** of a turn that is only files: Send stays disabled on empty text.
6. **The refusal message for an image or sound on a model that cannot take it** is the generic
   "Unsupported file format. Please use: …". The model-specific text already exists
   (`errors.imageUploadDisabled`, `errors.audioUploadDisabled`) but is unreachable: the gate checks
   a format list that is empty exactly when the upload is disabled.
7. **Close PR #1933** as superseded and re-scope #1786; a comment on each is not posted from here.
