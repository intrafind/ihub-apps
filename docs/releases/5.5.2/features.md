# Features — 5.5.2

## Personalized iAssistant Context with Prompt Variables

The iAssistant *Extra Context* and *System Prompt Preamble* settings now support global prompt
variables — the same `{{user_name}}`, `{{user_email}}`, `{{date}}`, `{{timezone}}` and
admin-defined custom variables that already work in system prompts. The values resolve against
the requesting user when a conversation starts, so the assistant addresses each user personally
instead of carrying one fixed identity for everyone.

- A default **iAssistant** app ships with the platform: disabled until an admin enables it, with
  the model selector hidden and an extra context that introduces the requesting user by name,
  email and current date.
- Installations whose iAssistant app still carries the hardcoded test context ("My name is
  Daniel …") get it replaced by the templated default automatically; any other custom extra
  context is left untouched.

## Pluggable Storage Providers (Groundwork)

Runtime data — chats, run ledgers, workflow state — is moving behind a **storage provider** so a
later release can keep it in SQLite, PostgreSQL or OpenSearch instead of on disk. This release
ships the abstraction and its filesystem provider, and moves the first consumers onto it: durable
chats, the run ledger, workflow state, interactions and configuration. On an existing installation
the on-disk layout and behaviour are unchanged — the filesystem provider writes what was already
being written, in the same place.

- `platform.json` gains a `storage` section: `storage.provider` (`filesystem`, the only provider
  that ships today) and `storage.filesystem` with `dataDir` (under `contents/`, default `data`)
  and `flushIntervalMs`. A configuration migration adds the block to existing installations.
- `IHUB_STORAGE_PROVIDER` overrides the configured provider per environment. Changing the provider
  requires a server restart.
- The filesystem provider stores documents, append-only log streams, blobs and locks under
  `contents/data/`, keeps a per-owner index so "list my chats" never scans a namespace, and
  reports what it can and cannot do (no transactions, in-process change notification,
  single-instance) rather than leaving that to guesswork.
- This is the foundation for durable chats: closing the browser mid-answer without losing the
  reply, chat history, and continuing a past conversation.

See [Storage Providers](../../storage.md).

## Durable Chats: Conversations Stored Server-Side (Preview)

Chats can now be stored on the server instead of only in the browser: the transcript survives a
reload, a new device and a lost connection, and a turn that is being stored **keeps running when
the browser closes** — the answer is waiting in the chat when the user comes back. The feature is
off by default (`features.chatPersistence`, "Durable Chats") and still marked preview, so try it
on a test installation before turning it on in production.

- **A cost decision, not only a convenience.** Runs no longer die with the tab, so tokens are
  spent on answers nobody may read — a user who closes the laptop mid-answer is billed for the
  whole answer. The Stop button still aborts immediately, and now works even when no browser is
  connected. Anonymous and incognito turns are unaffected and are still cancelled on disconnect.
- **Enabling durable chats also enables the run ledger**, because a stored turn is materialized
  from its run's events. Plan for the ledger's disk use and retention
  (`platform.runLog.retentionDays`) before switching this on.
- **Anonymous visitors and incognito turns are never stored**, by design: an anonymous principal
  gets a new id on every request, so such a chat could never be listed or reloaded again.
- `platform.json → chats` sets `enabled`, `retentionDays` (90) and `maxChatsPerUser` (200); a
  daily sweep deletes what falls outside either limit, and a value of zero or less switches that
  rule off. A configuration migration adds the section to existing installations. It does **not**
  turn durable chats on for installations that had the old Chat History preview enabled — that
  preview showed sample data, so it never asked about storing real conversations; the upgrade
  warns and leaves the new flag off.
- New endpoints `GET/PATCH/DELETE /api/chats[/:id]` list, open, rename and erase a user's own
  chats; deleting one also erases its runs, their recorded events and their pending questions.
  Chat streams, chat posts and the stop endpoint now verify that the caller owns the chat id, not
  just that they may use the app.

See [Chat Persistence](../../chat-persistence.md).

## Chat History: Reopen and Continue a Past Conversation

With durable chats switched on, the conversations the server stores now appear in the product: the
sidebar lists the recent ones, `/chats` shows them all, and opening one reopens it inside its app
with the whole transcript, ready to carry on. This is the client half of Durable Chats — until now
stored chats had no UI at all, and the sidebar's chat list was sample data behind a separate
preview flag, which is retired.

- **Three places to pick a chat back up.** A *Recents* section in the sidebar (with an *All chats*
  entry that survives collapsing it to the icon rail), the full `/chats` page — grouped by date or
  by app, searchable, paged with **Show older chats** — and up to three *Pick up where you left
  off* chips on the start page.
- **Opening one continues it.** A chat opens at `/apps/:appId/c/:chatId` and loads its transcript
  from the server instead of from the browser tab, so a conversation started on another device, or
  in a tab that has since been closed, picks up exactly where it stopped. Reloading an app
  restores its current conversation for the same reason.
- **"Answered while you were away."** A chat whose answer finished with nobody watching is marked
  with a dot in the sidebar and a **New** badge in the list, and the mark clears when the chat is
  opened. That is what durable runs are for: close the laptop mid-answer, come back, read the
  reply.
- **Rename and delete.** Titles can be renamed in place from either list; deleting asks for
  confirmation and then erases the conversation, its transcript and its runs for good.
- **Nothing unstored is listed.** Anonymous visitors, incognito (ephemeral) chats, compare panels
  and the canvas are never stored, so they never show up in the history — and with the feature
  off, or without a working storage provider, the history UI is absent entirely.
- **The chat client posts one message per turn** for a stored chat, which is what a
  server-assembled history requires; anonymous and incognito chats keep the previous protocol
  unchanged. Editing or regenerating a turn rewrites the stored transcript from that point,
  whether the turn came back from the store or was sent a moment ago, and switching off
  *Include chat history in requests* still gives the model just the one message.
- **Opening another chat mid-answer no longer cancels it.** Leaving a conversation while it is
  still streaming releases the browser's connection and nothing else; the answer keeps being
  written and is waiting when the chat is reopened. Only the Stop button cancels a turn.

See [Chat Persistence](../../chat-persistence.md).

## Runtime Data Moves Behind the Storage Provider

The run ledger, workflow execution records, human interactions and the
iAssistant conversation mapping now go through the same storage provider
durable chats already used, instead of each service writing files of its own.
This is a consolidation: behaviour is deliberately unchanged, with the
exceptions below, which are fixes.

- **The run index is per-user now, not per-day.** A new `runs` namespace holds
  one summary document per run — chat, workflow execution and agent run alike
  — owned by the principal that started it. It replaces both the ledger's daily
  `index/<date>.jsonl` files and `execution-registry.json`. Listing a user's
  runs is an index read instead of a scan, and two workers recording two
  different runs can no longer erase each other, which one shared registry file
  rewritten in whole allowed.
- **Executions are visible on every worker.** With the default four workers, a
  workflow or agent run started on one worker could be missing from *My
  Executions*, from the admin execution list and from an agent's running-run
  count when the next request landed on another worker. It is not any more.
- **Finished workflow state is swept.** New `platform.workflowState` settings —
  `retentionDays` (30) and `cleanupEnabled` — delete terminal executions on the
  same daily cadence as the chat and ledger sweeps: the state, the run summary,
  and the `wf-child-…` sub-workflow states that no delete button ever reached.
  Nothing removed any of that before, and each state carries a full workflow
  definition and every node result. Set `retentionDays` to zero or less to keep
  the previous behaviour of never deleting. A configuration migration adds the
  section to existing installations.
- **iAssistant conversations survive a restart and a worker hop.** The mapping
  from a chat to its remote conversation lived in per-worker memory, so a
  second turn landing on another worker quietly created a *second* conversation
  and reset threading. It is stored now, and written off the streaming path so
  answers are not slowed down by it.
- **Pending interactions are documents.** They still survive a restart, and are
  still persisted whether or not the run-ledger flag is on. An answer is still
  accepted by exactly one worker, now through a lease over the shared record
  rather than exclusive claim marker files; the `409` a concurrent or late
  answer receives is unchanged.
- **Existing data is imported on the first boot, and nothing is deleted.** The
  daily run index, the execution registry, the `<executionId>/latest.json`
  checkpoint directories and pending interactions are carried into the new
  namespaces once, idempotently, by one worker. The old files stay exactly
  where they are and are still read for everything not carried over —
  including every run's recorded events, which are read in place and never
  imported. A rollback to the previous release therefore finds its own data
  intact; what it does not see is anything the newer release wrote after the
  upgrade.
- **Without a storage provider nothing changes.** Each of these stores falls
  back to the layout and the behaviour it had before. That is a supported
  state, not an error.

See [Run Ledger](../../run-ledger.md), [Workflows](../../workflows.md) and
[Storage Providers](../../storage.md).

## Configuration Is Read and Written Through the Storage Provider

Configuration — `platform.json` and its siblings, every app, model, prompt,
tool, workflow and agent profile, the locale overrides and the page bodies —
now goes through the same storage provider as runtime data, instead of every
admin route, loader and installer reaching for the files itself.

**Your `contents/` directory does not change.** Not a path, not a byte. The
provider serves configuration through *raw namespaces*: the JSON file at
`contents/<dir>/<key>.json` is the document, written with the serializer that
has always written it (two-space indent, no trailing newline). Hand-editing,
`git`, docker mounts, seeding from `server/defaults/` and the configuration
migrations all keep working unchanged, and the acceptance test for the change
is exactly that — a populated tree is hashed file by file, driven through a
boot and a save of every configuration type, and hashed again.

- **Admin saves are visible immediately.** This is a real behaviour change.
  `configLoader` kept its own 60-second cache underneath `configCache`, and
  nothing invalidated it: after saving a setting, the server could go on
  serving the previous value for up to a minute, with the correct value
  already on disk and nothing in the logs to explain it. That cache is gone —
  `configCache` was always the cache that mattered. Page bodies (the markdown
  and JSX behind custom pages) are still kept in memory between requests, but
  on the file's modification time rather than on a clock: an edit is served on
  the very next request, whether it came from the admin UI, a `git` checkout or
  a mounted volume.
- **A relocated `contents/` directory works for apps and models too.** The
  loader behind apps, models, prompts, tools, workflows and agents built a
  hardcoded `contents/` path and ignored the `CONTENTS_DIR` setting, so an
  installation that relocated the directory silently loaded none of them. It
  reads through the store now, like everything else.
- **Configuration never depends on optional runtime storage.** The provider is
  configured from `platform.json`, so that file is read before any provider
  exists, and an installation whose provider fails to come up reads and writes
  configuration exactly as before. A broken `storage` block cannot stop the
  server from reading the file that block lives in.
- **A CI guard keeps the seam closed.** `npm run lint:config-access` fails the
  build on any direct filesystem access to a configuration path outside the
  store. Five subsystems genuinely cannot go through it — the migration
  runner, encryption key material, backup export/import, the locales that ship
  with the application, and the cold-cache fallback of the synchronous
  group-permission read in the admin middleware path — and each is an
  allowlist entry whose reason the guard prints on every run.
- **Cross-instance invalidation is now wired, and waiting for a provider.**
  The config cache follows the provider's change stream in addition to the
  existing cluster announcement, never instead of it. On the filesystem
  provider that stream is in-process and the addition changes nothing today;
  it is what lets a save on one instance invalidate every other instance's
  cache the day a push-capable provider ships.

See [Configuration Storage](../../configuration.md) and
[Storage Providers](../../storage.md).
