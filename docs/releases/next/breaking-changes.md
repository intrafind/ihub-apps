# Breaking Changes — Unreleased

## Sources are now Projects

Admin-configured sources have become **admin projects**: the knowledge an admin links to apps,
workflows and agents, kept as encrypted text with per-document search. Every entry of
`config/sources.json` is migrated to `contents/projects/<id>.json` with the same id and one item
of the source's kind, so apps, workflows and agents keep their knowledge. The admin pages are now
**Projects**.

- The `sources` list on apps, workflows, workflow nodes, planner task templates and agent
  profiles is renamed to `projects`. A prompt source becomes `{ "id": "…", "mode": "context" }`
  (always in the prompt), a tool source `{ "id": "…", "mode": "tools" }` (reachable through the
  knowledge tools). There are no aliases: a configuration that still says `sources` is rejected
  by validation.
- The `source_<id>` tools are gone. Apps, workflow nodes and agents that link a project get the
  tools `knowledge_search`, `knowledge_read` and `knowledge_list` automatically. System prompts
  that told the model to call "the source tool" or to pass `section` should be reworded; the
  shipped iHub Support Bot prompt is updated by migration when it was not customised.
- The `{{sources}}` and `{{source}}` placeholders are renamed to `{{projects}}` by migration; a
  prompt without the placeholder gets the projects block appended, as before.
- The admin API `/api/admin/sources*` is replaced by `/api/admin/projects*`. The file-editing
  routes under `/api/admin/sources/:id/files` are replaced by
  `PUT /api/admin/projects/:id/items/:itemId/text`, which replaces the stored text of an
  uploaded, written or migrated document.
- The MCP gateway exposes `ihub://project/<id>` resources instead of `ihub://source/<id>`.
- The feature flag `sources` and the admin page switch `admin.pages.sources` are renamed to
  `projects`; their values are carried over.
- Files under `contents/sources/` (and the shipped FAQ, meeting knowledge base and iHub
  documentation) are imported into encrypted project storage at the first start. The copy under
  `contents/sources/` is deleted once its project item shows as ready; the consolidated
  documentation is refreshed from the shipped defaults whenever it changes.
- `config/sources.json` is kept as `config/sources.json.migrated` for reference and is no longer
  read.

**Before upgrading:** back up `contents/`. The migration is forward-only. If you deploy several
instances, every instance needs the same `TOKEN_ENCRYPTION_KEY` (or the same
`contents/.encryption-key`) and a shared volume, or the same storage provider, for
`contents/data/blobs/project-files`. After the start, check **Admin → Projects**: every migrated
item should show as *ready*; a *failed* item names the file it could not import.
