# PII Data Handling

This document is the authoritative reference for what personally identifiable
information (PII) iHub Apps captures, where and how long it persists, and which
configuration switches disable or anonymize it. It exists so platform operators
can answer customer/auditor questions about GDPR compliance and data residency
without reverse-engineering the codebase.

## Summary

| Category | Captured by default? | Persistence | Disable / anonymize via |
| --- | --- | --- | --- |
| Chat messages (user prompts, LLM responses) | **No** (not stored to disk) | In-memory only; client `sessionStorage` until tab close | n/a — never persisted server-side |
| User identity (id, email, name, groups) | Yes (when logged in) | `contents/config/users.json` (local accounts) | Anonymous auth mode; admin-driven account deletion |
| JWT session cookie | Yes (when logged in) | Browser cookie + signed token; **8 h** default | `auth.sessionTimeoutMinutes` |
| Audit log (admin actions) | Yes | `contents/data/audit-log/YYYY-MM-DD.jsonl`; **365 d** default | `audit.cleanupEnabled`, `audit.retentionDays` |
| Audit log IP address | Yes (verbatim) | Audit log entries | **`audit.anonymizeIp`** (new) |
| Audit log email-shaped identifiers | Masked by default | Audit log entries | `audit.includeEmail` |
| Usage events (per-request) | Yes | `contents/data/usage-events.jsonl`; **90 d** default | `features.usageTracking: false`, `usageTracking.eventRetentionDays` |
| Usage daily rollups | Yes | `contents/data/usage-daily/*.json`; **365 d** default | `usageTracking.dailyRetentionDays` |
| Usage monthly rollups | Yes | `contents/data/usage-monthly/*.json`; **indefinite** default | `usageTracking.monthlyRetentionDays` |
| Cumulative usage counters | Yes | `contents/data/usage.json`; never expires | Manual reset via admin |
| Feedback (rating + 300-char snippet + comment) | Only when a user rates | `contents/data/feedback.jsonl`; **indefinite** default | `features.feedbackTracking: false`, **`usageTracking.feedbackRetentionDays`** (new) |
| Structured log lines | Yes (stdout) | Console always; optional file `logs/app.log` | `logging.level`, `logging.file.enabled` |
| Logger IP context | Yes (merged into every line) | Same as above | **`logging.anonymizeIp`** (new) |
| OpenTelemetry signals | **No** | Disabled by default; OTLP/Prometheus when enabled | `telemetry.enabled: false` |
| Prompts/completions in telemetry | **No** | Spans only when explicitly opted in | `telemetry.events.includePrompts/includeCompletions` |
| File/image uploads | Not persisted | In-memory only; forwarded to LLM and discarded | n/a |
| OAuth refresh tokens | Yes (hashed) | `contents/data/oauth-refresh-tokens.json`; **30 d** | `oauth.refreshTokenExpirationDays` |
| Integration tokens | Yes (encrypted) | `contents/integrations/`; AES-256-GCM | Per-user revoke; admin disable |

> **Bottom line**: out of the box, no chat content lands on disk. The only durable
> PII is the user identity (when local accounts are used), audit entries for admin
> actions, anonymized-or-pseudonymous usage counters, and optional feedback the
> user explicitly submitted.

## What is captured, in detail

### 1. User identity

The canonical user record is built in `server/utils/userManager.js` and contains
`id`, `username`, `email`, `name`, `internalGroups`, `active`, `lastActiveDate`,
plus per-provider authentication metadata. Source depends on the configured
auth mode:

| Auth mode | Where the PII originates |
| --- | --- |
| `local` | The admin-created entry in `contents/config/users.json` (bcrypt-hashed password) |
| `oidc` | The configured IdP's userinfo endpoint (`sub`, email, name, groups) |
| `ldap` | The directory's user attributes (`uid` / `sAMAccountName`, `mail`, group memberships) |
| `ntlm` | The Windows domain (`UserName`, `Domain`, `DisplayName`, `Email`, groups) |
| `proxy` | Reverse-proxy headers (`x-forwarded-user`, `x-forwarded-email`, groups header) |
| `anonymous` | `id: "anonymous"`, no email/name |

