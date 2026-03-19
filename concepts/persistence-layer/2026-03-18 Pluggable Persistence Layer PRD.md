# Pluggable Persistence Layer — Product Requirements Document

**Date:** 2026-03-18
**Status:** Draft
**Author:** Daniel Manzke / Architecture Team

---

## 1. Executive Summary

iHub Apps currently stores all configuration and state as JSON files on the local filesystem, cached in-memory by `configCache.js`. This design works well for single-instance deployments but becomes a bottleneck when scaling horizontally — there is no distributed cache invalidation, no coordination of writes across instances, and no way to swap in a database or object store without rewriting large portions of the server.

This PRD defines a **pluggable persistence abstraction** that decouples iHub's read/write operations from the filesystem. The abstraction introduces a uniform `StorageProvider` interface, a change-event system for cross-instance cache invalidation, and concrete provider implementations for five backends: **Filesystem** (default), **SQLite**, **PostgreSQL**, **OpenSearch**, and **S3**.

### Phasing

| Phase | Scope | Goal |
|-------|-------|------|
| **Phase 1** (this PRD) | Configuration data — apps, models, groups, users, workflows, sources, pages, prompts, tools, UI, platform, providers, features, styles, registries, installations, mimetypes, oauth-clients | Replace direct `fs.*` calls with provider-backed operations; enable horizontal scaling for config |
| **Phase 2** (future) | Runtime data — chat history, workflow instances, jobs, usage/telemetry, audit logs | Extend the same abstraction to operational data with higher write throughput requirements |

---

## 2. Problem Statement

### 2.1 Current Architecture

All persistent state lives under the `contents/` directory:

```
contents/
├── config/           # Single-file configs (platform.json, groups.json, ui.json, …)
├── apps/             # Collection: one JSON per app
├── models/           # Collection: one JSON per model
├── prompts/          # Collection: one JSON per prompt
├── workflows/        # Collection: one JSON per workflow
├── sources/          # Collection or single file
├── skills/           # Installed skills (directories with SKILL.md)
├── pages/{lang}/     # Dynamic pages (.md, .jsx)
├── data/             # Usage stats, monthly archives
├── uploads/          # Temporary file uploads
├── .encryption-key   # AES-256-GCM key
├── .jwt-private-key.pem / .jwt-public-key.pem
└── .migration-history.json
```

**Key components that touch the filesystem:**

| Component | Role | I/O Pattern |
|-----------|------|-------------|
| `configCache.js` | Central in-memory store | Read on init + TTL-based refresh |
| `configLoader.js` | Low-level file reader | Read with 60 s local TTL |
| `resourceLoader.js` factory | Loads directory-of-files collections | `readdir` + individual `readFile` |
| `atomicWrite.js` | Safe JSON writes | Write-to-temp + atomic rename |
| Admin routes (`routes/admin/`) | CRUD for all config types | Read + atomic write + cache refresh |
| `TokenStorageService` | Secret encryption/decryption | Read/write encryption key file |
| Migration runner | Schema migrations | Read/write history + config files |
| Usage tracker | Telemetry | 10 s batched writes to `data/usage.json` |

### 2.2 Pain Points for Horizontal Scaling

1. **No distributed cache invalidation.** When instance A writes a config change, instances B…N continue serving stale data until their 5-minute TTL expires.
2. **File-based migration lock.** The `.migration-lock` file only works on a shared filesystem; it is inadequate for distributed deployments without NFS.
3. **Synchronous local-auth writes.** `fs.writeFileSync()` for user management blocks the event loop and has no cross-instance coordination.
4. **Single-writer assumption.** Atomic rename prevents corruption on one machine but does not prevent two instances from writing concurrently.
5. **No backend flexibility.** Organizations that already run PostgreSQL or OpenSearch cannot leverage existing infrastructure for iHub state.
6. **Usage tracking data loss.** In-memory batching with a 10-second flush interval means data is lost on crash.

### 2.3 Goals

- **G1:** Introduce a `StorageProvider` interface that all config I/O flows through.
- **G2:** Ship five provider implementations: Filesystem, SQLite, PostgreSQL, OpenSearch, S3.
- **G3:** Implement a change-event system supporting both polling and push-based propagation.
- **G4:** Document the extension points so third-party or future providers can be added without modifying core code.
- **G5:** Provide a zero-downtime migration path from the current filesystem layout.
- **G6:** Maintain full backward compatibility for single-instance filesystem deployments.
- **G7:** Provide an Admin UI for selecting, configuring, and monitoring the storage backend.

### 2.4 Non-Goals (Phase 1)

- Chat history, workflow instance state, or job queues (Phase 2).
- Binary/blob storage for file uploads (Phase 2).
- Full-text search across config values (provider-specific, optional).

---

## 3. Abstraction Layer Design

### 3.1 Core Concepts

The persistence layer introduces four abstractions:

| Concept | Description |
|---------|-------------|
| **StorageProvider** | Primary interface — CRUD operations for config documents |
| **ChangeNotifier** | Emits and subscribes to change events across instances |
| **LockManager** | Distributed locking for migrations and exclusive writes |
| **StorageRegistry** | Factory that resolves the configured provider at startup |

### 3.2 Data Model

All configuration is modeled as **documents** within **namespaces**:

```
Namespace          Document Key           Example
─────────────────  ─────────────────────  ─────────────────────────────
config             platform               contents/config/platform.json
config             groups                 contents/config/groups.json
config             ui                     contents/config/ui.json
config             users                  contents/config/users.json
config             tools                  contents/config/tools.json
config             sources                contents/config/sources.json
config             providers              contents/config/providers.json
config             features               contents/config/features.json
config             styles                 contents/config/styles.json
config             installations          contents/config/installations.json
config             registries             contents/config/registries.json
config             mimetypes              contents/config/mimetypes.json
config             oauth-clients          contents/config/oauth-clients.json
apps               chat                   contents/apps/chat.json
apps               translator             contents/apps/translator.json
models             claude-4-sonnet        contents/models/claude-4-sonnet.json
prompts            analysis               contents/prompts/analysis.json
workflows          my-workflow            contents/workflows/my-workflow.json
pages              faq                    contents/pages/{lang}/faq.{ext} → single document with all translations
secrets            encryption-key         contents/.encryption-key
secrets            jwt-private-key        contents/.jwt-private-key.pem
secrets            jwt-public-key         contents/.jwt-public-key.pem
system             migration-history      contents/.migration-history.json
data               usage                  contents/data/usage.json
data               usage-monthly/2026-03  contents/data/usage-monthly/2026-03.json
```

**Namespace** groups related documents and maps cleanly to filesystem directories, database tables/indices, or S3 prefixes. Providers may store all namespaces in a single backing store or partition them — the abstraction does not dictate physical layout.

**Document key** is a string identifier unique within its namespace. For collection-type configs (apps, models, prompts, workflows), each item is its own document. For single-file configs, the filename stem is the key.

**Pages** are a special case. On the filesystem, pages are stored as individual files per language (`contents/pages/en/faq.md`, `contents/pages/de/faq.md`). In the persistence layer, a page is modeled as a **single document** in the `pages` namespace with the page ID as the key (e.g., `faq`). The document contains all translations as a structured object:

```json
{
  "id": "faq",
  "contentType": "text/markdown",
  "translations": {
    "en": { "content": "# FAQ\n...", "contentType": "text/markdown" },
    "de": { "content": "# Häufige Fragen\n...", "contentType": "text/markdown" }
  }
}
```

This consolidation ensures that translations are always consistent, simplifies cross-language operations (e.g., listing all pages regardless of language), and avoids namespace proliferation. The filesystem provider handles the mapping between this unified model and the per-language directory structure transparently.

### 3.3 StorageProvider Interface

