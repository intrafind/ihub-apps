# UX concept: attachments on sent user messages

> Status: **variant A with the fold was chosen and built** (see the [README](README.md)). Where this
> document assumes user images are stored on the server (§6, image bytes), the build found they are
> not: after a reload an image is a named tile. §4's "K2" (reading the file list for the numbers) was
> not built; the numbers are shown for a message sent in the current session.

UX engineer, 2026-11-07. Inputs: 01-product-brief.md, 02-research.md, code. The UI engineer owns pixels and tokens; this file owns behaviour, structure, states, copy. "Verified" = read in the repo.

## 0. Reading of the brief, and the recommendation

| Reading | Meaning | View |
|---|---|---|
| (a) Data | `content` stays plain text | Agree, non-negotiable |
| (b1) Not in the text flow | Own block, still inside the bubble | Variant B meets it |
| (b2) Not in the bubble | Own block beside it | Variant A meets it |
| (c) Nowhere on the message | Files drawer only | **Disagree.** Upload-only turns would be empty (#2601); reopened chats already show chips; concept §3.4 approved chips |

**Recommendation: variant A (outside, above) with an adaptive fold.** One button-card per file; documents as rows, images as thumbnails; the composer's "what the assistant got" line carried over verbatim; download and delete only in the drawer. C survives as the *folded form* ("+3 more files"), not as a placement. A supersedes "chips in the bubble" in `concepts/chat-files/README.md` §3.4; amend it.

## 1. Users and jobs

| User | Job | Consequence |
|---|---|---|
| Author (desktop, phone) | Scrolling back, I see which file went with which question, and what the assistant got | Names always visible; content line survives Send |
| Screen-reader / keyboard user | I hear files as a list with name, type, size, state, and open one | Real list and buttons; no emoji; status as text |
| Outlook-pane user (~280 px) | I see attachments with no side-scroll and no side panel | Single column, earlier fold, full-pane view. Verified: the pane mounts no Files drawer or `ChatFilesContext`, and its `displayMessage` has no attachments |
| Viewer of a shared chat | I see what was asked and why I cannot open the files | Names stay; reason per card, no dead chip |
| Admin with "my file disappeared" | A screenshot tells me: retention, deletion, or never kept | State, date and cause in words (research b8) |

## 2. Principles

1. **Text stays text; attachments are a sibling block.** pm §2.5-2.7; research b1 (Open WebUI V[1], LibreChat V[3]).
2. **What the assistant got survives Send.** pm §2.2; research b9-b10, V[22]. Say what *we did* ("text extracted"), never "the assistant read it all": older files reach the model only while they fit a quarter of the context (docs/chat-files.md).
3. **Say the true state at the knowledge we have; never invent.** Research c: stale thumbnails, empty chips.
4. **One card, one click.** Download and delete stay in the drawer. Research b4-b5, c.
5. **Same card everywhere; the surface decides only where "open" goes.** pm goal 1; research e.

## 3. Scorecard

++ best, -- worst.

| Criterion | A outside above | B inside strip | C summary + drawer |
|---|---|---|---|
| Scanability | ++ names on own surface | + nested in grey | -- no names |
| Fidelity to composer | ++ full width for the line | + shrink-to-fit bubble widens | -- facts only in drawer |
| Clickability | ++ whole card | + competes with bubble hover actions | + one target, lands on drawer not file |
| Narrow (280) | + full width | -- bubble padding leaves ~230 px | ++ one row |
| Many files | + fold independent of bubble | - tall bubble | ++ |
| Accessibility | + list, then text, as seen | 0 buttons in the text container; unmount in edit | - hides names; dead without drawer (Office, share "none") |
| Effort | + sibling before bubble | + render in bubble | + small, but drawer needed everywhere |
| Like generated-file cards | ++ same family and rail | - card in bubble | - |
| Share view | ++ reason per card | + | - one chip, many files |
| Meets reading b2 | ++ | -- | + |

Why A: B fails b2; C loses the one fact that makes this a trust feature. A's risk: a block over a bubble reads as two messages. Mitigation: same right edge, small gap, a `FileCardShell` shared with `GeneratedFileCard`. Test A vs B (§9, tasks 1-2).

## 4. Information layers

| Layer | Content |
|---|---|
| L0 always | type icon, name (2 lines), `PDF · 2.3 MB`, origin if known (`from Nextcloud`) |
| L1 glance | one state line: the composer's content line, or the abnormal state |
| L2 on demand | text preview, pages, storage state, template hint, Download original/text, Delete: the Files drawer (exists) |

**Knowledge levels:** K0 name only (legacy); K1 stored descriptor on the message (type, size, `hasOriginal`); K2 `GET /api/chats/:id/files` (adds `textBytes`, `pages`, `pageImageCount`, `truncated`, `originalDeletedAt/Reason`, `origin`, `source`; verified in `toFileDescriptor`); K3 live composer (characters read, page images, image size sent).

**Where "what the assistant got" lives:** on the card as L1, built by the existing `contentLineOf()`, so wording is identical by construction (reuse `attachedFiles.content.*`). At Send the chip goes and the same string appears on the card. After a reload it appears at K2: fetch the list once per chat at hydration (the drawer already does) and upgrade cards in place. Better: persist `textBytes`, `pageImageCount`, `truncated` on `message.attachments` (architect). At K1 the line is silent when normal, `Text only` when `hasOriginal` is false.

**Code findings that change the design**
- Verified: on discard, `bytes` drops to the text size, `originalBytes` to 0 (`ChatFileRepository` ~L912-920). Never show `bytes` as file size afterwards (2.3 MB would become 41 KB). Show size while `hasOriginal`, else drop it, or freeze it at send.
- Verified: `UploadedFilesTab` falls back to `items[0]` when the clicked id is gone, so a deleted file's card would open another file. The drawer must say "This file was deleted" instead.
- Verified: edit disables Send on empty text, so an upload-only message cannot be resent after edit.
- Verified: the drawer has no audio preview; `fileLookOf` falls back to the PDF look.
- Inference: a file that failed to store has no descriptor after reload and vanishes; persist a name-only one (`stored: false`).

## 5. Interaction spec

**Structure:** `<ul role="list" aria-label="Attached files">`, one `<li><button>` per card. Name = visible text (`report.pdf, PDF, 2.3 MB`); `aria-describedby` = L1 line plus "Opens in the Files panel". Icons `aria-hidden`; thumbnail `alt=""`.

**Target:** the whole card, at least 44 px high; Enter and Space natively. Hover only tints; nothing is revealed on hover. The full name shows by wrapping (2 lines, then middle-ellipsis keeping the extension) and sits in the accessible name; `title` is never the only route.

| Surface | Click opens |
|---|---|
| Main chat | Files drawer (`ArtifactsPanel`) on that file |
| Phone, tablet | Same panel, already full-screen below 640 px (verified) |
| Office pane 280 px | The same panel as a full-pane view; needs mounting plus `ChatFilesContext`. Until then: static `<li>`, no button, no "opens" hint |
| Compare | Same drawer; each panel shows the files of its own message copy |
| Share, `none` | Nothing: static card, reason line, no tab stop |
| Share, `extracted_text` / `original` | Drawer; it already hides Download original for text-only |
| Embedded (Nextcloud) | As main chat |

**Focus:** the drawer focuses Close, traps Tab, closes on Esc, returns focus to the opener (verified). Add: if the opener unmounted (edit, regenerate), focus the message, then the composer. **Order:** attachments, text, message actions; DOM equals visual (1.3.2, 2.4.3); one Tab stop per card, no arrow layer.

**Download and delete are not on the card.** (1) The drawer already has confirm, busy state and 410 handling; a copy is a second source of truth. (2) Three targets per card at 280 px, three Tab stops per file. (3) Local files are never downloadable from the message, and `source` is unknown at K1. (4) Delete affects every later turn and needs confirmation. Price: two clicks to download.

## 6. Multiple files

Rule: `visible = n <= cap ? n : cap - 1`, so a fold reads "+2" or more, never "+1". Narrow = container under 360 px (container query; value is the UI engineer's).

| Group | Wide | Narrow |
|---|---|---|
| Rows: documents, e-mails, meetings, pages, audio | cap 4; from 5: 3 rows + "+N more files" | cap 3; from 4: 2 rows + "+N" |
| Images, 1-2 | rows with 40 px thumbnail, line visible | same |
| Images, 3+ | grid, 3 columns, cap 6 | 2 columns, cap 4 |

**Align with the composer?** It folds at 4 to keep the input reachable. The narrow transcript uses the same 4 (height is scarce); the wide one folds at 5: it scrolls, and visible names are the reading aid. Two constants, one rationale each.

**Order:** documents first (names and states need reading), then images; attach order within a group (the composer showed them mixed).

**Expand:** the fold row (button, `aria-expanded`) expands in place, no inner scroll region; focus moves to the first revealed card; polite status "3 more files shown"; the label becomes "Show fewer" and collapse returns focus to it. Not persisted; worst case 25 files (quota). Narrow rows are taller; the lower cap pays for it.

**Image bytes:** live from composer memory; reopened, lazy-fetched when `hasOriginal`, else an icon tile. Assumption: images are stored as chat files (architect). pm decisions 3 and 4: thumbnails, never a large inline image; audio is a plain card, no inline player (it vanishes on reload, the inconsistency we remove); playing it needs a drawer addition.

## 7. State matrix

The line follows the metadata and is the accessible description. Four icons (info, warning, lock, spinner); text carries state (1.4.1).

| State | Needs | EN | DE | Icon | Click | Live announcement |
|---|---|---|---|---|---|---|
| Sent | K1 | none | none | none | drawer | none |
| Read in full | K2/K3 | Text extracted: 12,400 characters | Extrahierter Text: 12.400 Zeichen | none | drawer | none |
| Shortened | K2/K3 | Text extracted: 48,000 characters · shortened to fit | Extrahierter Text: 48.000 Zeichen · gekürzt | info | drawer | none |
| Scan as page images | K2/K3 | Scan without text: 3 page images sent instead | Scan ohne Text: stattdessen 3 Seitenbilder gesendet | info | drawer | none |
| Original removed | K2 | Original removed after the retention period · text kept | Original nach Ablauf der Aufbewahrungsfrist entfernt · Text bleibt erhalten | info | drawer (text) | none |
| Original removed, cause unknown | K1 | Text only | Nur Text | info | drawer (text) | none |
| File deleted | K2 | Deleted from this chat | Aus diesem Chat gelöscht | slash | none | none |
| No access (share) | K0/K1 | Not shared by the owner (text share: Shared as text only) | Vom Eigentümer nicht geteilt (Textfreigabe: Nur als Text geteilt) | lock | none (text share: drawer) | none |
| Unreadable | K2/K3 | No text could be read from this file · the assistant has no content from it | Aus dieser Datei konnte kein Text gelesen werden · der Assistent hat keinen Inhalt davon | warning | drawer if stored | none |
| Failed, message sent | K3 | Not saved to the chat · sent with this message only | Nicht im Chat gespeichert · nur mit dieser Nachricht gesendet | warning | none (no id) | "{name} could not be saved to the chat; it was sent with the message only" |
| Still processing | K3 | Processing… | Wird verarbeitet… | spinner | none (no id yet) | on change only: "{name} is ready" |

Rules: "Original removed" adds the date when known (`on 12 Nov` / `am 12. Nov.`). *Processing* sets `aria-busy`, never survives a reload, and hydration announces nothing (research d); announce per message. Use `_one/_other` plurals ("Seitenbild/Seitenbilder"), not the composer's "image(s)". Verify "the assistant has no content from it" (the composer says only the first half).

## 8. Edit, resend, regenerate, copy, export, share, Compare

| Action | Behaviour |
|---|---|
| Edit | Text only. The block stays above the textarea (A's advantage). Hint (the existing one hides in `compact`): "The attached files are sent again with your edited message." / "Die angehängten Dateien werden mit Ihrer geänderten Nachricht erneut gesendet." No add or remove in v1. Send stays enabled on empty text when files exist |
| Resend | Same files, cards unchanged. A deleted file is skipped, with notice: "1 file was not sent again: it was deleted." / "1 Datei wurde nicht erneut gesendet: Sie wurde gelöscht." |
| Regenerate | Unchanged |
| Copy | Text only, never names or markup (today the rich copy carries the badge HTML; plain `content` fixes it) |
| Export | `Attachments` list after the text: name, type, size, state. No content, no base64; JSON carries descriptors only |
| Share | Cards follow `uploadedFilesAccess` and the per-file allowlist: an unchecked file says "Not shared by the owner" while others open |
| Compare | Each panel is its own transcript: each shows the block, narrow rules apply. Verify the drawer can resolve each panel's chat id |

## 9. Usability test and open questions

**Script** (6-8 participants: 2 keyboard or screen-reader, 1 Outlook user; mockup with 3-file and 9-file chats; A vs B between subjects for tasks 1-2).
1. *Recall:* "Which file in your third message was the budget?" Success: found without opening.
2. *Verify:* "The answer ignores page 40. Could the assistant have read the whole contract?" Success: finds "shortened to fit".
3. *Open and return:* keyboard only, "Open the spreadsheet from your first message, then carry on." Success: focus returns to the card (100%).
4. *Missing:* "A colleague says the PDF disappeared." Success: names retention, knows the text remains, finds Download text.
5. *Narrow and shared:* 280 px frame, 9 files, then a shared chat: "How many files? Which can the viewer open?" Success: right count, no sideways scroll.

Targets: 80% unaided success; "removed" vs "deleted" told apart by 6 of 8.

**Open questions (product owner)**
1. **Placement:** is b2 (outside the bubble) what you meant, and may we amend concept §3.4 ("chips in the bubble")?
2. **Office pane:** in scope? It shows no attachments on sent messages today and has no drawer. Block there opening a full-pane view, or static cards?
3. **Retention transparency:** may the card name cause and date ("removed after the retention period, 12 Nov"), and is it fine that a deleted file's name stays in the transcript?
