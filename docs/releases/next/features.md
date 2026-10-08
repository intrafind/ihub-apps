# Features — Unreleased

## Scheduled Tasks Can Remember Between Runs

A scheduled task can now keep notes between its runs and look at its earlier runs, so a weekly "what
are the latest features of …?" reports only what is new instead of the same summary every week. It
is opt-in per task: tick **Remember between runs** on the task form.

- At the start of a run, the task reads its notes and its last successful run, then reports only
  what is new or changed. After a successful run, its notes are updated automatically — the model
  does not have to remember to write them.
- The **Memory** card on the task page shows the notes, and the owner can edit or clear them. If a
  run changes the notes while you are editing, the editor says so instead of overwriting them.
- **Notify me → Only when something changed (and on failures)** keeps a quiet week quiet: a run
  that found nothing new creates no notification. Failed runs always notify.
- Notes are private to the task's owner. Admins see only their size, version and last update, and
  can clear them, in Admin → Scheduled Tasks.
- Turning memory off keeps the notes; duplicating a task starts the copy with empty notes; deleting
  a task deletes its notes.
- New platform settings in Admin → Scheduled Tasks → Settings: `memoryEnabled` (default on),
  `memoryMaxChars` (default 8000) and `maxHistoryReadChars` (default 8000). Existing installations
  get them, and the new option in the scheduling tools, automatically on upgrade.
- Agents keep their memory exactly as before; tasks use the same memory tools and editor.

See [Scheduled Tasks](../../scheduled-tasks.md#memory-and-earlier-runs).
