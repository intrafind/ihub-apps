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