The signed JWT cookie carries `sub`, `username`, `name`, `email`, `groups`,
`provider` and is `httpOnly`, `sameSite=lax`, secure when HTTPS. Default
lifetime is 8 hours (`auth.sessionTimeoutMinutes`, see
`server/utils/tokenService.js`).

### 2. Chat content

User messages and LLM responses live only in:

- the in-flight HTTP request body and the model provider's API call;
- the browser's `sessionStorage` (key `ai_hub_chat_messages_<chatId>`), cleared
  when the tab closes;
- the OS-level container memory of the LLM provider you point iHub at.

The server **does not write a transcript to disk** by default. The two known
ways chat content can become durable are:

1. **Feedback submissions** — when a user clicks a rating, the first 300
   characters of the rated message (plus any free-text comment) are appended
   to `contents/data/feedback.jsonl` (`server/feedbackStorage.js`).
2. **Verbose logging** — `server/utils.js`'s `logInteraction()` calls
   `logger.info(...)` with the user query and the first 1000 characters of the
   response. By default the logger only writes to **stdout**, so this becomes
   durable only if `logging.file.enabled: true` is set or stdout is captured
   by your container runtime / log shipper.
3. **External iAssistant / iFinder integration** — when configured, full
   conversations are sent to and stored by the external iFinder server. That
   is a deliberate third-party integration; the data belongs to that backend.

### 3. Usage events and rollups

The usage tracker (`server/usageTracker.js`,
`server/services/UsageEventLog.js`, `server/services/UsageAggregator.js`)
records **metadata only** — never message content. Each request appends a
one-line JSON event to `contents/data/usage-events.jsonl`:

```json
{
  "ts": "2026-06-18T10:14:22.123Z",
  "type": "chat_request",
  "uid": "usr_3a9c…",
  "app": "translator",
  "model": "claude-haiku-4-5-20251001",
  "pt": 421,
  "ct": 0,
  "src": "provider"
}
```

`uid` form depends on `features.usageTrackingMode`:

| Mode | `uid` value | Reversible? |
| --- | --- | --- |
| `anonymous` | `usr_<sha256(userId + pepper)>` | No — pepper at `contents/.usage-pepper` |
| `pseudonymous` (default) | Session id, rotates per browser session | No |
| `identified` | Real user id | Yes |

Daily and monthly rollups are aggregated counters (no `uid`, just counts) at
`contents/data/usage-daily/YYYY-MM-DD.json` and
`contents/data/usage-monthly/YYYY-MM.json`.

### 4. Audit log

Mutating admin actions (auth, OAuth, user/app/model/group CRUD) are recorded
to `contents/data/audit-log/YYYY-MM-DD.jsonl` (`server/services/AuditLogService.js`):

```json
{
  "id": "…",
  "ts": "2026-06-18T10:14:22.123Z",
  "actor": { "id": "alice", "username": "alice", "groups": ["admin"], "authenticated": true },
  "action": "update",
  "resource": "app",
  "resourceId": "translator",
  "summary": "PUT /api/admin/apps/translator -> 200",
  "result": "success",
  "source": "admin",
  "requestId": "…",
  "ip": "203.0.113.42"
}
```

Inference, chat, sessions, magic-prompts, short-links, feedback, translations
and page reads are explicitly **excluded** from the audit log
(`server/middleware/auditLogger.js`). Email-shaped actor identifiers are
masked by default (`audit.includeEmail: false`).

### 5. Structured logs

Winston writes structured JSON to **stdout** always. A per-request
`AsyncLocalStorage` scope automatically merges `userId`, `oauthClientId`, and
`ip` into every log line so logs are attributable without each call site
having to pass them through. Passwords, tokens and URL query params containing
keys are auto-redacted by `server/utils/logger.js`.

File logging is **off by default**. When enabled, logs rotate at 10 MB × 5
files at `logs/app.log`.

### 6. OpenTelemetry

Telemetry is **disabled by default**. When enabled, only structural metadata
(model name, token counts, durations) is emitted. Prompt and completion text
sit behind two opt-in flags: `telemetry.events.includePrompts` and
`telemetry.events.includeCompletions`, both default `false`.

