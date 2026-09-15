# Breaking Changes — 5.4.20

## iFinder Source Configuration Schema Simplified

The `config` block of `ifinder` sources no longer accepts `baseUrl`, `apiKey`, `queryTemplate`,
or `filters`. These fields were never used when loading documents — the connection has always
come from the central iFinder integration — but they are now rejected on save instead of being
stored silently. Document selection moves to the new `documentId` / `query` fields, and sources
exposed as prompt context must set one of them.

- Migration V083 cleans stored sources automatically: it removes the dead connection fields,
  carries a non-empty `queryTemplate` over to `query`, and drops the auto-injected
  `searchProfile: "default"` so the platform-wide profile applies.

**Before upgrading:** No action needed for stored configurations; the migration converts them
automatically. If external tooling creates or updates iFinder sources through
`/api/admin/sources`, remove the `baseUrl`/`apiKey`/`queryTemplate`/`filters` fields from its
payloads and set `documentId` or `query` instead. Verify the central iFinder integration
(Admin → Providers → iFinder) is configured, since sources rely on it for connectivity.
