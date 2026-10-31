# Integration Versioning, Compatibility and Migrations

**Date:** 2026-10-31 · **Status:** concept, decisions requested · **Epic:** [#2911](https://github.com/intrafind/ihub-apps/issues/2911) · **Builds on:** [Unified Integrations](../2026-10-20%20Unified%20Integrations/README.md), [CKAN walking skeleton](../2026-10-30%20CKAN%20Open%20Data%20Integration/README.md)

## Requirement

> Integrations have a version and a compatibility. Each version has migration support, so the marketplace shows what changed between versions and an admin updates the local integration without updating the whole iHub. Integrations become small iHubs: release notes, a version, a minimum iHub version. Installing an update runs the migrations the update needs, inside the integration.

## Summary

An integration definition already carries a semantic `version` and every installation records the `definitionVersion` it was created with. This concept adds the three missing pieces: a **compatibility** declaration the catalog, the installer and the registry enforce; a **release history** (per-version changelog) the marketplace shows as "what changes between your 1.2.0 and 1.4.0"; and **definition migrations** that bring an installation's stored values, action policy and app bindings from one definition version to the next, run automatically when the definition changes, whether through a marketplace update or an iHub release that ships a newer built-in. Migrations are declarative by default (field renames, value rewrites, action renames) so an untrusted catalog can ship them; a migration module is allowed only from a registry with `trustCode`, under the same hash check as a `script` connector. Everything is forward-only with a backup, like the config migrations in `server/migrations/`.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Definition version** | `version` in `integration.json`, semver. Changes whenever the folder changes. |
| **Installed version** | `installed[].definitionVersion`: the definition version the installation's values were last written for. |
| **Compatibility** | `compatibility.ihub`, a semver range the definition works with (`">=5.7.0 <7"`). Checked against the server's `package.json` version. |
| **Release** | One entry of the definition's `releases` list: version, date, notes, the migration that version needs. |
| **Definition migration** | A transformation of one installation (and the apps bound to it) from an older installed version to the current definition version. |

## 1 · The definition format

```jsonc
{
  "id": "org.ckan/open-data-portal",
  "version": "1.4.0",
  "compatibility": { "ihub": ">=5.7.0 <7" },        // new, semver range
  "releases": [                                      // new, newest first
    {
      "version": "1.4.0",
      "date": "2026-11-12",
      "notes": { "en": "DataStore search returns `total`; new action `resource.preview`.", "de": "…" },
      "migration": "1.4.0"                           // id of a migration below, optional
    },
    { "version": "1.3.1", "date": "2026-11-02", "notes": { "en": "Fix: publisher listing beyond 25 entries." } },
    { "version": "1.3.0", "date": "2026-10-28", "notes": { "en": "Renamed install field `fq` to `defaultFilter`." }, "migration": "1.3.0" }
  ],
  "migrations": [                                    // new, declarative
    {
      "id": "1.3.0",
      "steps": [
        { "renameValue": { "from": "fq", "to": "defaultFilter" } },
        { "renameAction": { "from": "search", "to": "dataset.search" } }
      ]
    },
    {
      "id": "1.4.0",
      "steps": [
        { "setValue": { "key": "rows", "value": 20, "when": "missing" } },
        { "module": "migrations/1.4.0.js" }          // code, trustCode only
      ]
    }
  ]
}
```

- `releases[].notes` are the changelog the marketplace and the installed list show. A release without `migration` changes nothing an installation stores.
- Migration ids are the version they bring an installation **up to**; the registry runs every migration with `semver.gt(id, installedVersion) && semver.lte(id, definition.version)`, in semver order. Skipping versions therefore works: 1.2.0 → 1.4.0 runs 1.3.0 and 1.4.0.
- Declarative steps: `renameValue`, `setValue` (`when: missing | always`), `removeValue`, `mapValue` (`{ key, map: { old: new } }`), `renameAction`, `removeAction`, `renameScope`. They touch `values`, `actions.enabled/disabled/overrides`, and the app bindings `app.integrations[<instanceId>].actions` / `defaultScope` / `pinnedScope`. Nothing else is reachable from a declarative step.
- A `module` step is a companion file exporting `up({ instance, apps, definition, from, to, log })` and returning the changed instance; it may change apps through the given list only. It is allowed only when the definition came from a registry with `trustCode` and the file's hash is in `source.integrity`, the same rule as for a `script` connector. Built-in definitions may always use modules (they ship with the server).
- The definition schema gets `compatibility` and `releases` as optional and `migrations` as optional; a definition without them behaves as today (every version compatible, no notes, no migration).

## 2 · Compatibility enforcement

| Where | Rule |
| --- | --- |
| Catalog (marketplace page) | An item whose current `compatibility.ihub` does not match the server is shown greyed with "needs iHub ≥ 6.0, this server runs 5.7.2"; **Install** and **Update** are disabled. The catalog item carries `compatibility` (the generator copies it from `integration.json`), so no download is needed to decide. `minVersion` on catalog items stays as the short form and is read as `>=minVersion`. |
| Install / update (`ContentInstaller`) | Rejects with `INCOMPATIBLE_IHUB_VERSION` even when called directly. |
| Registry load (`IntegrationRegistry`) | A definition on disk that no longer matches (iHub downgraded, or a definition copied in by hand) loads as `status: incompatible`; its installations are listed with a warning and offer no tools. |
| Definition schema itself | `compatibility.schema` (integer, default 1) says which definition-format revision the file uses. A server that does not know the revision refuses to load the definition instead of ignoring unknown fields. |

The server version comes from the root `package.json` (already used for the update checker); prereleases compare with `semver`'s `includePrerelease`.

## 3 · Running migrations

**Trigger.** Whenever the registry loads a definition whose `version` differs from an installation's `definitionVersion`:

1. Marketplace update (`ContentInstaller.update`) after the folder is written, before `invalidate` and `syncIntegrationScopeProviders`.
2. Server start, for built-in definitions that an iHub release updated (`IntegrationRegistry.load` after `server/migrations` ran).
3. Manual: `POST /api/admin/integrations/installed/:id/_migrate` for an installation left behind (migration failed earlier, definition copied in by hand).

**Procedure** (`DefinitionMigrationRunner`, `server/services/integrations/definitions/`):

1. Snapshot `config/integrations.json` and the bound app files to `contents/backups/integrations/<id>-<from>-<timestamp>/` (same helper as the marketplace backups).
2. Run the applicable migrations in order; each step validates against the new definition's `install` fields after it ran (`checkInstallValues`), so a migration that leaves an invalid installation fails fast.
3. Write the installation with `definitionVersion = definition.version` and a `migrationLog` entry `{ from, to, at, steps, warnings }` (kept to the last 10); write changed apps; `invalidate`, `syncIntegrationScopeProviders`, refresh caches.
4. On failure: restore the snapshot, keep `definitionVersion` as it was, mark the installation `status: migrationFailed` with the error, and keep it disabled for tool loading until an admin resolves it (re-run, or edit and save, which writes the current `definitionVersion`). Never half-migrated.

**Downgrade** (iHub downgraded, or "revert to previous version" in the marketplace): the definition is older than `definitionVersion`. Migrations are forward-only, so the runner restores the latest snapshot whose `to` equals the definition's version if one exists, otherwise marks the installation `status: needsReview` and leaves it disabled. The marketplace "Revert" button is therefore exactly "restore the backup the update made".

**Cluster.** Migrations run on the worker that applied the update (or the primary at startup); other workers pick up the written files through the existing config-change hooks, like `InstalledIntegrationService._afterChange`.

## 4 · What the admin sees

**Marketplace → Integrations.** An installed item with a newer catalog version shows **Update 1.2.0 → 1.4.0**. Clicking opens a dialog with the release notes of every version in between (newest first), the compatibility line, and, when a migration applies, "This update changes 2 install values and 1 action of the installation *GovData*; a backup is made first." Confirm runs update + migration and reports the migration log. Incompatible versions are shown but disabled with the reason.

**Integrations → Installed.** The row shows the installed version; a tooltip or detail shows the definition version and the last migration. `migrationFailed` and `needsReview` rows carry a red pill with **Re-run migration** and **Restore backup**.

**Integration detail (catalog).** A **Releases** tab lists the changelog; the **Compatibility** line sits next to the author and license.

## 5 · The marketplace repository

- `integrations/<folder>/integration.json` keeps `releases`, so the catalog generator emits per item: `version`, `compatibility`, `releases` (notes only, the last 20) and `integrity`. One folder, one current version: older versions are reachable through git tags `integrations/<id>@<version>`; the catalog carries `versions: [{ version, ref }]` so a registry can serve `?version=` for a pinned install (phase 2).
- `scripts/validate.js` fails when `version` changed without a new `releases[0]` entry of that version, when an install field or action was renamed or removed without a migration touching it (a structural diff against the previous tag), or when a `module` step exists without an `integrity` hash.
- Registry setting `channel: stable | all` and per-item `pin: "1.3.x"` are phase 2; phase 1 always offers the catalog's current version.

## 6 · Phasing

| Phase | Scope | Size |
| --- | --- | --- |
| **1 · Compatibility and notes** | `compatibility`, `releases`, schema; catalog generator copies both; marketplace greys incompatible items, shows the notes between installed and latest; `incompatible` registry status | ~1 week |
| **2 · Declarative migrations** | `migrations` with declarative steps, runner with snapshot/restore and `migrationLog`, triggers 1–3, `migrationFailed` / `needsReview`, admin re-run and restore; marketplace validator diff check | ~2 weeks |
| **3 · Module migrations and pinning** | `module` steps under `trustCode` + integrity, catalog `versions`, registry pin/channel, "Revert" | ~1 week |

Built-ins adopt the format in phase 1: iFinder, iAssistant, web search, the MCP and A2A definitions get `releases` with what V192–V195 did, and the first iHub release after phase 2 migrates installations through the runner instead of a numbered `server/migrations/V*.js` when only an installation's values change.

## 7 · Decisions requested

1. **Declarative-first.** Catalog integrations without `trustCode` get declarative steps only. Agreed, or should every registry be allowed to run migration modules (the installer verifies hashes either way)?
2. **Failure policy.** A failed migration leaves the installation disabled until an admin acts. Alternative: keep serving the old values with a warning (risk: tools call a definition the values no longer fit).
3. **Where the notes live.** `releases` inside `integration.json` (one file, validated by schema) versus a `CHANGELOG.md` companion (nicer to write, not machine-readable). The concept takes `releases` in JSON with localized notes; Markdown in `notes` is rendered.
4. **Numbered config migrations stay for everything that is not an installation** (platform.json, apps, groups). Only the per-installation part moves into the definition. Confirm.
5. **Compatibility range vs minimum.** The requirement names a minimum; the concept uses a range so a definition can also say "not on iHub 7" when the adapter contract changes. Confirm the range.

## Open questions

- Should an app binding be versioned too (an app that relies on action `dataset.search` existing)? The migration rewrites bindings, which covers renames; removals leave the app with fewer tools and a warning in Admin → Apps.
- Several installations of one definition migrate independently; one failing must not block the others. The runner treats each installation as its own unit of work.
- Telemetry: should the installed list report "updates available" to the admin changelog ("What's New") like iHub releases do?