## Privacy controls

All of the following live in `contents/config/platform.json` (or the admin UI
at **Admin → Platform → Configuration**). The first three are new in 5.4.0.

### `audit.anonymizeIp` (new)

Controls how the client IP is stored on audit log entries.

| Value | Behaviour |
| --- | --- |
| `false` (default) | IP is stored verbatim (e.g. `203.0.113.42`) |
| `true` or `"mask"` | IP is masked: last octet for IPv4 (`203.0.113.0`), last 80 bits for IPv6 (`2001:db8:abcd::`) |
| `"drop"` | The `ip` property is omitted from the audit entry entirely |

### `logging.anonymizeIp` (new)

Same shape as `audit.anonymizeIp`, but applies to the IP merged into every
structured log line from the per-request context.

| Value | Behaviour |
| --- | --- |
| `false` (default) | IP merged verbatim |
| `true` or `"mask"` | IP masked (see above) |
| `"drop"` | `ip` field omitted entirely |

### `usageTracking.feedbackRetentionDays` (new)

Drop entries from `feedback.jsonl` older than this many days. Default is `-1`
(keep forever, matching pre-5.4.0 behaviour). Cleanup runs on the same hourly
schedule as the usage rollup job, so the next sweep after a retention change
honours it immediately.

| Value | Behaviour |
| --- | --- |
| `-1` (default) | Never delete feedback |
| `0` | Disable cleanup (treated as `-1` for safety) |
| Any positive integer | Drop feedback entries older than N days |

### Existing controls (recap)

| Setting | Default | Effect |
| --- | --- | --- |
| `features.usageTracking` | `true` | Disables all writes to `usage.json` and `usage-events.jsonl` when `false` |
| `features.usageTrackingMode` | `pseudonymous` | `anonymous` SHA-256-hashes the userId with a server-side pepper |
| `features.feedbackTracking` | `true` | Disables `feedback.jsonl` writes when `false` |
| `telemetry.enabled` | `false` | OpenTelemetry master switch |
| `telemetry.events.includePrompts` | `false` | Send prompt text to OTel |
| `telemetry.events.includeCompletions` | `false` | Send response text to OTel |
| `audit.includeEmail` | `false` | Mask email-shaped identifiers (`bob@example.com` → `bob`) |
| `audit.retentionDays` | `365` | Delete audit log files older than N days |
| `audit.cleanupEnabled` | `true` | Master switch for audit cleanup |
| `audit.verbosity` | `metadata` | `request`/`full` would append redacted request bodies |
| `usageTracking.eventRetentionDays` | `90` | Delete usage events older than N days |
| `usageTracking.dailyRetentionDays` | `365` | Delete daily rollups older than N days *(now wired in 5.4.0)* |
| `usageTracking.monthlyRetentionDays` | `-1` | Delete monthly rollups older than N days |
| `logging.level` | `info` | `warn` suppresses the `logInteraction()` full-prompt info logs |
| `logging.file.enabled` | `false` | Keep logs ephemeral on stdout |
| `auth.sessionTimeoutMinutes` | `480` | JWT lifetime (= cookie lifetime) |
| `anonymousAuth.enabled` | `true` | Anonymous users avoid the user-fingerprint code path |

## Recommended privacy-first configuration

The configuration below is suitable for deployments operating under strict
GDPR-style requirements. It keeps operational observability intact while
minimising durable PII to: the local user store, anonymized audit metadata,
and anonymized usage counters.

```jsonc
{
  "features": {
    "usageTracking": true,
    "usageTrackingMode": "anonymous",
    "feedbackTracking": false
  },
  "telemetry": { "enabled": false },
  "logging": {
    "level": "warn",
    "format": "json",
    "file": { "enabled": false },
    "anonymizeIp": "mask"
  },
  "audit": {
    "retentionDays": 90,
    "cleanupEnabled": true,
    "includeEmail": false,
    "verbosity": "metadata",
    "anonymizeIp": "mask"
  },
  "usageTracking": {
    "eventRetentionDays": 30,
    "dailyRetentionDays": 90,
    "monthlyRetentionDays": 365,
    "feedbackRetentionDays": 90
  },
  "auth": { "sessionTimeoutMinutes": 60 }
}
```

