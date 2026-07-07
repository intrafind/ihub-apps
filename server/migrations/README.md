# Configuration Migrations

A Flyway-inspired versioned migration system for JSON configuration files.
Migrations run automatically on server startup (before `configCache.initialize()`)
and are tracked in `contents/.migration-history.json`.

---

## Naming convention

```
V<NNN>__<short_description>.js
```

- Version numbers are **zero-padded to three digits**: `V003`, `V042`, `V123`.
- The description uses **underscores**, not hyphens.
- The top-of-file JSDoc comment **must** match the exported `version` and the
  file name — copy the correct number when creating a new file.

---

## The self-contained rule ⚠️

**Every migration must be self-contained.**

A migration file is checksummed when it first runs and the checksum is stored in
`.migration-history.json`. This guards the immutability contract: a migration
should produce the **same on-disk result** no matter when it runs — at release
time, six months later, or on a fresh install.

That contract breaks whenever a migration imports **live application code**, because
any future refactor of that module silently changes what the migration does on the
next fresh install, while already-migrated installations retain the old result.

### Rules

1. **Do not import from `server/` application modules** (adapters, services,
   serialisers, configCache, etc.) inside a migration. Those modules evolve; a
   migration must not.

2. **Inline or snapshot** any transformation logic the migration needs.
   Copy the relevant helper functions directly into the migration file and
   annotate them with a comment like:
   ```js
   // Snapshot of buildDefaultWorkflowForProfile() as of V052 (2025-xx-xx).
   // Do NOT replace with an import — migrations must be self-contained.
   ```

3. **Simplify unavailable dependencies.** Migrations run before `configCache` is
   initialised, so functions that normally call `configCache.getModels()` must be
   replaced by a stub that returns a safe default (e.g. `null` for a model ID).

4. **Never modify a migration after it has been applied.** The checksum mismatch
   will trigger a warning (or halt, depending on `migrations.checksumValidation`
   in `platform.json`). If a fix is needed, create a new higher-numbered migration.

5. **Forward-only.** There is no rollback mechanism. To undo a change, write a
   new migration.

### Acceptable imports inside a migration

| Allowed | Why |
|---------|-----|
| Node.js built-ins (`fs`, `path`, `crypto`, …) | Stable, versioned with Node |
| `../migrations/utils.js` | Stable migration-utility helpers only |
| `ctx.*` methods from the migration context | Injected by the runner |

---

## Migration context API (`ctx`)

| Method | Description |
|--------|-------------|
| `ctx.readJson(path)` | Read JSON from `contents/{path}` |
| `ctx.writeJson(path, data)` | Atomically write JSON to `contents/{path}` |
| `ctx.fileExists(path)` | Check if `contents/{path}` exists |
| `ctx.deleteFile(path)` | Delete `contents/{path}` |
| `ctx.moveFile(from, to)` | Move file within `contents/` |
| `ctx.listFiles(dir, pattern)` | List files in `contents/{dir}` |
| `ctx.readDefaultJson(path)` | Read JSON from `server/defaults/{path}` |
| `ctx.setDefault(obj, dotPath, value)` | Set value only if path is missing |
| `ctx.removeKey(obj, dotPath)` | Remove key at dot-path |
| `ctx.renameKey(obj, oldPath, newPath)` | Move key from old to new dot-path |
| `ctx.mergeDefaults(existing, defaults)` | Deep merge; existing values win |
| `ctx.addIfMissing(array, item, idField)` | Push item if no match on `idField` |
| `ctx.removeById(array, id, idField)` | Remove first item matching `id` |
| `ctx.transformWhere(array, pred, fn)` | Apply `fn` to items matching `pred` |
| `ctx.log(msg)` | Structured info log (prefixed with version) |
| `ctx.warn(msg)` | Structured warn log (prefixed with version) |

---

## Minimal migration template

```js
/**
 * Migration V<NNN> — <Short human-readable description>
 *
 * <Explain WHY this migration is needed and WHAT it changes.>
 */

export const version = '<NNN>';
export const description = '<short_description>';

// Optional: return false to skip when the target file doesn't exist.
export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'features.myNewFlag', false);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added features.myNewFlag default');
}
```
