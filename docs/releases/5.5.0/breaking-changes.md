# Breaking Changes — 5.5.0

## `config/tools.json` Is Removed

Tool configuration no longer supports the shared `contents/config/tools.json` array. Every tool
now lives in its own file under `contents/tools/`, and there is no fallback to the old file.

- A configuration migration runs automatically on upgrade: it splits any existing
  `contents/config/tools.json` into individual `contents/tools/<toolId>.json` files and deletes
  the old file. No manual action is required.
- `deepResearch`, `answerReducer`, `evaluator`, `queryRewriter`, and `researchPlanner` have been
  retired and are removed by the same migration, whether they were still in the legacy file or
  already split into their own file.
- Custom tools you added directly to `config/tools.json` are preserved — they're carried over into
  their own file with the same ID.

**Before upgrading:** No action needed; the migration handles the conversion automatically. If you
have external tooling that reads or writes `contents/config/tools.json` directly, update it to
manage individual files under `contents/tools/` instead.
