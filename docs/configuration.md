# Configuration Storage

An installation's configuration is the tree under `contents/` — `platform.json`
and its siblings in `config/`, one JSON file per app, model, prompt, tool,
workflow and agent profile, the locale overrides, and the page bodies the
admin UI edits. This page is about **how the server reaches those files**, not
about what goes in them; for that, see [Platform
Configuration](platform.md), [App Configuration](apps.md), [Models](models.md)
and the rest of this section.

There is exactly one place in the server that touches a configuration file:
`server/services/config/ConfigStore.js`. Everything else —
`configLoader`, `resourceLoader`, `configCache`, every admin route that saves a
setting, the marketplace installer, the workflow editor — goes through it, and
it delegates to the [storage provider](storage.md).

**The files themselves did not move and did not change.** Configuration is
served by the provider's *raw namespaces*: the JSON file at
`contents/<dir>/<key>.json` **is** the document, written with the serializer
the server has always used. An installation's `contents/` is byte-identical
before and after the upgrade, so hand-editing, git, docker mounts, seeding from
`server/defaults/` and the configuration migrations all keep working exactly as
they did. See [Raw
namespaces](storage.md#raw-namespaces-configuration-stays-where-it-is) for the
mechanism and its rules.

## The seam

```js
import configStore from '../services/config/ConfigStore.js';
```

| Call                              | Does                                                                        |
| --------------------------------- | --------------------------------------------------------------------------- |
| `readJson(relPath)`               | Parsed body, or `null` — never throws                                        |
| `readText(relPath)`               | File contents as a string, or `null`                                         |
| `writeJson(relPath, data)`        | Atomic write, byte-identical to what `atomicWriteJSON` produced before        |
| `createJson(relPath, data)`       | Same, but fails with `EEXIST` when the file is already there                  |
| `writeText(relPath, text)`        | Atomic write of a page body, renderer or markdown source                      |
| `remove(relPath)`                 | `true` when a file was deleted, `false` when there was nothing to delete      |
| `list(ns)`                        | The keys a namespace holds — file names without `.json`, ascending            |
| `listDocuments(ns)`               | The same, with each document's parsed body and path                           |
| `resolveIdToPath(ns, id)`         | Where a resource with this `id` actually lives                                |

Paths are relative to `contents/` and are what they always were —
`config/platform.json`, `apps/chat.json`, `locales/de.json`,
`pages/en/faq.md`. Nothing had to learn a new addressing scheme; the store
turns a path into the `(namespace, key)` pair the provider understands, using
the single map in `server/storage/namespaces.js`.

`resolveIdToPath` deserves its own note. A configuration file's name is allowed
to diverge from the `id` inside it — `contents/apps/legacy-chat.json` may hold
`{"id": "chat"}` — and writing that app back to `<id>.json` without looking
would fork it into two files that both claim the same id. The store does what
the admin routes always did by hand: the expected name wins when it exists,
otherwise the namespace is searched for the document carrying the id, and only
a resource that exists nowhere falls back to `<id>.json`, which is the right
answer when creating one.

### What is a namespace and what is not

The eight raw namespaces are listed in [Raw
namespaces](storage.md#raw-namespaces-configuration-stays-where-it-is): a
directory of JSON documents, one level deep. Text and nested content is not a
namespace and is not stored as documents:

- **Page bodies** stay in `contents/pages/<lang>/<id>.md` (or `.jsx`), one file
  per language, with the registry entry — title, per-language file paths,
  `authRequired`, `allowedGroups`, `contentType` — in `config/ui.json` as
  before. A page save writes the bodies through `writeText` and the registry
  through `writeJson`; no page content moved.
- **Markdown sources, custom renderers and skill trees** are text, or whole
  directories installed and removed as a unit.

All of it still goes through `ConfigStore`, so there is one seam rather than
two — but for these the store uses a contained filesystem path rather than the
provider.

## Reading

`loadJson` and `loadText` in `server/configLoader.js` keep their signatures and
are now thin wrappers over the store, so their call sites did not change.
`resourceLoader` — which loads apps, models, prompts, tools, workflows and
agents — reads through `list` and `listDocuments` instead of building
`contents/` paths of its own. That incidentally fixed a long-standing bug:
`resourceLoader` hardcoded `contents/` and ignored the `CONTENTS_DIR` setting,
so an installation with a relocated contents directory silently loaded no apps
at all.

**A read never throws and never invents a value.** Missing, unreadable and
malformed all resolve to `null`. `configCache` branches on `data !== null` in
eleven places, and a store that threw — or that returned `{}` — would change
boot behaviour that has held for years. A missing locale override is silent,
because an installation without translation overrides is the normal case, not a
fault.

### `configCache` is the cache — and now the only one

`configCache` holds the parsed configuration the request path reads, and that
is unchanged. What is gone is the *second* cache underneath it: `configLoader`
kept its own 60-second TTL map, which `configCache.refreshCacheEntry()` knew
nothing about.

The effect was a stale window nobody intended. An admin saved a setting, the
route wrote the file and refreshed the cache entry, the refresh re-read the
file through `configLoader` — and got the copy `configLoader` had cached up to
a minute earlier. The new value was written correctly and served incorrectly,
for up to sixty seconds, with nothing in the logs to say why.

That cache is removed. A save is visible on the next read. The provider read it
replaced is cheap, and `configCache` was always the cache that mattered.

## Writing

Every write is still `read → mutate → write → refreshCacheEntry`, and only the
write changed:

```js
const platform = await configStore.readJson('config/platform.json');
platform.features.myFlag = true;
await configStore.writeJson('config/platform.json', platform);
await configCache.refreshCacheEntry('config/platform.json');
```

Two things that did **not** move:

- **Secret handling.** Redaction on read (`***REDACTED***`), restoring a
  redacted value the admin did not edit, and encrypting a new secret at rest
  all happen above the write, on plain objects, exactly where they were. See
  [Encryption Key Management](encryption-key-management.md).
- **Serialization.** A write emits `JSON.stringify(data, null, 2)` with no
  trailing newline — what `utils/atomicWrite.js` has always emitted. Anything
  else and the first admin save after an upgrade would rewrite files nobody
  edited.

## Invalidation

Two mechanisms run, and they cover different distances:

- **The cluster announcement.** `refreshCacheEntry()` reloads the entry and
  announces it over the cluster IPC bus (`server/configSync.js`), which is what
  reaches this machine's *other workers*. With the default four workers, this
  is the only reason a save on one worker is visible on the next request that
  lands on another.
- **The provider's change stream.** `configCache` also subscribes to the
  provider's [change notifier](storage.md#change-notification) and reloads the
  entries a `document.put` or `document.delete` invalidates, coalesced over a
  25 ms window and only for entries the cache actually holds.

The second does not replace the first. The filesystem provider's notifier is a
bare in-process `EventEmitter` (`notifications: 'in-process'`), so dropping the
announcement in favour of it would silently undo cross-worker invalidation.
Today the notifier is a same-instance no-op — the writer has already refreshed
its own cache by the time the event arrives.

## Boot order

The provider is configured from `platform.json`, so the read of `platform.json`
cannot go through the provider. `server/server.js` does it through
`ConfigStore` like everything else, and the store answers from the contained
filesystem path because no provider exists yet; `bootstrapStorage()` runs on
the result. `server/migrations/runner.js` makes the same exception for the same
reason, earlier still.

This is also why **configuration never depends on optional runtime storage.**
When a provider fails to come up — a supported state, not an error — the store
reads and writes the same contained paths, and the server boots normally. A
malformed `storage` block cannot stop the server from reading the file that
block lives in.

## Reaching around the seam

`npm run lint:config-access` (`scripts/check-config-fs-access.js`, part of
`npm run test:quick`) fails the build on any direct `fs` or `atomicWrite*` call
against a configuration path outside the store. Five subsystems cannot honour
that rule — the migration runner, `TokenStorageService`'s key material,
`backup.js`, the builtin locales in `shared/i18n/`, and the cold-cache
fallback of the synchronous `loadGroupsConfiguration()` in the admin
middleware path. They are an explicit
allowlist in the guard, each with the reason it is there, printed on every run.
[Storage Providers](storage.md#what-is-deliberately-not-behind-the-seam)
carries the list and the reasoning.

## What this is for

Nothing about an installation's behaviour depends on this seam existing —
that is the point of a change whose acceptance test is "the files are
identical". What it buys is what comes next.

A future provider can serve configuration from a database by implementing the
document facet for these namespaces. It would have to answer the same contract
the raw store answers today: an etag that a compare-and-set can trust, listing
in ascending key order, and `null` rather than a throw for anything it cannot
read.

The nearer prize is **cross-instance invalidation**. Multi-instance deployments
have no shared cache today; each instance's `configCache` learns about a save
only from its own workers. A push-capable provider — PostgreSQL's
`LISTEN`/`NOTIFY` is the worked example — publishes a `document.put` that every
instance receives, and `configCache` is already subscribed to exactly that
event. The wiring is in place and does nothing useful yet, which is the honest
description of it until that provider ships.

## See also

- [Storage Providers](storage.md) — the provider interface and raw namespaces
- [Platform Configuration](platform.md) — what the configuration files contain
- [Configuration Migrations](configuration-migrations.md) — how config changes
  are rolled out to existing installations
- [Configuration Validation](configuration-validation.md) — the schemas the
  files are checked against