With this configuration:

- Chat content is never written to disk (stdout `logger.info` calls below the
  `warn` threshold are skipped, feedback writes are disabled).
- IPs in audit entries and log lines are masked to /24 (IPv4) or /48 (IPv6).
- Audit entries roll off after 90 days.
- Usage events are anonymized at write time and roll off after 30 days; rollups
  retain at most one year of monthly counters.
- Sessions expire after 1 hour.

## Disabling capture entirely

If you cannot accept any durable identity-linked record:

1. Set `features.usageTracking: false`, `features.feedbackTracking: false`,
   `telemetry.enabled: false`, and `logging.file.enabled: false`.
2. Set `logging.anonymizeIp: "drop"` and `audit.anonymizeIp: "drop"`.
3. Use `auth.mode: "anonymous"` for fully-anonymous deployments, or short
   `sessionTimeoutMinutes` for authenticated ones.
4. Point iHub at a **local LLM provider** (LM Studio, vLLM, Jan.ai) so no
   prompts leave the host.
5. Set `audit.retentionDays` to the shortest period your compliance regime
   allows.

The audit log itself cannot be disabled — `mutating admin actions are always
recorded` by design — but the IP and email columns can both be anonymized.

## Data subject rights (GDPR Art. 15-22)

| Right | How to fulfil |
| --- | --- |
| **Access** (Art. 15) | Admin → Usage → Feedback (CSV export); audit log via Admin → Platform → Audit Log; user record at `contents/config/users.json` |
| **Rectification** (Art. 16) | Edit the user via Admin → Users; OIDC/LDAP/NTLM users are read-only mirrors of the IdP |
| **Erasure** (Art. 17) | Delete the user via Admin → Users; rewrite `feedback.jsonl` with `cleanupFeedback()` or shorten `feedbackRetentionDays`; audit entries are kept for the configured `retentionDays` and cannot be deleted before expiry (regulatory requirement) |
| **Portability** (Art. 20) | Export usage CSV (`GET /api/admin/usage/export`); user data lives in plain JSON files for direct extraction |
| **Restrict / object** (Art. 18, 21) | Disable the user (`active: false` in `users.json`); set `usageTrackingMode: "anonymous"` |

## Third-party data flow

| Destination | When | What is sent |
| --- | --- | --- |
| Configured LLM provider | Every chat | Prompt, message history (when `sendChatHistory: true`), provider-specific request parameters |
| OpenTelemetry collector | Only when `telemetry.enabled: true` | Spans, metrics, and (only when explicitly opted in) prompt/completion events |
| External iFinder / iAssistant | Only when configured | Full conversation, feedback echo |
| Cloud storage providers (Jira, OIDC, Office 365, etc.) | Only when admin configures them | Per-integration; tokens encrypted at rest |
| Analytics SDKs (Segment, Mixpanel, GA, Sentry, …) | **Never** | — |

For zero-egress deployments, use a local LLM provider — see
`docs/local-llm-providers.md`.

## Key files for code review

| File | Purpose |
| --- | --- |
| `server/utils/userManager.js` | Canonical user record |
| `server/utils/tokenService.js` | JWT payload + lifetime |
| `server/usageTracker.js` | Usage counters + tracking modes |
| `server/services/UsageEventLog.js` | Per-request event JSONL |
| `server/services/UsageAggregator.js` | Daily/monthly rollups + cleanup |
| `server/feedbackStorage.js` | Feedback JSONL writes + cleanup |
| `server/services/AuditLogService.js` | Audit log entries + retention |
| `server/utils/logger.js` | Structured logging + request-context merge |
| `server/utils/ipAnonymizer.js` | Shared IP masking helper |
| `server/telemetry.js`, `server/telemetry/events.js` | OpenTelemetry emitters |
| `server/defaults/config/platform.json` | Default platform config (privacy switches) |
| `server/validators/platformConfigSchema.js` | Zod schema for the platform config |
| `server/migrations/V060__add_privacy_options.js` | Migration adding the new privacy toggles |
