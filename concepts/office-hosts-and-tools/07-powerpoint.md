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
- The current slide is found with `getSelectedSlides()` (PowerPointApi 1.5). Older clients fall back to the first slide, and the strip says so.
- **Toggle:** *Include current slide* (on).
- **Insert action:** replace the selected text range (`getSelectedTextRange`, 1.5). With nothing selected, add a text box to the current slide.

## Step 1 — slide-level tools (v1)

| Tool | PowerPoint API | Min PowerPointApi | Approval |
|---|---|---|---|
| `getPresentationOutline` | `presentation.slides` → per slide: index, title text, shape count | 1.3 | never |
| `getCurrentSlide` | selected slide: shapes (`textFrame.textRange.text`), notes | 1.5 | never |
| `getSlide` | slide by index | 1.3 | never |
| `getSelectedText` | `getSelectedTextRange()` | 1.5 | never |
| `replaceSelectedText` | `textRange.text = …` | 1.5 | never |
| `setShapeText` | `shape.textFrame.textRange.text` on a shape by id | 1.4 | never |
| `addSlide` | `slides.add({ layoutId, slideMasterId })` + fill placeholders | 1.3 | never |
| `addTextBox` | `shapes.addTextBox(text, {left, top, width, height})` | 1.4 | never |
| `deleteSlide` | `slide.delete()` | 1.3 | **always** |

Speaker notes are not writable through the Office.js PowerPoint API on all clients. `setSpeakerNotes` is therefore part of step 2, unless the notes API is available at implementation time. Check the current PowerPointApi requirement sets before building.

## Step 2 — deck operations through a server-side copy

Translate deck, restyle deck, write speaker notes for every slide, and generate a deck. These work on the **file**, not slide by slide through Office.js:

1. **Snapshot.** `captureDeck` reads the presentation as a file: `Office.context.document.getFileAsync(Office.FileType.Compressed)`, in slices, base64. It uploads the file to a short-lived server store tied to the run. The upload never enters the model context.
2. **Edit on the server.** Server tools edit the PPTX with the existing OOXML and PPTX code in `server/services/documents/pptx/` and `server/services/documents/ooxml/`, the same stack as `create_pptx` (`server/systemSkills/pptx`). Examples: `translateDeck(snapshotId, language)`, `writeSpeakerNotes(snapshotId, notes[])`, `restyleDeck(snapshotId, templateId)`, which uses document templates.
3. **Apply.** `applyDeck(handleId, mode)` (client, **approval**) inserts the result with `presentation.insertSlidesFromBase64(base64, { formatting })` (PowerPointApi 1.2). The mode is either:
   - `append`: inserted as copies, the originals are kept
   - `replace`: originals deleted after insertion, with a confirmation that it cannot be undone in one step

This is the competitor's approach (snapshot, then apply as a copy or a replacement), built on our document stack.

- **Storage.** The snapshot store is encrypted at rest like other uploads and deleted when the run ends or after 1 hour.
- **Scope.** Step 2 gets its own sub-issue once step 1 ships.

## Ribbon (pane handoff)

| Button | Action prompt (configurable) |
|---|---|
| Summarize presentation | `getPresentationOutline` + `getSlide` as needed; chat only |
| Improve slide | `getCurrentSlide`, propose changes, apply with `setShapeText` after the user agrees |
| Speaker notes | step 2: `writeSpeakerNotes` + `applyDeck` |

## Default app

`powerpoint-assistant` under `server/defaults/apps/`.

## Tests

- **Executor unit tests** against a PowerPoint.js mock.
- **Step 2:** a round trip on a sample deck (snapshot, translate, apply as copy), verified with the existing PPTX parsing in `server/services/documents/`.
- **Manual matrix:** PowerPoint for the web, Windows and Mac. Expect gaps on Mac and older builds, and document them.

## Acceptance criteria

- **Step 1:** "Make the bullets on this slide shorter" changes only the selected slide's text. "Add a slide summarising slides 2–4" adds one slide.
- **Step 2:** "Translate the deck into English" yields a translated copy appended after the originals, after approval, with charts and SmartArt reported as not translated.
