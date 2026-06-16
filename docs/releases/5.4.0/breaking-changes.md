# Breaking Changes — 5.4.0

## /admin/system URL Removed

The `/admin/system` route no longer exists. It redirects to `/admin/security`.

**Before upgrading:** Update any bookmarks or documentation pointing to `/admin/system`.
The redirect is permanent — no action required for normal usage.

## App `tokenLimit` removed; models split into `contextWindow` + `maxOutputTokens`

Apps no longer configure a token limit. The context window and output cap now come entirely from the selected model. On models, the single `tokenLimit` field is replaced by `contextWindow` (total context) and `maxOutputTokens` (response cap).

- App configs: the `tokenLimit` field is removed and is no longer accepted by the schema.
- Model configs: `tokenLimit` is renamed to `contextWindow`; a new `maxOutputTokens` field controls the response cap.

**Before upgrading:** No manual action required. A configuration migration runs automatically on startup — it renames `model.tokenLimit` to `contextWindow`, seeds a sensible per-provider `maxOutputTokens` default, and strips `tokenLimit` from all app configs. Review the seeded `maxOutputTokens` values afterward if you need larger responses for a specific model.
