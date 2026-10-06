# Breaking Changes — 5.5.35

## Web Page Reader Tool Renamed From `webContentExtractor` to `read_url`

The built-in page reader tool now has the id `read_url` instead of `webContentExtractor`. The model
picks a tool by its id, and the shorter, plainer `read_url` says what the tool does — open a URL —
so the model stops confusing it with reading a skill's bundled files. The tool's behaviour, its
parameters and its display name ("Web Page Reader") are unchanged.

A migration renames it automatically on startup: the tool definition, every reference to it in app,
workflow and agent tool lists, and the id where an app's instructions name it in a prompt. No admin
action is needed for configuration stored in iHub. (In the rare case that a different tool of your
own already uses the id `read_url`, the migration fails and startup halts with a message naming the
clash — rename or remove that tool, and the migration completes on the next start.)

**Before upgrading:** If anything outside iHub's own configuration refers to the tool by id — an API
client that enables tools by id, or an external automation — update `webContentExtractor` to
`read_url`.
