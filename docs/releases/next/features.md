# Features — Unreleased

## Group Access: Search Instead of a Long Checkbox List

The **Group access** card on the app, prompt, skill, tool and workflow edit pages — shipped in
v5.5.8 as one checkbox per group — now shows the groups that already have access as chips, with a
search box below to find and grant the rest. This keeps the card usable once a deployment has a
lot of groups, where the checkbox list grew too long to scan.

- Removing a chip revokes access; picking a group in the search results grants it — the same
  search-and-add pattern already used to add apps, models or prompts to a group elsewhere in the
  admin area, instead of a plain checkbox list.
- A group that holds a wildcard (`"*"`) for the type still shows as a locked chip: a single item
  cannot be withdrawn from a wildcard.
- A group that would already get the content through a parent group still says so in the search
  results.
- Grant/revoke semantics, content-admin scoping, and the change-history/audit trail are unchanged
  from v5.5.8 — this is a UI-only change.

## What's New Remembers the Version You Upgraded From

iHub now writes down which version it is running and keeps the one it replaced, so **What's New**
can show what an upgrade actually brought in. Jump from 5.4.3 to 5.5.1 and all six releases in
between are marked **New**, not just the one you are running — a banner above the list names the
jump and how many releases are new to this installation.

- The **New** badge no longer depends on which releases you happened to open in this browser: it
  is the same for every admin on the installation, and survives a new browser or a new admin.
- A fresh installation has nothing to compare against, so it shows no banner and no badges. The
  first upgrade after this release is the first one that can be shown.
- The record lives in `contents/data/installed-version.json` and is written once per start. An
  installation whose `contents/` is read-only keeps working; it just cannot remember the jump.

## What's New Groups Its Release List

The release list is a tree — `5.x` holds `5.5.x` holds the releases — instead of one list that
grew by a row per patch release. Only the groups worth opening start open: the one holding the
release on screen and the one holding the release you are running.

- A series with more than ten releases lists the newest ten and keeps the rest behind
  **Show N older**.
- Group headers carry the number of releases they hold and, when the last upgrade brought
  something in, how many of them are new — so a collapsed group still tells you whether to open it.