```typescript
interface StorageProvider {
  // ── Lifecycle ──────────────────────────────────────────────
  /**
   * Initialize the provider (connect to DB, verify bucket, etc.).
   * Called once at server startup before configCache.initialize().
   */
  initialize(config: ProviderConfig): Promise<void>;

  /**
   * Graceful shutdown — close connections, flush buffers.
   */
  shutdown(): Promise<void>;

  /**
   * Health check for monitoring endpoints.
   */
  healthCheck(): Promise<HealthStatus>;

  // ── Single-Document Operations ─────────────────────────────
  /**
   * Retrieve a single document.
   * Returns null if the document does not exist.
   */
  get(namespace: string, key: string): Promise<Document | null>;

  /**
   * Write a single document (create or overwrite).
   * Emits a change event on success.
   * Returns the written document with updated metadata.
   */
  put(namespace: string, key: string, data: any, meta?: WriteMeta): Promise<Document>;

  /**
   * Delete a single document.
   * Emits a change event on success.
   * Returns true if the document existed and was deleted.
   */
  delete(namespace: string, key: string): Promise<boolean>;

  /**
   * Check whether a document exists without reading its full content.
   */
  exists(namespace: string, key: string): Promise<boolean>;

  // ── Collection Operations ──────────────────────────────────
  /**
   * List all document keys in a namespace.
   * Supports optional prefix filtering (e.g., list("apps", { prefix: "chat" })).
   */
  list(namespace: string, options?: ListOptions): Promise<string[]>;

  /**
   * Retrieve all documents in a namespace.
   * Used by resourceLoader-style bulk loads.
   */
  getAll(namespace: string, options?: ListOptions): Promise<Document[]>;

  /**
   * Atomically write multiple documents.
   * Either all succeed or none are persisted (where the backend supports it).
   * Backends without true transactions should document their guarantees.
   */
  putBatch(operations: BatchPutOp[]): Promise<Document[]>;

  /**
   * Delete multiple documents atomically.
   */
  deleteBatch(operations: BatchDeleteOp[]): Promise<boolean[]>;

  // ── Metadata & Versioning ──────────────────────────────────
  /**
   * Retrieve only the ETag/version of a document (cheap staleness check).
   */
  getEtag(namespace: string, key: string): Promise<string | null>;

  // ── Change Notification ────────────────────────────────────
  /**
   * Returns the ChangeNotifier instance for this provider.
   * Some providers have native change feeds; others use an external notifier.
   */
  getChangeNotifier(): ChangeNotifier;

  // ── Distributed Locking ────────────────────────────────────
  /**
   * Returns the LockManager instance for this provider.
   */
  getLockManager(): LockManager;

  // ── Provider Capabilities ──────────────────────────────────
  /**
   * Declares what this provider supports.
   * Used by the core to adapt behavior (e.g., skip batch if unsupported).
   */
  getCapabilities(): ProviderCapabilities;
}
```

### 3.4 Supporting Types

```typescript
interface Document {
  namespace: string;
  key: string;
  data: any;                    // Parsed JSON (or raw string for .md/.jsx/.pem)
  contentType: string;          // 'application/json' | 'text/markdown' | 'text/jsx' | 'application/pem'
  etag: string;                 // Content hash for change detection
  updatedAt: Date;
  updatedBy?: string;           // User who made the change (for audit)
  version?: number;             // Monotonic version for optimistic concurrency
}

interface WriteMeta {
  updatedBy?: string;           // Audit trail
  ifMatch?: string;             // Optimistic concurrency: only write if current ETag matches
  contentType?: string;         // Override auto-detected content type
}

interface ListOptions {
  prefix?: string;              // Filter keys starting with prefix
  limit?: number;               // Max results
  offset?: number;              // Pagination offset
}

interface BatchPutOp {
  namespace: string;
  key: string;
  data: any;
  meta?: WriteMeta;
}

interface BatchDeleteOp {
  namespace: string;
  key: string;
}

interface HealthStatus {
  healthy: boolean;
  provider: string;
  latencyMs: number;
  details?: Record<string, any>;
}

interface ProviderCapabilities {
  transactions: boolean;         // Supports atomic multi-document writes
  changeNotifications: 'push' | 'poll' | 'both' | 'none';
  distributedLocking: boolean;
  versionedDocuments: boolean;   // Native versioning/optimistic concurrency
  binarySupport: boolean;        // Can store non-JSON blobs (Phase 2)
  search: boolean;               // Supports full-text or filtered queries
  maxDocumentSize: number;       // In bytes; 0 = unlimited
}
```

### 3.5 ChangeNotifier Interface

```typescript
interface ChangeNotifier {
  /**
   * Start listening for change events.
   * Called once after provider.initialize().
   */
  start(): Promise<void>;

  /**
   * Stop listening and clean up resources.
   */
  stop(): Promise<void>;

  /**
   * Publish a change event (called internally by put/delete).
   */
  publish(event: ChangeEvent): Promise<void>;

  /**
   * Subscribe to change events.
   * Returns an unsubscribe function.
   */
  subscribe(handler: ChangeHandler): () => void;

  /**
   * Poll for changes since a given timestamp or cursor.
   * Used by providers that don't support push.
   */
  poll?(since: string | Date): Promise<ChangeEvent[]>;
}

interface ChangeEvent {
  id: string;                   // Unique event ID (UUID or provider-native)
  namespace: string;
  key: string;
  action: 'put' | 'delete';
  etag?: string;                // New ETag after change
  timestamp: Date;
  sourceInstanceId: string;     // Identifies which instance made the change
}

type ChangeHandler = (event: ChangeEvent) => void | Promise<void>;
```

### 3.6 LockManager Interface

```typescript
interface LockManager {
  /**
   * Acquire a named lock with a TTL.
   * Returns a lock handle, or throws if the lock cannot be acquired
   * within the specified timeout.
   */
  acquire(name: string, options?: LockOptions): Promise<LockHandle>;

  /**
   * Release a previously acquired lock.
   */
  release(handle: LockHandle): Promise<void>;

  /**
   * Execute a function while holding a lock.
   * Lock is automatically released after the function completes (or throws).
   */
  withLock<T>(name: string, fn: () => Promise<T>, options?: LockOptions): Promise<T>;
}

interface LockOptions {
  ttlMs: number;               // Lock auto-expires after this duration (default: 60000)
  waitMs: number;              // Max time to wait for lock acquisition (default: 10000)
  retryIntervalMs: number;     // Polling interval while waiting (default: 500)
}

interface LockHandle {
  name: string;
  token: string;               // Unique token for safe release
  expiresAt: Date;
}
```

### 3.7 StorageRegistry

The registry is the entry point that wires everything together at startup:

```typescript
class StorageRegistry {
  /**
   * Create the configured provider based on platform config or environment.
   *
   * Bootstrap sequence:
   *   1. Start with filesystem provider (always available, zero config)
   *   2. Read platform.json → storage.provider from filesystem
   *   3. Check IHUB_STORAGE_PROVIDER env var (overrides platform.json)
   *   4. If resolved provider ≠ filesystem, initialize the target provider
   *
   * This avoids a chicken-and-egg problem: the system always boots with
   * filesystem, reads its config, and switches if a different provider
   * is configured. The provider can be changed later via Admin UI or env var
   * (requires restart to take effect).
   *
   * Provider-specific config is read from:
   *   1. IHUB_STORAGE_{PROVIDER}__* env vars (highest precedence)
   *   2. platform.json → storage.{provider}
   */
  static async create(): Promise<StorageProvider>;

  /**
   * Register a custom provider class.
   * Called by plugins or extensions before create().
   */
  static register(name: string, factory: ProviderFactory): void;

  /**
   * List all registered provider names.
   */
  static listProviders(): string[];
}

type ProviderFactory = (config: ProviderConfig) => StorageProvider;
```

### 3.8 Configuration Schema

Provider selection and configuration in `platform.json`:

```json
{
  "storage": {
    "provider": "filesystem",
    "instanceId": "auto",

    "changeLog": {
      "retentionDays": 30,
      "retentionPolicy": "prune"
    },

    "filesystem": {
      "basePath": "./contents",
      "watchForChanges": true,
      "watchDebounceMs": 500
    },

    "sqlite": {
      "path": "./contents/ihub.db",
      "walMode": true,
      "busyTimeoutMs": 5000
    },

    "postgresql": {
      "connectionString": "${IHUB_PG_URL}",
      "schema": "ihub",
      "pool": {
        "min": 2,
        "max": 10,
        "idleTimeoutMs": 30000
      },
      "notifications": {
        "channel": "ihub_config_changes"
      }
    },

    "opensearch": {
      "node": "${IHUB_OPENSEARCH_URL}",
      "indexPrefix": "ihub-config",
      "auth": {
        "username": "${IHUB_OPENSEARCH_USER}",
        "password": "${IHUB_OPENSEARCH_PASS}"
      },
      "refreshInterval": "1s"
    },

    "s3": {
      "bucket": "${IHUB_S3_BUCKET}",
      "prefix": "ihub/config/",
      "region": "${AWS_REGION}",
      "endpoint": "${IHUB_S3_ENDPOINT}",
      "notifications": {
        "type": "eventbridge",
        "eventBusName": "default",
        "sqsQueueUrl": "${IHUB_SQS_QUEUE_URL}",
        "snsTopicArn": "${IHUB_SNS_TOPIC_ARN}"
      }
    }
  }
}
```

All provider-specific settings are also configurable via environment variables using the `IHUB_STORAGE_{PROVIDER}__*` convention (e.g., `IHUB_STORAGE_POSTGRESQL__SCHEMA=ihub`).

---

## 4. Provider Specifications

