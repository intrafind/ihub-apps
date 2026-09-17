# Breaking Changes — 5.4.22

## Filesystem Sources Must Live Under `contents/sources/`

Filesystem-source file operations (browse, read, write, delete, "Test connection") are now
hard-scoped to `contents/sources/`, closing a privilege-escalation gap where a restricted
**Content Admin** could reach any file under `contents/` — including `.encryption-key` and
`config/groups.json` — through the source file editor. A filesystem source's `config.path` must
now be `sources` or start with `sources/`, and no path segment may start with `.`.

- All bundled default sources already use the `sources/` prefix and are unaffected.
- A custom filesystem source you created with a `config.path` outside `sources/` (for example
  `data/file.txt`) will fail to load, and will be rejected if re-saved, after upgrading.

**Before upgrading:** If you have a custom filesystem source whose path is not under `sources/`,
move the target file into `contents/sources/` and update the source's `config.path` to match
(e.g. `sources/data/file.txt`) before or immediately after upgrading.
