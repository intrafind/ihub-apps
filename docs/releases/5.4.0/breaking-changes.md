# Breaking Changes — 5.4.0

## /admin/system URL Removed

The `/admin/system` route no longer exists. It redirects to `/admin/security`.

**Before upgrading:** Update any bookmarks or documentation pointing to `/admin/system`.
The redirect is permanent — no action required for normal usage.

## Integration Secrets Moved to the Central Credential Store

All integration secrets are now stored in the central credential store (`contents/config/credentials.json`) and referenced by a credential profile, instead of being held inline in `platform.json` / `mcpServers.json`. This affects Jira, OIDC, LDAP, NTLM, cloud storage, iFinder, and MCP server auth. There is no backward-compatible inline path.

**Before upgrading:** None required — migration **V060** runs automatically on startup. It moves every existing inline secret into a credential profile (reusing the existing encryption, so values are not re-encrypted) and rewrites each section to reference it. After upgrading, manage these secrets under **Admin → Credentials**; the per-integration forms now show a credential selector instead of a secret field.

## App `tokenLimit` removed; models split into `contextWindow` + `maxOutputTokens`

Apps no longer configure a token limit. The context window and output cap now come entirely from the selected model. On models, the single `tokenLimit` field is replaced by `contextWindow` (total context) and `maxOutputTokens` (response cap).

- App configs: the `tokenLimit` field is removed and is no longer accepted by the schema.
- Model configs: `tokenLimit` is renamed to `contextWindow`; a new `maxOutputTokens` field controls the response cap.

**Before upgrading:** No manual action required. A configuration migration runs automatically on startup — it renames `model.tokenLimit` to `contextWindow`, seeds a sensible per-provider `maxOutputTokens` default, and strips `tokenLimit` from all app configs. Review the seeded `maxOutputTokens` values afterward if you need larger responses for a specific model.

## Audit config consolidated under a single `audit` block

Audit retention settings moved from the top-level `auditLog` block into the unified `audit` block, alongside the new behavior/privacy options. `platform.auditLog.retentionDays` / `cleanupEnabled` are now `platform.audit.retentionDays` / `audit.cleanupEnabled`.

**Before upgrading:** No manual action required. Migration `V059` moves any admin-configured `auditLog` values into `audit` and removes the legacy block automatically on startup. Update any external tooling that reads `platform.auditLog` to read `platform.audit` instead.