### 4.1 Filesystem Provider (Default)

**Purpose:** Drop-in replacement for current behavior. Zero additional dependencies. Ideal for single-instance and development.

#### Storage Mapping

| Namespace | Path | Format |
|-----------|------|--------|
| `config` | `{basePath}/config/{key}.json` | JSON |
| `apps` | `{basePath}/apps/{key}.json` | JSON |
| `models` | `{basePath}/models/{key}.json` | JSON |
| `prompts` | `{basePath}/prompts/{key}.json` | JSON |
| `workflows` | `{basePath}/workflows/{key}.json` | JSON |
| `pages` | `{basePath}/pages/{lang}/{key}.{ext}` (assembled from per-language files) | md/jsx |
| `secrets` | `{basePath}/.{key}` | raw |
| `system` | `{basePath}/.{key}.json` | JSON |
| `data` | `{basePath}/data/{key}.json` | JSON |

#### Write Strategy

- Reuse existing `atomicWrite.js` — write to temp file, then `fs.rename()`.
- Optimistic concurrency via ETag comparison (read ETag → compare → write).

#### Change Notification

- **Push (primary):** `fs.watch()` / `chokidar` on the `basePath`. Debounced to collapse rapid successive writes.
- **Poll (fallback):** Stat-based polling on a configurable interval (default 5 s). Required for NFS and other network filesystems where `fs.watch` is unreliable.

#### Distributed Locking

- **Single instance:** File-based lock with PID and timestamp (current `.migration-lock` approach, improved with heartbeat).
- **Multi-instance on shared FS:** Advisory file locks via `fs.flock()` (where supported). Documented as best-effort; recommend upgrading to PostgreSQL or similar for true HA.

#### Capabilities

```json
{
  "transactions": false,
  "changeNotifications": "both",
  "distributedLocking": false,
  "versionedDocuments": false,
  "binarySupport": true,
  "search": false,
  "maxDocumentSize": 0
}
```

#### Legacy Compatibility

The filesystem provider also supports loading from the legacy single-file format (`config/apps.json` containing an array) alongside the directory format. This mirrors the current `resourceLoader` behavior and ensures zero breaking changes on upgrade.

---

### 4.2 SQLite Provider

**Purpose:** Local development and small-team deployments that want database-level consistency without running an external database server.

#### Dependencies

- `better-sqlite3` (synchronous, high-performance SQLite binding for Node.js)

#### Schema

```sql
CREATE TABLE IF NOT EXISTS documents (
    namespace   TEXT    NOT NULL,
    key         TEXT    NOT NULL,
    data        TEXT    NOT NULL,           -- JSON string or raw content
    content_type TEXT   NOT NULL DEFAULT 'application/json',
    etag        TEXT    NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_by  TEXT,
    PRIMARY KEY (namespace, key)
);

CREATE INDEX idx_documents_namespace ON documents(namespace);
CREATE INDEX idx_documents_updated ON documents(updated_at);

-- Change log for poll-based notifications
CREATE TABLE IF NOT EXISTS change_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace   TEXT    NOT NULL,
    key         TEXT    NOT NULL,
    action      TEXT    NOT NULL CHECK (action IN ('put', 'delete')),
    etag        TEXT,
    timestamp   TEXT    NOT NULL DEFAULT (datetime('now')),
    instance_id TEXT    NOT NULL
);

CREATE INDEX idx_change_log_timestamp ON change_log(timestamp);

-- Distributed locks (advisory)
CREATE TABLE IF NOT EXISTS locks (
    name        TEXT    PRIMARY KEY,
    token       TEXT    NOT NULL,
    instance_id TEXT    NOT NULL,
    acquired_at TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT    NOT NULL
);
```

#### Write Strategy

- Transactions for batch operations (`putBatch`, `deleteBatch`).
- Optimistic concurrency via `version` column: `UPDATE ... WHERE version = :expected`.
- WAL mode enabled by default for concurrent read/write.

#### Change Notification

- **Poll:** Query `change_log` table for entries newer than last-seen timestamp.
- **Push:** Not natively supported. For single-process use, an in-process `EventEmitter` is sufficient.

#### Distributed Locking

- Advisory locks via the `locks` table with TTL-based expiration.
- Adequate for single-machine, multi-worker scenarios. Not suitable for multi-machine deployments.

#### Capabilities

```json
{
  "transactions": true,
  "changeNotifications": "poll",
  "distributedLocking": true,
  "versionedDocuments": true,
  "binarySupport": true,
  "search": false,
  "maxDocumentSize": 0
}
```

#### Initialization

On first run, the provider creates the database file and applies the schema. If an existing `contents/` directory is detected and the database is empty, the provider offers an import command (see §6 Migration).

---

### 4.3 PostgreSQL Provider

**Purpose:** Production multi-instance deployments. Full ACID transactions, native pub/sub for real-time change notification, and robust distributed locking.

#### Dependencies

- `pg` (node-postgres) with connection pooling

#### Schema

```sql
CREATE SCHEMA IF NOT EXISTS ihub;

CREATE TABLE ihub.documents (
    namespace       TEXT        NOT NULL,
    key             TEXT        NOT NULL,
    data            JSONB       NOT NULL,       -- JSONB for JSON documents
    data_raw        TEXT,                       -- Raw text for non-JSON (md, jsx, pem)
    content_type    TEXT        NOT NULL DEFAULT 'application/json',
    etag            TEXT        NOT NULL,
    version         INTEGER     NOT NULL DEFAULT 1,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT,
    PRIMARY KEY (namespace, key)
);

CREATE INDEX idx_documents_namespace ON ihub.documents(namespace);
CREATE INDEX idx_documents_updated ON ihub.documents(updated_at);
CREATE INDEX idx_documents_data_gin ON ihub.documents USING GIN (data);

-- Change log for durable event history and catch-up
CREATE TABLE ihub.change_log (
    id              BIGSERIAL   PRIMARY KEY,
    namespace       TEXT        NOT NULL,
    key             TEXT        NOT NULL,
    action          TEXT        NOT NULL CHECK (action IN ('put', 'delete')),
    etag            TEXT,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
    instance_id     TEXT        NOT NULL
);

CREATE INDEX idx_change_log_ts ON ihub.change_log(timestamp);

-- Partition change_log by month for efficient cleanup
-- (Implementation detail: handled by provider on init)

-- Advisory locks use PostgreSQL's built-in pg_advisory_lock
-- No separate table needed.

-- Trigger: auto-notify on document changes
CREATE OR REPLACE FUNCTION ihub.notify_config_change()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify(
        'ihub_config_changes',
        json_build_object(
            'namespace', COALESCE(NEW.namespace, OLD.namespace),
            'key', COALESCE(NEW.key, OLD.key),
            'action', TG_OP,
            'etag', NEW.etag,
            'instance_id', current_setting('ihub.instance_id', true)
        )::text
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_config_change
    AFTER INSERT OR UPDATE OR DELETE ON ihub.documents
    FOR EACH ROW
    EXECUTE FUNCTION ihub.notify_config_change();
```

#### Write Strategy

- Full ACID transactions for all write operations.
- `putBatch` wraps all operations in a single transaction.
- Optimistic concurrency: `UPDATE ... WHERE version = :expected RETURNING *`.
- JSONB storage enables future indexed queries on config content (e.g., find all enabled apps).

#### Change Notification

- **Push (primary):** PostgreSQL `LISTEN/NOTIFY` on the `ihub_config_changes` channel. The trigger fires on every document change, delivering a JSON payload to all connected instances in real-time.
- **Poll (fallback):** Query `change_log` table. Useful for catch-up after instance restart or network partition.
- **Reconnect handling:** The provider automatically re-subscribes after connection loss with exponential backoff.

#### Distributed Locking

- **PostgreSQL advisory locks** (`pg_advisory_lock` / `pg_try_advisory_lock`).
- Lock names are hashed to `bigint` keys.
- Session-level locks released automatically on disconnect (crash safety).
- TTL enforcement via a reaper query on a background interval.

#### Capabilities

```json
{
  "transactions": true,
  "changeNotifications": "both",
  "distributedLocking": true,
  "versionedDocuments": true,
  "binarySupport": true,
  "search": true,
  "maxDocumentSize": 0
}
```

#### Connection Management

- Connection pool with configurable min/max connections.
- Health check via `SELECT 1` on the health endpoint.
- Graceful shutdown drains the pool.

---

### 4.4 OpenSearch Provider

**Purpose:** Organizations already running OpenSearch/Elasticsearch for search and analytics. Offers full-text search across config documents and near-real-time indexing.

#### Dependencies

- `@opensearch-project/opensearch` (OpenSearch client)

#### Index Design

