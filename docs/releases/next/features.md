# Features — Unreleased

## Scheduled Tasks: Larger Notes That Keep Themselves Current

Tasks that remember between runs now have twice the room for their notes, and the notes keep
themselves within it instead of filling up.

- The default limit is 16000 characters (was 8000). Installations still on the old default are
  raised automatically; a limit an admin set stays as it is.
- Every entry in the notes carries the date it was last confirmed. When the notes need room, the
  entries not seen for the longest time go first, then older ones are condensed. The latest
  state, open follow-ups and the owner's preferences are kept.
- The run's row on the task page shows **Memory full** or **Memory not updated** when the notes
  could not be updated and the previous notes were kept.

## Chat Export: Faster First Page Load

The libraries that create Word, PowerPoint and Excel exports are no longer downloaded when the
app first opens. They load only when someone exports a chat to one of those formats.

- About 870 KB less JavaScript is fetched on the first page load, which helps most on slow or
  proxied networks.
- Exporting to DOCX, PPTX or XLSX downloads the needed library once, the first time it is used,
  so that first export can take a moment longer. The exported files are unchanged.
