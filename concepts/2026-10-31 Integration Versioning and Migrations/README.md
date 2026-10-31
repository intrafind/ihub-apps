# Integration Versioning, Compatibility and Migrations

**Date:** 2026-10-31 · **Status:** concept, decided 2026-10-31 (Daniel Manzke) · **Epic:** [#2911](https://github.com/intrafind/ihub-apps/issues/2911) · **Builds on:** [Unified Integrations](../2026-10-20%20Unified%20Integrations/README.md), [CKAN walking skeleton](../2026-10-30%20CKAN%20Open%20Data%20Integration/README.md)

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
      "summary": { "en": "DataStore search returns `total`; new action `resource.preview`.", "de": "…" },
      "notes": {                                     // companion files, the layout of docs/releases/<version>/
        "features": "releases/1.4.0/features.md",
        "fixes": "releases/1.4.0/fixes.md"
      },
      "migration": "1.4.0"                           // id of a migration below, optional
    },
    {
      "version": "1.3.1",
      "date": "2026-11-02",
      "summary": { "en": "Fix: publisher listing beyond 25 entries." },
      "notes": { "fixes": "releases/1.3.1/fixes.md" }
    },
    {
      "version": "1.3.0",
      "date": "2026-10-28",
      "summary": { "en": "Renamed install field `fq` to `defaultFilter`." },
      "notes": { "breaking": "releases/1.3.0/breaking-changes.md" },
      "migration": "1.3.0"
    }
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

- `releases[]` is the release history. `summary` is one localized line for lists and the update dialog. `notes` points at Markdown companion files in the definition folder, one per category with the same names as iHub's own release notes in `docs/releases/<version>/` (`features`, `fixes`, `breaking`); a category without changes has no file. The files are companion files like `connector.js` or an OpenAPI document: a package is published exploded, so the marketplace lists, inspects and fetches each file on its own and the catalog page renders a release's notes without downloading the package, the way a skill's `SKILL.md` references its further files. A release without `migration` changes nothing an installation stores.
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
| Definition schema itself | `compatibility.schema` (integer, default 1) says which definition-format revision the file uses. The registry reads it from the raw JSON **before** the Zod parse, because the parse strips unknown fields and would otherwise accept a newer revision silently; a revision the server does not know is refused before any other field is looked at, and the installer refuses it the same way (`UNSUPPORTED_DEFINITION_SCHEMA`). |

The server version comes from the root `package.json` (already used for the update checker); prereleases compare with `semver`'s `includePrerelease`.

## 3 · Running migrations

**Trigger.** Whenever the registry loads a definition whose `version` differs from an installation's `definitionVersion`:

1. Marketplace update (`ContentInstaller.update`): the new folder is staged, the migration runs against the staged definition, and only when the definition, the installation and the bound apps have been committed together does the registry swap the folder in and announce it (`writeInstalled` defers its `notifyDefinitionsChanged` to that point, so no worker ever sees the new definition with old values).
2. Server start, for built-in definitions that an iHub release updated (`IntegrationRegistry.load` after `server/migrations` ran).
3. Manual: `POST /api/admin/integrations/installed/:id/_migrate` for an installation left behind (migration failed earlier, definition copied in by hand).

A definition that is incompatible with the running iHub (section 2) never triggers a migration: its installations load as `incompatible` with their stored data untouched, so the matching definition or a later compatible server can still migrate them. A per-installation lock serialises an update, a startup run and a manual run on the same installation.

**Procedure** (`DefinitionMigrationRunner`, `server/services/integrations/definitions/`):

1. Snapshot `config/integrations.json`, the bound app files and the installed definition folder (the pre-update package) to `contents/backups/integrations/<id>-<from>-<timestamp>/` (same helper as the marketplace backups), with a manifest that records `representedVersion: <from>`. When an update spans several migrations, the runner also keeps a snapshot at every migration boundary it passed, each with the version it represents, so a later revert to an intermediate version has something to restore.
2. Run the applicable migrations in order. The registry holds only the current definition, so intermediate states are not validated against the versions they belong to; after the last step the resulting installation is validated once against the current definition's `install` fields (`checkInstallValues`) before anything is written.
3. Commit: the installation with `definitionVersion = definition.version` and a `migrationLog` entry `{ from, to, at, steps, warnings }` (kept to the last 10) and the changed app files are written to a staging folder inside the snapshot directory first, then a commit marker is written, then the files move into place and the marker is finalised. A crash between those writes is recovered at the next start before normal loading: a marker without the finished flag rolls the installation and apps back from the snapshot, so `definitionVersion` can never say "migrated" while an app binding still names an old action. Then `invalidate`, `syncIntegrationScopeProviders`, refresh caches.
4. On failure: restore the snapshot, keep `definitionVersion` as it was, mark the installation `status: migrationFailed` with the error, and keep it disabled for tool loading until an admin acts: **Re-run migration**, **Restore backup** (the pre-update definition and values), or **Uninstall** (remove the installation and its bindings). A normal save does not clear the state: the installation editor is read-only for a failed installation apart from those three actions, so unmigrated values can never be stamped with the new `definitionVersion`. The old values are never served against the new definition. Never half-migrated.