Each namespace maps to an OpenSearch index:

```
Index name pattern: {indexPrefix}-{namespace}
Examples:
  ihub-config-config
  ihub-config-apps
  ihub-config-models
  ihub-config-pages-en
```

#### Document Mapping

```json
{
  "mappings": {
    "properties": {
      "key":          { "type": "keyword" },
      "data":         { "type": "object", "enabled": true },
      "data_raw":     { "type": "text" },
      "content_type": { "type": "keyword" },
      "etag":         { "type": "keyword" },
      "version":      { "type": "long" },
      "updated_at":   { "type": "date" },
      "updated_by":   { "type": "keyword" }
    }
  },
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 1,
    "refresh_interval": "1s"
  }
}
```

#### Write Strategy

- Single-document writes use the `index` API with `if_seq_no` / `if_primary_term` for optimistic concurrency.
- Batch writes use the `_bulk` API. Note: OpenSearch bulk operations are not truly atomic — individual operations can fail independently. The provider reports per-operation success/failure.
- The `refresh_interval` setting controls how quickly writes become visible to readers. Default `1s` is a good balance; configurable for latency-sensitive deployments.

#### Change Notification

- **Poll (primary):** Query a dedicated `ihub-config-changelog` index filtered by timestamp. OpenSearch does not have native pub/sub.
- **Push (optional):** If the deployment includes an event bus (e.g., OpenSearch with SNS/SQS integration or a webhook plugin), the provider can consume external change events.

#### Distributed Locking

- OpenSearch does not natively support distributed locks.
- **Strategy:** Use a dedicated `ihub-config-locks` index with documents representing locks. Acquire via `create` (fails if exists) with a TTL field. Release via `delete`. A background reaper removes expired locks.
- **Caveat:** This is advisory locking. For strong consistency guarantees, pair with an external lock service (Redis, PostgreSQL advisory locks) or accept eventual consistency.

#### Capabilities

```json
{
  "transactions": false,
  "changeNotifications": "poll",
  "distributedLocking": false,
  "versionedDocuments": true,
  "binarySupport": false,
  "search": true,
  "maxDocumentSize": 104857600
}
```

#### Considerations

- **Eventual consistency:** OpenSearch is near-real-time, not strongly consistent. A write followed by an immediate read may not reflect the change. The provider handles this by using `refresh=wait_for` for critical writes (e.g., platform config changes).
- **Schema evolution:** Index mappings are created on init. Field additions are non-breaking in OpenSearch; field type changes require reindexing.

---

### 4.5 S3 Provider

**Purpose:** Cloud-native deployments where S3 (or S3-compatible stores like MinIO) is the infrastructure primitive. Excellent durability, scales infinitely, and integrates with AWS event infrastructure.

#### Dependencies

- `@aws-sdk/client-s3`
- `@aws-sdk/client-sqs` (optional, for push notifications)

#### Object Layout

```
s3://{bucket}/{prefix}{namespace}/{key}.json
s3://{bucket}/{prefix}{namespace}/{key}.md
s3://{bucket}/{prefix}{namespace}/{key}.jsx

Examples:
  s3://ihub-config/ihub/config/config/platform.json
  s3://ihub-config/ihub/config/apps/chat.json
  s3://ihub-config/ihub/config/pages/faq.json
```

ETag and version metadata are stored as S3 object metadata (`x-amz-meta-etag`, `x-amz-meta-version`, `x-amz-meta-updated-by`).

#### Write Strategy

- Single-object `PutObject` with `ContentType` set appropriately.
- Optimistic concurrency via S3 conditional writes (`If-None-Match` for creates, custom version check for updates — read-compare-write with retry).
- Batch operations use parallel `PutObject` calls (S3 has no native batch put). The provider limits concurrency to avoid throttling.
- **Strong read-after-write consistency** (S3 provides this as of December 2020).

#### Change Notification

S3 supports native event publishing via **Amazon S3 Event Notifications**, which can deliver events directly to multiple targets without requiring a separate queue service:

- **Push (primary — EventBridge):** S3 Event Notifications → Amazon EventBridge. This is the recommended approach since November 2021. EventBridge receives all S3 events natively (no per-bucket configuration needed beyond enabling it) and supports rules to route `s3:ObjectCreated:*` and `s3:ObjectRemoved:*` events to targets — including an SQS queue, Lambda function, or HTTP endpoint that the iHub instances consume. EventBridge provides event filtering, replay, and archive capabilities.
- **Push (alternative — direct S3 notifications):** S3 Event Notifications can also publish directly to SNS topics, SQS queues, or Lambda functions without EventBridge. This is the pre-2021 approach and remains fully supported. The provider can long-poll an SQS queue or receive SNS→HTTP webhooks.
- **Poll (fallback):** `ListObjectsV2` comparing object ETags against the last known state. Required for S3-compatible stores (MinIO, Ceph) that may not support the AWS notification mechanisms.

The provider's `notifications.type` config selects the strategy: `eventbridge` (default for AWS), `sqs`, `sns`, or `poll`.

#### Distributed Locking

S3 does not support distributed locks natively.

- **Advisory locking (default):** Lock objects written via S3 conditional writes (`PutObject` with `If-None-Match: *`). Each lock object contains a TTL timestamp, instance ID, and lock token. A background reaper removes expired locks. This is sufficient for migration coordination and infrequent admin writes.
- **External (optional):** For stronger guarantees, pair with an external lock provider (e.g., PostgreSQL advisory locks if PostgreSQL is available alongside S3). No DynamoDB dependency.

#### Capabilities

```json
{
  "transactions": false,
  "changeNotifications": "both",
  "distributedLocking": false,
  "versionedDocuments": false,
  "binarySupport": true,
  "search": false,
  "maxDocumentSize": 5368709120
}
```

#### Considerations

- **Latency:** S3 GET latency (~50–100 ms) is higher than local disk or in-process SQLite. The provider aggressively caches reads in-memory and relies on change events for invalidation.
- **Cost:** Frequent `ListObjectsV2` calls for polling can be expensive at scale. EventBridge or direct S3 notifications are strongly recommended for production.
- **S3-compatible stores:** The provider accepts a custom `endpoint` for MinIO, Ceph, DigitalOcean Spaces, etc. These stores may not support EventBridge or native S3 notifications — use `notifications.type: "poll"` in that case.
- **Encryption at rest:** Defer to S3 server-side encryption (SSE-S3 or SSE-KMS). The provider does not manage encryption keys.

---

## 5. Change Propagation & Eventing System

### 5.1 Architecture

```
                  ┌───────────────┐
                  │  Admin Write  │
                  └──────┬────────┘
                         │
                         ▼
               ┌───────────────────┐
               │  StorageProvider   │──── put() / delete()
               │   (any backend)   │
               └──────┬────────────┘
                      │
              ┌───────┴───────┐
              ▼               ▼
   ┌──────────────┐  ┌──────────────┐
   │ ChangeNotifier│  │ Change Log   │
   │   (push)      │  │   (poll)     │
   └──────┬───────┘  └──────┬───────┘
          │                  │
          ▼                  ▼
   ┌──────────────────────────────┐
   │   configCache.handleChange() │  ← All instances
   │   - Invalidate cache entry   │
   │   - Reload from provider     │
   │   - Apply transforms (groups │
   │     inheritance, secret      │
   │     decryption, tool expand) │
   └──────────────────────────────┘
```

### 5.2 Push-Based Flow (PostgreSQL, S3 Event Notifications)

1. Instance A calls `provider.put('apps', 'chat', newData)`.
2. Provider writes to backend. The backend emits a notification (PG `NOTIFY` or S3 Event Notification).
3. All instances (including A) receive the event via their `ChangeNotifier.subscribe()` handler.
4. Each instance checks if the changed document is in its local cache.
5. If cached: invalidate entry, trigger async reload from provider.
6. If not cached: ignore (will be loaded on next access).

Deduplication: Each event carries a `sourceInstanceId`. Instances can optionally skip reload if they are the source (they already have the latest data). However, for consistency, the default behavior reloads regardless.

### 5.3 Poll-Based Flow (SQLite, OpenSearch, Filesystem Fallback)

1. Each instance runs a background poll loop (configurable interval, default 5 s).
2. On each tick, call `changeNotifier.poll(lastSeenTimestamp)`.
3. If events are returned: process them identically to push events.
4. Update `lastSeenTimestamp` to the latest event's timestamp.

### 5.4 Hybrid Strategy

Providers that support both push and poll should use push as the primary mechanism and poll as a catch-up strategy:

- On startup, poll from the last known checkpoint to catch events missed while the instance was down.
- During normal operation, rely on push.
- If push notifications stop arriving for longer than `2 × pollInterval`, fall back to polling and log a warning.

