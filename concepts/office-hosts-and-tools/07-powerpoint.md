# 07 — PowerPoint Add-in and Tools

**Phase:** P6 (needs P1, P3; last, because PowerPoint's Office.js coverage is the thinnest)
**Parent:** [README](README.md)

## Goal

In PowerPoint the user can:
- ask about the presentation or the current slide
- have the model rewrite slide text and write speaker notes
- add slides

Whole-deck operations (translate, restyle, generate) come in a second step that works on a server-side copy of the deck.

## Host adapter (`client/src/features/office/hosts/powerpoint.js`)

- **`readMessageContext()`** returns `hostContext` `type:"slide"`:
  - presentation title
  - current slide index
  - the slide's shapes text, with the title shape first
  - its notes
- The current slide is found with `getSelectedSlides()` (PowerPointApi 1.5).
- **No fallback to slide 1.** Without PowerPointApi 1.5 there is **no** current slide. The context strip says so, current-slide tools (`getCurrentSlide`, `getSelectedText`, `replaceSelectedText`) are not advertised, and the model reads slides by number with `getSlide`. A write always names its `slideId`, so it never lands on a guessed slide.
- **Toggle:** *Include current slide* (on).
- **Insert action:** replace the selected text range (`getSelectedTextRange`, 1.5). With nothing selected, add a text box to the current slide.

## Step 1 — slide-level tools (v1)

| Tool | PowerPoint API | Min PowerPointApi | Approval |
|---|---|---|---|
| `getPresentationOutline` | `presentation.slides` → per slide: index, title text, shape count | 1.3 | never |
| `getCurrentSlide` | selected slide: shapes (`textFrame.textRange.text`), notes | 1.5 | never |
| `getSlide` | slide by index | 1.3 | never |
| `getSelectedText` | `getSelectedTextRange()` → `{ slideId, shapeId, start, length, text }` | 1.5 | never |
| `replaceSelectedText` | takes `{ slideId, shapeId, start, length, expectedText, text }`; resolves `slides.getItem(slideId).shapes.getItem(shapeId).textFrame.textRange.getSubstring(start, length)`, checks its text equals `expectedText`, then sets it | 1.5 | **always** (overwrites text; PowerPoint has no tracked changes) |
| `setShapeText` | `shape.textFrame.textRange.text` on `{ slideId, shapeId }` | 1.4 | **always** (overwrites text) |
| `addSlide` | `slides.add({ layoutId, slideMasterId })` + fill placeholders | 1.3 | never (additive only; one Undo or `deleteSlide` removes it) |
| `addTextBox` | `shapes.addTextBox(text, {left, top, width, height})` on `slideId` | 1.4 | never (additive only) |
| `deleteSlide` | `slide.delete()` | 1.3 | **always** |

**Slide binding.** Every write names its slide, and the executor enforces it:
- `replaceSelectedText` never touches "the current selection". It writes to the range `getSelectedText` reported, and only while that range still holds `expectedText`. A changed slide, shape or text fails with `TargetChanged`.
- `setShapeText` resolves the shape as `presentation.slides.getItem(slideId).shapes.getItem(shapeId)`. A shape id that exists only on another slide is not found, and the call fails with `TargetChanged`.
- `addTextBox` adds to `slides.getItem(slideId)`.
- The approval card names the slide ("Slide 4: *Q3 results*") and the old and new text. The executor writes to exactly that `slideId`. It never writes to whatever slide is selected when the user clicks **Allow**.

Speaker notes are not writable through the Office.js PowerPoint API on all clients. `setSpeakerNotes` is therefore part of step 2, unless the notes API is available at implementation time. Check the current PowerPointApi requirement sets before building.

## Step 2 — deck operations through a server-side copy

Translate deck, restyle deck, write speaker notes for every slide, and generate a deck. These work on the **file**, not slide by slide through Office.js:

1. **Snapshot.** `captureDeck` reads the presentation as a file: `Office.context.document.getFileAsync(Office.FileType.Compressed)`, in slices, base64. It uploads the file to a short-lived server store tied to the run. The upload never enters the model context.
2. **Edit on the server.** Server tools edit the PPTX with the existing OOXML and PPTX code in `server/services/documents/pptx/` and `server/services/documents/ooxml/`, the same stack as `create_pptx` (`server/systemSkills/pptx`). Examples: `translateDeck(snapshotId, language)`, `writeSpeakerNotes(snapshotId, notes[])`, `restyleDeck(snapshotId, templateId)`, which uses document templates.
3. **Apply.** `applyDeck(handleId, mode)` (client, **approval**) inserts the result with `presentation.insertSlidesFromBase64(base64, { formatting })` (PowerPointApi 1.2). The mode is either:
   - `append`: inserted as copies, the originals are kept
   - `replace`: a confirmation that it cannot be undone in one step, then three steps that keep the deck recoverable:
     1. Insert the new slides **after** the originals and record the inserted slide ids.
     2. Verify the inserted count matches the snapshot.
     3. Only then delete the originals by their recorded ids.

     A failure in step 1 or 2 deletes nothing. A failure in step 3 reports *partially applied*: both versions are present, and a **Remove originals** offer deletes exactly the recorded originals.
   - **Idempotent retries, including a lost response.** The server cannot see what the pane did if the answer never arrives, so the deck itself carries the proof:
     1. Before inserting, the pane reads the deck's current slide ids and sends them with its acknowledgement. The server records `applied: { state: 'inserting', attemptId, mode, preInsertSlideIds }`. `attemptId` is a fresh UUID. Only then does the pane insert.
     2. The pane inserts the slides, then tags each new one with `slide.tags.add('ihub-apply', attemptId)` (PowerPointApi 1.3). The tags make the common case cheap; they are not the only evidence.
     3. When the answer arrives, the server stores `state: 'inserted'` with `insertedSlideIds`, and later `state: 'done'` with `originalsDeleted`.
     4. A retry that finds `state: 'inserting'` treats the outcome as **uncertain** and reconciles before doing anything:
        - **Slides tagged with this `attemptId` exist:** the insert happened. They are recorded as inserted, and nothing is inserted again.
        - **No tags, but the deck has slides that are not in `preInsertSlideIds`:** the insert may have happened before tagging. **Nothing is inserted automatically.** The pane shows the untagged new slides and asks the user: *Use these as the result* (they are tagged and recorded) or *Insert again*.
        - **No tags and no slides beyond `preInsertSlideIds`:** the insert did not happen, so it runs once.

        Missing tags alone are never treated as proof that nothing was inserted.
     5. A retry in `inserted` only continues the deletion of recorded originals; in `done` it answers *already applied*.

This is the competitor's approach (snapshot, then apply as a copy or a replacement), built on our document stack.

- **Storage.** The snapshot store is encrypted at rest like other uploads and deleted when the run ends or after 1 hour.
- **Upload limits.** Configured in `officeIntegration.hosts.powerpoint`; the defaults are starting values to tune, not measured limits.
  - `maxDeckBytes`: compressed deck size, default 50 MB. This follows `MAX_ATTACHMENT_BYTES` in Outlook. The pane checks `file.size` before reading any slice, and the server checks the running total per slice.
  - Slice size: 4 MB, the `getFileAsync` maximum. The slice count is capped at `ceil(maxDeckBytes / 4 MB)`.
  - At most **one** live snapshot per run. A new `captureDeck` replaces the run's previous snapshot.
  - At most 10 snapshots per user per hour (`maxSnapshotsPerHour`), counted on the server.
  - **Atomic commit.** Slices go to a temporary entry that is committed only when the last slice arrives and the total matches. A limit hit, a missing slice or an aborted run discards the temporary entry, so no partial snapshot is ever stored.
  - **Errors.** The model gets the error envelope (`name: 'DeckTooLarge'` or `'SnapshotRateLimited'`, with the limit in `message`). The pane shows the same message to the user.
- **Handle authorization.**
  - `captureDeck` creates the snapshot and binds its handle to `{ userId, chatId, runId, expiresAt }` on the server. Creating it needs no lookup check.
  - **Every** later lookup checks the caller against that binding before it touches the file: each server-side edit (`translateDeck`, `writeSpeakerNotes`, `restyleDeck`, …), each derived-handle lookup, and the `applyDeck(handleId, mode)` download.
  - The check requires the same authenticated user and the same run (a derived handle inherits its source's binding) and an unexpired handle.
  - Any mismatch, including another user, another run or an expired handle, answers `404 Not Found`, so a guessed id reveals nothing. Handle ids are random UUIDs and never sequential.
- **Scope.** Step 2 gets its own sub-issue once step 1 ships.

## Ribbon (pane handoff)

| Button | Action prompt (configurable) |
|---|---|
| Summarize presentation | `getPresentationOutline` + `getSlide` as needed; chat only |
| Improve slide | `getCurrentSlide`, propose changes, apply with `setShapeText`. The user agrees through the approval card, which shows the slide and the old and new text. |
| Speaker notes | step 2: `writeSpeakerNotes` + `applyDeck` |

## Default app

`powerpoint-assistant` under `server/defaults/apps/`.

## Tests

- **Executor unit tests** against a PowerPoint.js mock:
  - `setShapeText` with a shape id from **another** slide fails with `TargetChanged` and changes nothing
  - a selection change between approval and execution does not move the write
  - `replaceSelectedText` with a stale `expectedText` (the text was edited after approval) fails with `TargetChanged`
  - without PowerPointApi 1.5, current-slide tools are not advertised and nothing falls back to slide 1
- **Handle authorization:** each server-side edit and the `applyDeck` lookup refuse a handle from another user, another run, or past its expiry (404), and accept the owner's handle in the same run.
- **Step 2:** a round trip on a sample deck (snapshot, translate, apply as copy), verified with the existing PPTX parsing in `server/services/documents/`.
- **Manual matrix:** PowerPoint for the web, Windows and Mac. Expect gaps on Mac and older builds, and document them.
- **Lost response:** the answer to an `applyDeck` call is dropped after `insertSlidesFromBase64` succeeded; the retry finds the slides tagged with the `attemptId`, records them and inserts nothing.
- **Crash before tagging:** the insert succeeds but the pane stops before tagging; the retry finds new slides outside `preInsertSlideIds`, inserts nothing on its own and asks the user.
- **No insert:** with no tags and no new slide ids, the retry inserts exactly once.
- **Replace recovery:** a failure injected after insertion and before deletion leaves both versions and reports *partially applied*; a retry only deletes the recorded originals and never inserts twice.
- **Upload limits:** a deck over `maxDeckBytes`, a missing slice and an 11th snapshot within an hour each fail with the error envelope and leave no stored snapshot.

## Acceptance criteria

- **Step 1:** "Make the bullets on this slide shorter" changes only the selected slide's text. "Add a slide summarising slides 2–4" adds one slide.
- **Step 2:** "Translate the deck into English" yields a translated copy appended after the originals, after approval, with charts and SmartArt reported as not translated.