**Downgrade** (iHub downgraded, or "revert to previous version" in the marketplace): the definition is older than `definitionVersion`. Migrations are forward-only, so the runner restores the latest snapshot whose `representedVersion` equals the definition's version if one exists, otherwise marks the installation `status: needsReview` and leaves it disabled. The marketplace "Revert" button is therefore exactly "restore the backup the update made".

**Cluster.** Migrations run on the worker that applied the update (or the primary at startup); other workers pick up the written files through the existing config-change hooks, like `InstalledIntegrationService._afterChange`.

## 4 · What the admin sees

**Marketplace → Integrations.** An installed item with a newer catalog version shows **Update 1.2.0 → 1.4.0**. Clicking opens a dialog with the release notes of every version in between (newest first), the compatibility line, and, when a migration applies, "This update changes 2 install values and 1 action of the installation *GovData*; a backup is made first." Confirm runs update + migration and reports the migration log. Incompatible versions are shown but disabled with the reason.

**Integrations → Installed.** The row shows the installed version; a tooltip or detail shows the definition version and the last migration. `migrationFailed` and `needsReview` rows carry a red pill with **Re-run migration** and **Restore backup**.

**Integration detail (catalog).** A **Releases** tab lists the history with each release's summary and renders its note files on demand (one request per file, served by the registry like every other companion file); the **Compatibility** line sits next to the author and license. The update dialog shows the summaries of the versions in between and expands to the notes.

## 5 · The marketplace repository

- `integrations/<folder>/integration.json` keeps `releases`, so the catalog generator emits per item: `version`, `compatibility`, `releases` (version, date, summary and the note file paths, the last 20) and `integrity` (which covers the note files like every companion file). The note files stay in the folder and are served exploded, so the catalog page fetches one file when an admin opens a release. One folder, one current version: older versions are reachable through git tags `integrations/<id>@<version>`; the catalog carries `versions: [{ version, ref }]` so a registry can serve `?version=` for a pinned install (phase 2).
- `scripts/validate.js` fails when `version` changed without a new `releases[0]` entry of that version, when an install field or action was renamed or removed without a migration touching it (a structural diff against the previous tag), or when a `module` step exists without an `integrity` hash.
- Registry setting `channel: stable | all` and per-item `pin: "1.3.x"` are phase 2; phase 1 always offers the catalog's current version.

## 6 · Phasing

| Phase | Scope | Size |
| --- | --- | --- |
| **1 · Compatibility and notes** | `compatibility`, `releases`, schema; catalog generator copies both; marketplace greys incompatible items, shows the notes between installed and latest; `incompatible` registry status | ~1 week |
| **2 · Declarative migrations** | `migrations` with declarative steps, runner with snapshot/restore and `migrationLog`, triggers 1–3, `migrationFailed` / `needsReview`, admin re-run and restore; marketplace validator diff check | ~2 weeks |
| **3 · Module migrations and pinning** | `module` steps under `trustCode` + integrity, catalog `versions`, registry pin/channel, "Revert" | ~1 week |

Built-ins adopt the format in phase 1: iFinder, iAssistant, web search, the MCP and A2A definitions get `releases` with what V192–V195 did, and the first iHub release after phase 2 migrates installations through the runner instead of a numbered `server/migrations/V*.js` when only an installation's values change.

## 7 · Decisions

All decided 2026-10-31 (Daniel Manzke).

1. **Declarative-first.** Catalog integrations without `trustCode` get declarative steps only; migration modules need a registry trusted for code. **Decided: yes, for now.**
2. **Failure policy.** A failed migration leaves the installation disabled until an admin acts. **Decided: manual action.** The admin re-runs the migration, restores the backup, or uninstalls the integration (section 3). The old values are never served against the new definition.
3. **Where the notes live.** **Decided: in the JSON, with the notes in files.** `releases[]` carries version, date and a one-line summary; the notes themselves are Markdown companion files per category, named like iHub's own `docs/releases/<version>/` files (`features.md`, `fixes.md`, `breaking-changes.md`). Packages are published exploded, so every file can be inspected and fetched on its own and nothing is downloaded to show a changelog, as a skill's `SKILL.md` references its further files (section 1).
4. **Numbered config migrations stay** for everything that is not an installation (platform.json, apps, groups). Only the per-installation part moves into the definition. **Decided: yes.**
5. **Compatibility range vs minimum.** **Decided: semver range** (`compatibility.ihub`), which covers the minimum case and lets a definition exclude a future major.

## Open questions

All decided 2026-10-31 (Daniel Manzke).

- **App bindings are not versioned.** The migration rewrites bindings, which covers renames; a removed action leaves the app with fewer tools and a warning in Admin → Apps.
- **Installations migrate independently.** Several installations of one definition are separate units of work; one failing never blocks the others.
- **"Updates available" stays out of What's New.** The installed list shows an update badge per row and the admin dashboard a count; What's New remains the changelog of iHub releases.