### 5.5 Cache Integration

The `configCache` module is refactored to depend on `StorageProvider` instead of `configLoader`/`fs`:

```javascript
// Pseudocode for the refactored configCache
class ConfigCache {
  constructor(storageProvider) {
    this.provider = storageProvider;
    this.cache = new Map();

    // Subscribe to changes
    this.provider.getChangeNotifier().subscribe((event) => {
      this.handleChangeEvent(event);
    });
  }

  async handleChangeEvent(event) {
    const cacheKey = `${event.namespace}/${event.key}`;
    if (this.cache.has(cacheKey)) {
      // Invalidate and reload
      const doc = await this.provider.get(event.namespace, event.key);
      this.cache.set(cacheKey, {
        data: this.applyTransforms(event.namespace, event.key, doc),
        etag: doc.etag,
        timestamp: Date.now()
      });
    }
  }
}
```

### 5.6 Ordering and Consistency Guarantees

| Provider | Ordering | Consistency |
|----------|----------|-------------|
| Filesystem | Undefined (filesystem events may reorder) | Eventual (watch debounce) |
| SQLite | Strict (autoincrement ID) | Strong (single writer) |
| PostgreSQL | Strict (LISTEN sequence + change_log ID) | Strong (ACID) |
| OpenSearch | Near-ordered (timestamp-based) | Eventual (refresh interval) |
| S3 | At-least-once, possibly unordered | Eventual (EventBridge/SQS delivery) |

The core handles at-least-once delivery gracefully — reloading an unchanged document is a no-op (ETag comparison).

---

## 6. Migration Strategy

### 6.1 Filesystem → New Provider

The persistence layer ships with a CLI migration tool:

```bash
# Export current filesystem state to a migration bundle
npx ihub-storage export --format json --output ./migration-bundle.json

# Import into the target provider
npx ihub-storage import --provider postgresql --input ./migration-bundle.json

# Verify: compare document counts and ETags
npx ihub-storage verify --source filesystem --target postgresql
```

The import process:

1. Reads every document from the source provider (or filesystem directory).
2. Writes each document to the target provider, preserving namespace, key, and content type.
3. Generates a verification report comparing document counts and ETag checksums.

### 6.2 Provider-to-Provider Migration

The same CLI tool supports arbitrary source → target migrations:

```bash
npx ihub-storage migrate \
  --source filesystem \
  --source-config '{"basePath": "./contents"}' \
  --target postgresql \
  --target-config '{"connectionString": "postgres://..."}' \
  --dry-run
```

### 6.3 Rollback Strategy

- **Filesystem backup:** Before migration, the tool creates a timestamped backup of the `contents/` directory.
- **Dual-write mode:** During a transition period, the server can be configured to write to both the old and new provider simultaneously (`storage.dualWrite: true`). Reads come from the new provider; writes go to both. This allows instant rollback by switching `storage.provider` back to `filesystem`.
- **Dual-write duration:** Recommended for 1–2 weeks after migration to build confidence.

### 6.4 Schema Migration Integration

The existing Flyway-style migration system (`server/migrations/`) continues to work. The migration runner is updated to use `StorageProvider` instead of direct filesystem access:

```javascript
// Migration context API is updated:
// ctx.readJson()  → calls provider.get()
// ctx.writeJson() → calls provider.put()
// ctx.fileExists() → calls provider.exists()
// etc.
```

The migration lock transitions from a file-based lock to `LockManager.acquire('migrations')`, which uses the provider's native locking mechanism.

---

## 7. Extensibility Guide

### 7.1 Adding a New Provider

To add a new storage backend (e.g., Redis, MongoDB, etcd, Azure Blob Storage, Google Cloud Storage):

#### Step 1: Create the Provider Class

```
server/storage/providers/{name}Provider.js
```

Implement the `StorageProvider` interface:

```javascript
import { BaseStorageProvider } from '../BaseStorageProvider.js';

export class RedisProvider extends BaseStorageProvider {
  constructor() {
    super('redis');
  }

  async initialize(config) { /* connect to Redis */ }
  async shutdown() { /* close connection */ }
  async healthCheck() { /* PING */ }

  async get(namespace, key) { /* HGET */ }
  async put(namespace, key, data, meta) { /* HSET + PUBLISH */ }
  async delete(namespace, key) { /* HDEL + PUBLISH */ }
  async exists(namespace, key) { /* HEXISTS */ }
  async list(namespace, options) { /* HKEYS */ }
  async getAll(namespace, options) { /* HGETALL */ }

  getCapabilities() {
    return {
      transactions: true,       // Redis MULTI/EXEC
      changeNotifications: 'push', // Redis Pub/Sub
      distributedLocking: true, // SETNX + TTL
      versionedDocuments: false,
      binarySupport: true,
      search: false,
      maxDocumentSize: 536870912 // 512 MB
    };
  }
}
```

#### Step 2: Implement ChangeNotifier (if provider has native pub/sub)

```javascript
import { BaseChangeNotifier } from '../BaseChangeNotifier.js';

export class RedisChangeNotifier extends BaseChangeNotifier {
  async start() { /* SUBSCRIBE ihub_changes */ }
  async stop() { /* UNSUBSCRIBE */ }
  async publish(event) { /* PUBLISH ihub_changes {event} */ }
}
```

If the provider does not support native pub/sub, use the built-in `PollingChangeNotifier` base class, which only requires implementing `poll(since)`.

#### Step 3: Implement LockManager (if provider supports locking)

```javascript
import { BaseLockManager } from '../BaseLockManager.js';

export class RedisLockManager extends BaseLockManager {
  async acquire(name, options) { /* SET key token NX EX ttl */ }
  async release(handle) { /* Lua script: compare token, DEL */ }
}
```

If the provider does not support locking, return a `NoOpLockManager` that throws on `acquire()` with a helpful message directing the user to pair with an external lock provider.

#### Step 4: Register the Provider

```javascript
// server/storage/providers/index.js
import { RedisProvider } from './redisProvider.js';

export const providers = {
  // ... existing providers
  redis: (config) => new RedisProvider(config)
};
```

#### Step 5: Add Configuration Schema

Add the provider's config shape to the platform.json storage schema:

```json
{
  "storage": {
    "redis": {
      "url": "${IHUB_REDIS_URL}",
      "prefix": "ihub:",
      "db": 0
    }
  }
}
```

#### Step 6: Document the Provider

Create `docs/storage-providers/{name}.md` covering:

- Prerequisites and dependencies
- Configuration options (JSON and environment variables)
- Capabilities and limitations
- Recommended deployment topology
- Performance characteristics
- Backup and disaster recovery

#### Step 7: Test the Provider

The persistence layer includes a **provider conformance test suite** — a set of abstract tests that any provider must pass:

```javascript
// server/storage/__tests__/providerConformance.js
export function runConformanceTests(providerFactory) {
  describe('StorageProvider conformance', () => {
    // ~40 tests covering all interface methods
    test('get returns null for missing document');
    test('put creates new document with correct ETag');
    test('put overwrites existing document and updates ETag');
    test('delete returns true for existing document');
    test('delete returns false for missing document');
    test('list returns all keys in namespace');
    test('getAll returns all documents');
    test('putBatch writes multiple documents');
    test('optimistic concurrency rejects stale writes');
    test('change events are emitted on put');
    test('change events are emitted on delete');
    // ... etc.
  });
}

// Usage in provider-specific test:
import { runConformanceTests } from '../providerConformance.js';
import { RedisProvider } from './redisProvider.js';

runConformanceTests(() => new RedisProvider(testConfig));
```

### 7.2 File Structure

```
server/storage/
├── StorageProvider.js           # Interface definition (JSDoc / TypeScript types)
├── StorageRegistry.js           # Factory and provider resolution
├── BaseStorageProvider.js       # Shared logic (ETag generation, event wrapping)
├── BaseChangeNotifier.js        # Base class for change notifiers
├── PollingChangeNotifier.js     # Generic poll-based notifier
├── BaseLockManager.js           # Base class for lock managers
├── NoOpLockManager.js           # Throws on acquire (for providers without locking)
├── providers/
│   ├── index.js                 # Provider registry
│   ├── filesystemProvider.js
│   ├── sqliteProvider.js
│   ├── postgresqlProvider.js
│   ├── opensearchProvider.js
│   └── s3Provider.js
├── __tests__/
│   ├── providerConformance.js   # Abstract conformance test suite
│   ├── filesystem.test.js
│   ├── sqlite.test.js
│   ├── postgresql.test.js
│   ├── opensearch.test.js
│   └── s3.test.js
└── cli/
    ├── export.js                # CLI: export data
    ├── import.js                # CLI: import data
    ├── migrate.js               # CLI: provider-to-provider migration
    └── verify.js                # CLI: verify migration integrity
```

