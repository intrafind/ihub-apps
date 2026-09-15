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
