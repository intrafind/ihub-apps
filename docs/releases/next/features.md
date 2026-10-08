# Features — Unreleased

## API Key Status for Models and Providers

A key that is stored but cannot be read used to look like a missing one. When the server's
encryption key is not the one a key was saved with — several instances without a shared
`TOKEN_ENCRYPTION_KEY`, or a lost `contents/.encryption-key` — chat failed with "API key not found"
although a key was set, and nothing said why.

- **Admin › Models** has an **API key** column and the model editor shows the status under the key
  field. **Admin › Providers** shows it for LLM providers instead of a plain "Configured".
- The states are **Key found** (and where it comes from: the model, its provider or an environment
  variable), **No key needed**, **No API key** and **Stored key unreadable**.
- A stored key that cannot be decrypted is reported as such, in the status, in the model test and
  to chat users, who see a message that an administrator has to enter the key again. The server log
  names the cause.
- A key from the environment still wins over an unreadable stored one.
- The last step of the setup guide says how many enabled models are ready to use and links to the
  models when some still lack a key. Choosing a cloud provider now points to **Local Provider** and
  to skipping the step for those who have no key yet.

If you run more than one instance, set the same `TOKEN_ENCRYPTION_KEY` on all of them.

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