---

## 8. Admin UI

The Admin UI provides a dedicated section for selecting, configuring, testing, and monitoring the storage backend — consistent with the existing admin page patterns (`AdminAuth` guard, `AdminNavigation` sidebar, form editors with dual JSON/form mode).

### 8.1 Navigation & Access

A new **Storage** entry is added to the admin sidebar navigation, visible only to users with `adminAccess: true`. The route is `/admin/storage`, registered in `App.jsx` (and added to `knownRoutes` in `runtimeBasePath.js`).

### 8.2 Storage Overview Page (`AdminStoragePage`)

The landing page shows the current storage state at a glance:

```
┌──────────────────────────────────────────────────────────┐
│  Storage Configuration                                    │
│                                                           │
│  Active Provider    ██ PostgreSQL         ● Healthy (3ms) │
│  Instance ID        ihub-prod-01                          │
│  Documents          247 across 12 namespaces              │
│  Last Change Event  12 seconds ago                        │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  Configure   │  │  Test Conn.  │  │   Migrate    │   │
│  └──────────────┘  └──────────────┘  └──────────────┘   │
│                                                           │
│  Change Event Log (last 50)                               │
│  ┌────────┬───────────┬────────┬───────────┬──────────┐  │
│  │ Time   │ Namespace │ Key    │ Action    │ Instance │  │
│  ├────────┼───────────┼────────┼───────────┼──────────┤  │
│  │ 12s    │ apps      │ chat   │ put       │ prod-01  │  │
│  │ 1m     │ config    │ ui     │ put       │ prod-02  │  │
│  │ 5m     │ models    │ gpt-4o │ delete    │ prod-01  │  │
│  └────────┴───────────┴────────┴───────────┴──────────┘  │
└──────────────────────────────────────────────────────────┘
```

**Data sources:**
- `GET /api/admin/storage` — returns provider name, health status, instance ID, document counts, last change timestamp
- `GET /api/admin/storage/events?limit=50` — returns recent change events from the change log

### 8.3 Provider Configuration Page (`AdminStorageConfigPage`)

Accessed via the **Configure** button. Uses the `DualModeEditor` pattern (form mode + JSON mode) to edit the `storage` section of `platform.json`.

#### Form Mode

The form dynamically renders provider-specific fields based on the selected provider:

**Provider Selector** — A dropdown listing all registered providers. Changing the selection shows/hides the relevant config section. The provider list is fetched from `GET /api/admin/storage/providers`, which returns the output of `StorageRegistry.listProviders()` enriched with each provider's capabilities.

**Provider-Specific Config Forms:**

| Provider | Fields |
|----------|--------|
| Filesystem | Base path, watch for changes toggle, watch debounce (ms) |
| SQLite | Database file path, WAL mode toggle, busy timeout (ms) |
| PostgreSQL | Connection string (password masked), schema name, pool min/max/idle timeout, notification channel |
| OpenSearch | Node URL, index prefix, username, password (masked), refresh interval |
| S3 | Bucket, prefix, region, endpoint (optional), notification type (EventBridge/SQS/SNS/poll), event bus name, queue URL |

Fields that accept environment variable placeholders (`${VAR_NAME}`) show a small info badge indicating the resolved value (or "not set" if the variable is undefined). Secret fields follow the existing `***REDACTED***` pattern — the client receives redacted values, and if saved unchanged, the server restores the original encrypted value.

#### JSON Mode

Raw JSON editor for the `storage` object within `platform.json`, useful for power users or copying config between environments.

#### Save Flow

```
1. User edits form fields
2. Clicks "Save"
3. Client calls POST /api/admin/storage/_configure with the storage section
4. Server validates the config shape against provider schema
5. Server encrypts any secrets (connection strings, passwords)
6. Server merges into platform.json via atomicWriteJSON
7. Server refreshes configCache
8. Response includes a "restart required" flag if the provider changed
   (provider changes require restart; config tweaks within the same
    provider are hot-reloaded where possible)
9. UI shows success toast; if restart required, shows a restart banner
```

### 8.4 Connection Test (`TestConnectionButton`)

A **Test Connection** button is available both on the overview page (tests the active provider) and on the config page (tests the provider being configured, even before saving). This allows the admin to validate credentials and connectivity before committing a change.

**Flow:**

```
1. Client calls POST /api/admin/storage/_test with provider name + config
2. Server instantiates a temporary provider with the given config
3. Server calls provider.initialize() → provider.healthCheck()
4. Server calls provider.shutdown()
5. Returns: { success, latencyMs, details, error? }
6. UI shows green check with latency, or red error with message
```

This is a read-only, side-effect-free operation — the temporary provider is discarded after the test.

### 8.5 Migration Wizard (`AdminStorageMigrationPage`)

Accessed via the **Migrate** button. Provides a guided UI for the CLI migration operations (§6), targeting admins who prefer a visual workflow.

#### Step 1: Source & Target Selection

```
┌─────────────────────────────────────────────────┐
│  Migration Wizard                                │
│                                                  │
│  Source: [Filesystem ▾]  (current provider)      │
│  Target: [PostgreSQL ▾]                          │
│                                                  │
│  Target Configuration:                           │
│  ┌─ Connection String: [postgres://...       ] ──┤
│  │  Schema:            [ihub                 ]   │
│  └───────────────────────────────────────────────┤
│                                                  │
│  [Test Target Connection]   ● Connected (5ms)    │
│                                                  │
│  [Next →]                                        │
└─────────────────────────────────────────────────┘
```

#### Step 2: Pre-Migration Analysis

```
┌─────────────────────────────────────────────────┐
│  Pre-Migration Analysis                          │
│                                                  │
│  Documents to migrate: 247                       │
│  Namespaces: 12                                  │
│  Estimated size: 1.2 MB                          │
│                                                  │
│  Namespace Breakdown:                            │
│  ┌──────────────┬───────┬────────┐              │
│  │ Namespace    │ Count │ Size   │              │
│  ├──────────────┼───────┼────────┤              │
│  │ apps         │ 15    │ 180 KB │              │
│  │ models       │ 22    │ 95 KB  │              │
│  │ config       │ 13    │ 420 KB │              │
│  │ pages        │ 8     │ 65 KB  │              │
│  │ ...          │       │        │              │
│  └──────────────┴───────┴────────┘              │
│                                                  │
│  ☐ Enable dual-write mode after migration        │
│                                                  │
│  [← Back]   [Start Migration]                    │
└─────────────────────────────────────────────────┘
```

#### Step 3: Migration Progress

```
┌─────────────────────────────────────────────────┐
│  Migration In Progress                           │
│                                                  │
│  ████████████████████░░░░  82% (203/247)         │
│                                                  │
│  ✓ config (13/13)                                │
│  ✓ apps (15/15)                                  │
│  ✓ models (22/22)                                │
│  → pages (5/8)                                   │
│  ○ secrets (0/3)                                 │
│  ○ ...                                           │
│                                                  │
│  Elapsed: 4.2s                                   │
└─────────────────────────────────────────────────┘
```

#### Step 4: Verification & Activation

```
┌─────────────────────────────────────────────────┐
│  Migration Complete                              │
│                                                  │
│  ✓ 247/247 documents migrated                    │
│  ✓ ETag verification passed for all documents    │
│  ✓ Target provider health check passed           │
│                                                  │
│  Next steps:                                     │
│  [Activate PostgreSQL as primary provider]        │
│     (requires server restart)                    │
│                                                  │
│  [← Back to Storage Overview]                    │
└─────────────────────────────────────────────────┘
```

**API endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /api/admin/storage/migration/_analyze` | POST | Pre-migration analysis (document counts, sizes) |
| `POST /api/admin/storage/migration/_start` | POST | Start migration (returns job ID) |
| `GET /api/admin/storage/migration/:jobId` | GET | Poll migration progress |
| `POST /api/admin/storage/migration/:jobId/_activate` | POST | Switch active provider to the migration target |

Migration runs server-side as a background job. The UI polls for progress updates. The migration acquires a distributed lock (`migrations`) to prevent concurrent migrations.

### 8.6 Monitoring Dashboard (`AdminStorageMonitorPage`)

An optional monitoring view (accessible from the overview page) showing real-time operational metrics:

- **Throughput:** Read/write operations per minute (line chart, last 1 hour)
- **Latency:** p50/p95/p99 operation latency (line chart, last 1 hour)
- **Cache hit rate:** Percentage of reads served from `configCache` vs. provider (gauge)
- **Change event rate:** Events per minute across all instances (line chart)
- **Active locks:** Currently held distributed locks (table)

**Data source:** `GET /api/admin/storage/metrics` — returns aggregated metrics from the in-process metric counters (§10.1). For multi-instance deployments, each instance reports its own metrics; the UI shows the current instance's view.

### 8.7 File Structure (Client)

```
client/src/features/admin/
├── AdminStoragePage.jsx              # Overview page
├── AdminStorageConfigPage.jsx        # Provider configuration (form + JSON)
├── AdminStorageMigrationPage.jsx     # Migration wizard
├── AdminStorageMonitorPage.jsx       # Monitoring dashboard
└── components/
    ├── StorageProviderSelector.jsx   # Provider dropdown with capability badges
    ├── StorageProviderForm.jsx       # Dynamic form renderer per provider
    ├── TestConnectionButton.jsx      # Connection test with status indicator
    ├── MigrationProgress.jsx         # Progress bar with namespace breakdown
    └── StorageMetricsCharts.jsx      # Recharts-based metric visualizations
