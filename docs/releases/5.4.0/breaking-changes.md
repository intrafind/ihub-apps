# Breaking Changes — 5.4.0

## /admin/system URL Removed

The `/admin/system` route no longer exists. It redirects to `/admin/security`.

**Before upgrading:** Update any bookmarks or documentation pointing to `/admin/system`.
The redirect is permanent — no action required for normal usage.

## Integration Secrets Moved to the Central Credential Store

All integration secrets are now stored in the central credential store (`contents/config/credentials.json`) and referenced by a credential profile, instead of being held inline in `platform.json` / `mcpServers.json`. This affects Jira, OIDC, LDAP, NTLM, cloud storage, iFinder, and MCP server auth. There is no backward-compatible inline path.

**Before upgrading:** None required — migration **V057** runs automatically on startup. It moves every existing inline secret into a credential profile (reusing the existing encryption, so values are not re-encrypted) and rewrites each section to reference it. After upgrading, manage these secrets under **Admin → Credentials**; the per-integration forms now show a credential selector instead of a secret field.
