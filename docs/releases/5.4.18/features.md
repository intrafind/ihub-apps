# Features — 5.4.18

## Configuration Changes Now Reach Every Worker Immediately

With `WORKERS` greater than 1, an admin save only reached the worker that handled the request. Every
other worker kept serving the previous configuration until its cache expired, so a saved change
looked applied on one page load and reverted on the next — and a deleted app stayed visible on the
workers that had not handled the delete.

- Saving, creating, deleting or toggling anything in the Admin UI now takes effect on all workers at
  once: apps, models, prompts, tools, workflows, agents, sources, providers, groups, users, pages,
  skills, MCP servers and platform settings.
- Runtime settings that were previously applied only in the worker serving the request now follow
  too — log level and logging config, telemetry, usage-tracking mode, iFinder/iAssistant connection
  settings and outbound MCP server connections.
- Backup import and the admin **Clear cache** / **Refresh cache** actions reload every worker.
- No configuration change is needed. `GET /api/admin/cache/stats` gains a `sync` block with the
  per-worker announce/receive counters if you want to confirm changes are propagating.

## OIDC and OAuth Logins No Longer Fail Intermittently on a Fresh Install

On the very first start of a multi-worker installation, each worker could generate its own JWT
signing key and its own secret-encryption key, because they all raced to create the key files before
any of them existed. A user who logged in was then authenticated on some workers and rejected with
"Authentication required" on others, seemingly at random, and secrets encrypted by one worker could
not be decrypted by another.

- The first worker to create each key file now wins and the others adopt it, so a cold start ends
  with one signing key and one encryption key for the whole cluster.
- Only fresh installations were affected. Existing installations already have the key files on disk
  and were reading them correctly.
- **If you hit this**, `contents/.jwt-private-key.pem`, `contents/.jwt-public-key.pem` and
  `contents/.encryption-key` may hold a key that only one worker was using. Existing sessions will
  need a re-login after upgrading. Any secret that was saved in the Admin UI while the keys were
  mismatched should be re-entered, since it may have been encrypted with a key that is no longer on
  disk. Setting `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` and `TOKEN_ENCRYPTION_KEY` explicitly avoids the
  situation entirely and is recommended for multi-replica deployments.

## Cited Passages Can Now Be Located and Highlighted Inside the Source Document

When an app uses iFinder as its search backend, the passages listed under a chat answer's
**Documents** section can now be opened directly in the document they came from. The document opens
in an in-app PDF preview with every cited passage highlighted, scrolled to the first one.

- Each passage in an expanded document gets a magnifier button that opens the preview at that
  passage. The overflow menu's **Preview (PDF)** entry opens the same viewer with all of the
  document's cited passages highlighted.
- The preview replaces the previous behaviour of opening the converted PDF in a new browser tab,
  which could not highlight anything. It adds highlight-to-highlight navigation (also `Enter` /
  `Shift+Enter`), a page count, zoom, download, and a per-passage filter when a document is cited
  more than once.
- Passage text and the generated preview PDF do not match character-for-character — the PDF's text
  layer differs in whitespace, ligatures, hyphenation and page furniture such as headers and
  footers. Matching therefore compares only letters and digits, so passages are still found across
  those differences, in any script (including Cyrillic and CJK), and across page breaks.
- A passage that a header or footer interrupts at a page break is highlighted sentence by sentence
  rather than not at all. If a passage genuinely cannot be located, the preview still opens and
  reports "Passage not found" instead of failing.
- Documents without a downloadable version are unaffected: the passage button and preview entry
  only appear where iFinder exposes document access.