```

### 8.8 API Routes (Server)

```
server/routes/admin/storage.js

GET    /api/admin/storage                           # Overview: provider, health, doc count
GET    /api/admin/storage/providers                  # List registered providers + capabilities
GET    /api/admin/storage/events                     # Recent change events
POST   /api/admin/storage/_configure                 # Save storage config
POST   /api/admin/storage/_test                      # Test connection (temporary provider)
POST   /api/admin/storage/migration/_analyze         # Pre-migration analysis
POST   /api/admin/storage/migration/_start           # Start migration job
GET    /api/admin/storage/migration/:jobId           # Migration progress
POST   /api/admin/storage/migration/:jobId/_activate # Activate target provider
GET    /api/admin/storage/metrics                    # Operational metrics
```

All endpoints require `adminAccess: true` via the standard `adminAuth` middleware.

---

## 9. Security Considerations

### 9.1 Secret Management

The `TokenStorageService` encryption layer continues to operate above the storage provider. Secrets are encrypted before being passed to `provider.put()` and decrypted after `provider.get()`. The storage provider never sees plaintext secrets.

For providers with native encryption (S3 SSE, PostgreSQL TDE), this provides defense-in-depth: application-level encryption + storage-level encryption.

The encryption key (currently stored in `contents/.encryption-key`) is stored in the `secrets` namespace within the active provider. For multi-instance deployments, the encryption key should be supplied via the `IHUB_ENCRYPTION_KEY` environment variable so all instances share the same key without needing to read it from the provider first. If the env var is not set, the key is read from the provider on startup (adequate for single-instance deployments). JWT signing keys follow the same pattern (`IHUB_JWT_PRIVATE_KEY`, `IHUB_JWT_PUBLIC_KEY`).

### 9.2 Access Control

- **PostgreSQL:** Provider connects with a dedicated database user. Schema-level `GRANT` restricts access to iHub tables only.
- **OpenSearch:** Provider authenticates with dedicated credentials. Index-level security policies restrict access.
- **S3:** IAM policies restrict bucket access to the iHub service role. Bucket policy denies public access.

### 9.3 Data at Rest

| Provider | Encryption at Rest |
|----------|--------------------|
| Filesystem | OS-level disk encryption (BitLocker, LUKS) |
| SQLite | SQLite Encryption Extension (SEE) or OS-level |
| PostgreSQL | Transparent Data Encryption (TDE) or OS-level |
| OpenSearch | Node-level encryption (built-in) |
| S3 | SSE-S3, SSE-KMS, or SSE-C |

All providers additionally benefit from iHub's application-level AES-256-GCM encryption for sensitive fields.

### 9.4 Data in Transit

All providers must use encrypted connections in production:

- PostgreSQL: `sslmode=require` (configurable)
- OpenSearch: HTTPS endpoint
- S3: HTTPS (enforced by AWS SDK)
- SQLite: N/A (local file)

---

## 10. Observability

### 10.1 Metrics

Each provider emits standardized metrics:

| Metric | Type | Labels |
|--------|------|--------|
| `ihub_storage_operation_duration_ms` | Histogram | `provider`, `operation`, `namespace` |
| `ihub_storage_operation_total` | Counter | `provider`, `operation`, `namespace`, `status` |
| `ihub_storage_cache_hit_total` | Counter | `namespace` |
| `ihub_storage_cache_miss_total` | Counter | `namespace` |
| `ihub_storage_change_events_total` | Counter | `provider`, `action` |
| `ihub_storage_lock_acquired_total` | Counter | `provider` |
| `ihub_storage_lock_contention_total` | Counter | `provider` |

### 10.2 Logging

- All provider operations logged at `debug` level.
- Errors and retries logged at `warn`/`error`.
- Change events logged at `info` with namespace and key.

### 10.3 Health Endpoint

The existing `/api/health` endpoint is extended to include storage provider status:

```json
{
  "status": "healthy",
  "storage": {
    "provider": "postgresql",
    "healthy": true,
    "latencyMs": 3,
    "details": {
      "poolSize": 10,
      "activeConnections": 2,
      "idleConnections": 8
    }
  }
}
```

---

## 11. Testing Strategy

### 11.1 Unit Tests

- Each provider has isolated unit tests mocking the underlying client (pg, S3 SDK, etc.).
- `BaseStorageProvider` logic (ETag generation, event wrapping) tested independently.

### 11.2 Integration Tests

- **Filesystem:** Runs against a temp directory.
- **SQLite:** Runs against an in-memory database (`:memory:`).
- **PostgreSQL:** Runs against a Docker container (testcontainers or `docker-compose`).
- **OpenSearch:** Runs against a Docker container.
- **S3:** Runs against MinIO in Docker.

### 11.3 Conformance Tests

The abstract conformance suite (§7.1 Step 7) runs against every provider, ensuring consistent behavior across backends.

### 11.4 Migration Tests

- Round-trip test: filesystem → target provider → filesystem, verify byte-identical output.
- Dual-write test: verify both providers receive all writes during transition.

---

## 12. Performance Considerations

### 12.1 Caching Layer

The `configCache` in-memory cache remains the primary read path. The storage provider is only accessed on cache miss or change-event-triggered reload. This means read latency is dominated by in-memory Map lookups regardless of backend.

### 12.2 Write Latency

| Provider | Typical Write Latency | Notes |
|----------|----------------------|-------|
| Filesystem | < 1 ms | Local SSD; higher on NFS |
| SQLite | 1–5 ms | WAL mode, local SSD |
| PostgreSQL | 2–10 ms | Network round-trip |
| OpenSearch | 5–50 ms | Index + refresh |
| S3 | 50–200 ms | Network + object creation |

Since config writes are infrequent (admin operations), write latency is not a primary concern. The critical path is read latency, which is always served from cache.

### 12.3 Startup Time

Provider initialization adds to server startup:

| Provider | Initialization Time | Notes |
|----------|-------------------|-------|
| Filesystem | ~0 ms | No connection setup |
| SQLite | ~10 ms | Open file, create tables if needed |
| PostgreSQL | ~50 ms | Connection pool init, schema check |
| OpenSearch | ~100 ms | Cluster health check, index creation |
| S3 | ~200 ms | Bucket existence check, credential validation |

---

## 13. Documentation

Documentation follows the project's established convention: feature docs live in `docs/`, concept docs in `concepts/`.

### 13.1 User-Facing Documentation (`docs/`)

| Document | Content |
|----------|---------|
| `docs/storage.md` | Overview of the persistence layer: what it does, why it exists, how to configure a provider. Quick-start for each backend. |
| `docs/storage-providers/filesystem.md` | Filesystem provider reference: config options, watch behavior, NFS considerations, backup strategies. |
| `docs/storage-providers/sqlite.md` | SQLite provider reference: WAL mode, file location, single-machine limitations, backup via `.backup` command. |
| `docs/storage-providers/postgresql.md` | PostgreSQL provider reference: connection setup, schema management, LISTEN/NOTIFY tuning, pool sizing, TLS configuration, backup/restore with `pg_dump`. |
| `docs/storage-providers/opensearch.md` | OpenSearch provider reference: index mapping, refresh interval tuning, authentication, snapshot/restore, eventual consistency caveats. |
| `docs/storage-providers/s3.md` | S3 provider reference: bucket setup, IAM policies, EventBridge/SQS/SNS notification setup, MinIO compatibility, encryption (SSE-S3/SSE-KMS). |
| `docs/storage-migration.md` | Step-by-step migration guide: filesystem → database, CLI usage, Admin UI wizard, dual-write mode, rollback procedure, verification checklist. |
| `docs/storage-extending.md` | How to implement a custom storage provider: interface contract, conformance tests, registration, configuration, and documentation requirements. |

All documents are added to `docs/SUMMARY.md` for inclusion in the documentation site.

### 13.2 Inline Documentation

- **JSDoc on all interface methods** in `StorageProvider.js`, `ChangeNotifier.js`, `LockManager.js` — serves as the authoritative API reference.
- **README.md** in `server/storage/` — developer-facing overview of the module structure, how to run tests, and how to add providers.
- **Migration context API** — update the existing migration docs to reflect the new `StorageProvider`-backed context methods.

### 13.3 ADR (Architecture Decision Record)

An ADR is added to `concepts/persistence-layer/` documenting the key design decisions:

- Why a provider interface rather than a repository/DAO pattern.
- Why pages consolidate translations into a single document.
- Why the filesystem provider remains the default.
- Trade-off analysis for each backend (consistency vs. operational complexity).

### 13.4 Changelog & Release Notes

Each phase (1a–1e) produces a changelog entry covering new capabilities, configuration changes, and any breaking changes. The initial release (Phase 1a) includes a migration guide for existing deployments.

---

## 14. Rollout Plan

### Phase 1a: Abstraction Layer (Weeks 1–3)

- Implement `StorageProvider` interface and base classes.
- Implement `StorageRegistry`.
- Refactor `configCache.js` to use `StorageProvider`.
- Implement and ship the **Filesystem provider** as default (zero behavior change).
- All existing tests pass with filesystem provider.

### Phase 1b: Additional Providers (Weeks 4–8)

- Implement SQLite provider.
- Implement PostgreSQL provider.
- Implement OpenSearch provider.
- Implement S3 provider.
- Conformance test suite passing for all providers.

### Phase 1c: Migration Tooling & Hardening (Weeks 9–10)

- CLI migration tool (export/import/verify/migrate).
- Dual-write mode.
- Performance benchmarks.
- Documentation: `docs/storage.md`, per-provider guides (`docs/storage-providers/*.md`), migration guide (`docs/storage-migration.md`), extensibility guide (`docs/storage-extending.md`), ADR.

### Phase 1d: Admin UI (Weeks 11–13)

- Storage overview page (provider status, health, document counts, change event log).
- Provider configuration page (form + JSON dual mode, connection test).
- Migration wizard (analyze → migrate → verify → activate).
- Monitoring dashboard (throughput, latency, cache hit rate charts).
- Admin API routes (`/api/admin/storage/*`).

### Phase 1e: Production Readiness (Weeks 14–15)

- Observability integration (metrics, health check, logging).
- Security review (access control, encryption).
- Load testing with PostgreSQL and S3 providers.
- End-to-end testing of Admin UI migration wizard.
- Release candidate.

---

## 15. Resolved Questions

| # | Question | Decision |
|---|----------|----------|
| 1 | Should the `secrets` namespace (encryption key, JWT keys) always remain on the filesystem for bootstrap, or should it be provider-backed too? | **Resolved:** Encryption key can be supplied via `IHUB_ENCRYPTION_KEY` env var for multi-instance deployments. If not configured, the key is stored in the active provider (i.e., alongside the data it protects). JWT keys follow the same pattern. No special filesystem fallback — the provider is the single source of truth. |
| 2 | Do we need a read-through cache in front of the provider, or is `configCache` sufficient? | **Resolved:** `configCache`-only. No additional caching layer. |
| 3 | Should the change log be automatically pruned, and if so, what retention period? | **Resolved:** Yes, 30-day default retention. Configurable via `storage.changeLog.retentionDays` (integer) and `storage.changeLog.retentionPolicy` (`prune` or `keep`). Setting `keep` disables automatic pruning. |
| 4 | For S3 provider, is DynamoDB an acceptable hard dependency for locking, or should we support lock-free operation? | **Resolved:** No DynamoDB dependency. S3 provider uses advisory locking via conditional writes (`PutObject` with `If-None-Match: *`) with TTL-based expiration and a reaper. For stronger guarantees, pair with an external lock provider (e.g., PostgreSQL advisory locks). |
| 5 | Should page `.jsx` components be stored as raw text or compiled at write time? | **Resolved:** Raw text, compile on read (preserves current behavior). |
| 6 | Should provider configuration itself be bootstrapped from environment variables only (avoiding a chicken-and-egg with platform.json)? | **Resolved:** Default is filesystem if nothing is configured. Provider can be selected via `IHUB_STORAGE_PROVIDER` env var or `platform.json → storage.provider`. Can be changed later via Admin UI or env var. No chicken-and-egg — the system boots with filesystem, reads `platform.json`, and if a different provider is configured there, switches on next restart. |

---

## 16. Appendix

### A. Provider Comparison Matrix

| Capability | Filesystem | SQLite | PostgreSQL | OpenSearch | S3 |
|------------|-----------|--------|------------|------------|-----|
| **Transactions** | No | Yes | Yes | No | No |
| **Push notifications** | fs.watch | No | LISTEN/NOTIFY | No | EventBridge / SQS / SNS |
| **Poll notifications** | Stat-based | Change log | Change log | Timestamp query | ListObjects |
| **Distributed locking** | No | Advisory (single machine) | Advisory locks | No | Advisory (conditional writes) |
| **Versioned documents** | No | Yes | Yes | Yes (seq_no) | No |
| **Full-text search** | No | No | JSONB GIN | Yes | No |
| **Binary storage** | Yes | Yes | Yes (bytea) | No | Yes |
| **Max document size** | Unlimited | Unlimited | Unlimited | ~100 MB | 5 GB |
| **Best for** | Dev, single instance | Small teams, local dev | Production HA | Search-heavy orgs | Cloud-native |

### B. Environment Variable Reference

```bash
# Provider selection
IHUB_STORAGE_PROVIDER=filesystem|sqlite|postgresql|opensearch|s3

# Instance identity (for change event dedup)
IHUB_STORAGE_INSTANCE_ID=auto  # auto-generates UUID on first run

# Change log retention
IHUB_STORAGE_CHANGE_LOG__RETENTION_DAYS=30       # default: 30
IHUB_STORAGE_CHANGE_LOG__RETENTION_POLICY=prune   # prune|keep

# Secrets (for multi-instance deployments)
IHUB_ENCRYPTION_KEY=base64-encoded-key
IHUB_JWT_PRIVATE_KEY=base64-encoded-pem
IHUB_JWT_PUBLIC_KEY=base64-encoded-pem

# Filesystem
IHUB_STORAGE_FILESYSTEM__BASE_PATH=./contents
IHUB_STORAGE_FILESYSTEM__WATCH_FOR_CHANGES=true

# SQLite
IHUB_STORAGE_SQLITE__PATH=./contents/ihub.db

# PostgreSQL
IHUB_STORAGE_POSTGRESQL__CONNECTION_STRING=postgres://user:pass@host:5432/ihub
IHUB_STORAGE_POSTGRESQL__SCHEMA=ihub
IHUB_STORAGE_POSTGRESQL__POOL__MIN=2
IHUB_STORAGE_POSTGRESQL__POOL__MAX=10

# OpenSearch
IHUB_STORAGE_OPENSEARCH__NODE=https://localhost:9200
IHUB_STORAGE_OPENSEARCH__INDEX_PREFIX=ihub-config
IHUB_STORAGE_OPENSEARCH__AUTH__USERNAME=admin
IHUB_STORAGE_OPENSEARCH__AUTH__PASSWORD=secret

# S3
IHUB_STORAGE_S3__BUCKET=ihub-config
IHUB_STORAGE_S3__PREFIX=ihub/config/
IHUB_STORAGE_S3__REGION=eu-central-1
IHUB_STORAGE_S3__ENDPOINT=https://s3.eu-central-1.amazonaws.com
IHUB_STORAGE_S3__NOTIFICATIONS__TYPE=eventbridge  # eventbridge|sqs|sns|poll
IHUB_STORAGE_S3__NOTIFICATIONS__EVENT_BUS_NAME=default
IHUB_STORAGE_S3__NOTIFICATIONS__SQS_QUEUE_URL=https://sqs.eu-central-1.amazonaws.com/123456789/ihub-changes
IHUB_STORAGE_S3__NOTIFICATIONS__SNS_TOPIC_ARN=arn:aws:sns:eu-central-1:123456789:ihub-changes
```

### C. Glossary

| Term | Definition |
|------|-----------|
| **Namespace** | Logical grouping of documents (maps to directory, table, index, or S3 prefix) |
| **Document** | A single configuration entity with key, data, metadata |
| **ETag** | Content hash for change detection and optimistic concurrency |
| **Change event** | Notification that a document was created, updated, or deleted |
| **Provider** | Implementation of the StorageProvider interface for a specific backend |
| **Conformance test** | Abstract test suite that validates provider correctness |
| **Dual-write** | Transition mode where writes go to both old and new provider simultaneously |
