# Persistence Layer

iHub Apps stores its configuration (`contents/config/*.json`, apps, models,
prompts, tools, sources, ...) behind a small `StorageProvider` abstraction
rather than calling `fs` directly everywhere. This is the foundation for
running iHub against PostgreSQL instead of the local filesystem, which in
turn is a prerequisite for multi-instance horizontal scaling (distributed
config-cache invalidation, shared OAuth state, etc.).

## Current scope

This is a **foundation layer**, not a full feature yet:

- **Filesystem is still the default and only fully-wired backend.** Every
  existing deployment continues to read/write `contents/` exactly as before
  — nothing changes unless `DATABASE_URL` is set.
- **Reads** for cached JSON/text configuration (`configLoader.js` — apps,
  models, prompts, groups, platform config, etc.) already go through the
  active `StorageProvider`.
- **Writes** from the admin UI (`server/routes/admin/*.js`) still use
  `atomicWriteJSON` directly against the filesystem. Migrating every admin
  write path onto `StorageProvider` — and building the "Activate PostgreSQL"
  admin UI, data-migration tool, and Docker Compose service — is tracked as
  follow-up work.

## Architecture

```
server/persistence/
  StorageProvider.js     — interface: read, write, delete, list, exists
  FilesystemProvider.js  — wraps contents/ on disk (default, backward-compatible)
  PostgresProvider.js    — stores each path as a row in a generic config_kv table
  StorageRegistry.js     — factory: PostgresProvider when DATABASE_URL is set, else FilesystemProvider

server/db/
  pool.js     — lazy pg.Pool singleton; null when DATABASE_URL is unset
  schema.js   — DDL for config_kv (idempotent, applied on first use)
```

`StorageRegistry.getStorageProvider()` resolves the active provider once per
process and memoizes it. Every `StorageProvider` implementation exposes the
same five methods (`read`, `write`, `delete`, `exists`, `list`), all keyed by
a path relative to the provider's root (e.g. `config/platform.json`).

## Enabling PostgreSQL (early/manual)

Set the `DATABASE_URL` environment variable before starting the server:

```bash
export DATABASE_URL="postgres://user:password@localhost:5432/ihub"
```

When set, `configLoader.js` reads (apps, models, prompts, groups, UI config,
locales, etc.) are served from the `config_kv` table instead of `contents/`.
The table is created automatically on first use — no manual schema setup
required.

There is currently no tool to copy existing `contents/` data into
PostgreSQL, and admin writes still land on disk regardless of this setting —
so this is not yet a usable persistence mode for production. Treat it as an
opt-in preview of the storage seam, not a supported deployment option.

## Adding a new StorageProvider-backed read path

Call `getStorageProvider()` and use its methods instead of `fs` directly:

```js
import { getStorageProvider } from './persistence/StorageRegistry.js';

const provider = await getStorageProvider();
const raw = await provider.read('config/example.json'); // string | null
```

Avoid resolving filesystem paths yourself (`path.join(getRootDir(), ...)`) in
new code that reads from `contents/` — go through the provider so it keeps
working once a write path (or a different backend) is wired in later.
