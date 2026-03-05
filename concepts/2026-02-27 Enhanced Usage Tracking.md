# Enhanced Usage Tracking — Analysis & Implementation Plan

## 1. Current State Analysis

### What Exists Today

The system has a **working but limited** usage tracking system in `server/usageTracker.js`:

- **Cumulative counters only** — totals for messages, tokens, feedback, magic prompts
- **Three dimensions**: perUser, perApp, perModel
- **No time-series data** — impossible to see trends, daily/weekly/monthly breakdowns
- **Token counting is mostly fake** — streaming responses (the vast majority) use a word-count estimation (`text.split(/\s+/).length`), not actual provider token counts
- **User identity is session-based** — `session-{timestamp}-{random}` IDs, already pseudonymous
- **Storage**: Single JSON file (`contents/data/usage.json`), buffered writes every 10 seconds
- **Admin UI**: Six-tab dashboard (`AdminUsageReports.jsx`) with overview, users, apps, magic prompts, feedback, and details tabs

### The Token Accuracy Problem

This is the biggest gap. Here's the reality:

| Provider | Streaming (95%+ of traffic) | Non-Streaming |
|----------|---------------------------|---------------|
| **OpenAI/GPT** | ❌ Word-count estimate | ✅ Real tokens from `response.usage` |
| **Anthropic/Claude** | ❌ Word-count estimate — **but real data IS in the stream and gets thrown away** | ✅ Real tokens |
| **Google/Gemini** | ❌ Word-count estimate | ❌ Not consistently available |
| **Mistral** | ❌ Word-count estimate | ✅ Real tokens (OpenAI-compatible) |
| **vLLM** | ❌ Word-count estimate | ✅ Real tokens (OpenAI-compatible) |

**Specific findings:**

1. **OpenAI supports `stream_options: { include_usage: true }`** — this makes streaming responses include a final chunk with real token counts. Not used anywhere in the codebase.
2. **Anthropic's `message_delta` events contain `usage: { input_tokens, output_tokens }`** — the adapter (`anthropic.js` line 254) parses `stop_reason` from this event but completely ignores the sibling `usage` object.
3. **Google Gemini** returns `usageMetadata` in responses but the adapter doesn't extract it.

### What's Missing for Serious Usage Tracking

1. **Accurate token counts** from providers instead of word-count guesses
2. **Time-series storage** — daily/hourly buckets for trend analysis
3. **Conversation-level tracking** — tokens per conversation, not just global totals
4. **Anonymous mode with fingerprinting** — privacy-preserving user identification
5. **Over-time visualizations** — charts showing usage trends
6. **Cost estimation** — mapping token counts to approximate costs per model

---

## 2. Privacy-First User Identity: Anonymous Fingerprinting

### Requirement

> The user should be fingerprinted, but it should not be possible for an admin to say who it was.

### Design: One-Way Hashed Identity

The idea is to create a **deterministic but irreversible** user identifier:

```
fingerprint = SHA-256(userId + pepper)
```

- **`userId`**: The real identity (email, username, session ID) — never stored in usage data
- **`pepper`**: A server-side secret stored in platform.json (or derived from the encryption key already used by `TokenStorageService`)

**Properties:**
- Same user → same permanent fingerprint (allows full historical aggregation and trend analysis)
- Admin sees `usr_a7f3b2...` — cannot reverse to real identity
- No lookup table is stored — the mapping is purely computational and one-way
- No rotation — the fingerprint is stable forever, enabling long-term per-user tracking without ever revealing identity

### Configuration

```json
{
  "features": {
    "usageTracking": true,
    "usageTrackingMode": "anonymous"  // "anonymous" | "pseudonymous" | "identified"
  }
}
```

**Three modes:**
- **`anonymous`**: One-way hashed fingerprints. No way to identify users. Default.
- **`pseudonymous`**: Current behavior — session IDs. Correlatable with effort but not directly identifying.
- **`identified`**: Real usernames/emails stored. For organizations that need accountability.

---

## 3. Accurate Token Capture from Providers

### 3.1 OpenAI Adapter — Enable `stream_options`

**File:** `server/adapters/openai.js`, `createCompletionRequest()`

Add `stream_options: { include_usage: true }` to the request body when streaming. Then in `processResponseBuffer()`, extract the `usage` field from the final chunk.

The final streaming chunk from OpenAI with this option looks like:
```json
{"id":"...","choices":[],"usage":{"prompt_tokens":42,"completion_tokens":128,"total_tokens":170}}
```

**Impact:** All OpenAI-compatible providers (OpenAI, Mistral, vLLM, LM Studio) get real token counts for streaming.

### 3.2 Anthropic Adapter — Extract Usage from `message_delta`

**File:** `server/adapters/anthropic.js`, `processResponseBuffer()`

The `message_delta` event already arrives with:
```json
{
  "type": "message_delta",
  "delta": { "stop_reason": "end_turn" },
  "usage": { "input_tokens": 1234, "output_tokens": 567 }
}
```

Line 254 already checks for `message_delta` but only reads `delta.stop_reason`. Add extraction of `parsed.usage`.

Also extract from `message_start` events which contain initial input token counts.

### 3.3 Google Adapter — Extract `usageMetadata`

**File:** `server/adapters/google.js`

Gemini responses include:
```json
{
  "usageMetadata": {
    "promptTokenCount": 100,
    "candidatesTokenCount": 50,
    "totalTokenCount": 150
  }
}
```

Extract this in the response processing.

### 3.4 Adapter Return Contract

Standardize what adapters return so `StreamingHandler` can use real data:

```javascript
// Current adapter return:
{ content, tool_calls, complete, finishReason }

// Enhanced adapter return:
{ content, tool_calls, complete, finishReason, usage: { promptTokens, completionTokens } | null }
```

When `usage` is non-null, `StreamingHandler` uses it instead of `estimateTokens()`.

### 3.5 StreamingHandler Changes

**File:** `server/services/chat/StreamingHandler.js`

- Accumulate `usage` data from adapter responses across chunks
- On stream completion, if real usage data is available, use it for `recordChatResponse()`
- Fall back to `estimateTokens()` only when provider doesn't supply data
- Add a `tokenSource` field to tracking: `"provider"` vs `"estimated"` so admins know data quality

---

## 4. Time-Series Storage

### Design: Daily Buckets in JSONL

Instead of modifying usage.json (which stays as the cumulative summary), add a new **append-only log**:

**File:** `contents/data/usage-events.jsonl`

```jsonl
{"ts":"2026-02-27T14:30:00Z","type":"chat","uid":"usr_a7f3b2","app":"chat","model":"gpt-4.1","pt":1200,"ct":350,"src":"provider"}
{"ts":"2026-02-27T14:30:05Z","type":"chat","uid":"usr_a7f3b2","app":"deep-researcher","model":"claude-sonnet-4-5-20250514","pt":800,"ct":1200,"src":"provider"}
{"ts":"2026-02-27T14:31:00Z","type":"magic","uid":"usr_c9d1e4","app":"chat","model":"gpt-4.1","pt":200,"ct":150,"src":"estimated"}
```

**Fields:**
- `ts`: ISO timestamp
- `type`: `"chat"` | `"magic"` | `"feedback"`
- `uid`: Anonymized user fingerprint
- `app`: App ID
- `model`: Model ID
- `pt`: Prompt tokens
- `ct`: Completion tokens
- `src`: `"provider"` | `"estimated"` (data quality indicator)
- `cid`: Conversation/chat ID (hashed in anonymous mode)

**Why JSONL:**
- Append-only, no corruption risk from concurrent writes
- Easy to process line-by-line for aggregation
- Can be rotated/archived (daily, monthly files)
- Compatible with the existing `feedbackStorage.js` pattern

### Aggregation Service

A new `UsageAggregator` service that:
1. Reads the JSONL events
2. Builds aggregations: daily, weekly, monthly rollups
3. Caches aggregated results in memory
4. Provides query API: "tokens by user for last 30 days", "daily trend for app X"

**Storage structure** for pre-computed rollups:

```
contents/data/usage-daily/2026-02-27.json    // daily summaries
contents/data/usage-monthly/2026-02.json     // monthly summaries
```

### Retention Policy

Configurable in platform.json:
```json
{
  "usageTracking": {
    "eventRetentionDays": 90,
    "dailyRetentionDays": 365,
    "monthlyRetentionDays": -1
  }
}
```

---

## 5. Enhanced Data Model

### Per-Event Record (JSONL)

One event per conversation turn (request+response pair), not per individual message:

```javascript
{
  timestamp: "2026-02-27T14:30:00.000Z",
  type: "chat" | "magic_prompt" | "feedback",
  userId: "usr_a7f3b2c8d9",        // fingerprinted (permanent, no rotation)
  conversationId: "conv_x8k2m...", // hashed chat ID
  appId: "deep-researcher",
  modelId: "gpt-4.1",
  promptTokens: 1200,
  completionTokens: 350,
  messageCount: 1,                  // messages in this turn (usually 1, more for tool-call loops)
  tokenSource: "provider",          // or "estimated"
  // For feedback events:
  rating: 4,
  // Metadata:
  hasImages: false,
  hasTools: true,
  responseTimeMs: 2340
}
```

### Daily Rollup

```javascript
{
  date: "2026-02-27",
  totals: {
    messages: 142,
    promptTokens: 580000,
    completionTokens: 120000,
    conversations: 34,
    uniqueUsers: 12,
    averageResponseTimeMs: 1850
  },
  byUser: {
    "usr_a7f3b2": { messages: 25, promptTokens: 95000, completionTokens: 28000 },
    ...
  },
  byApp: { ... },
  byModel: { ... },
  tokenQuality: {
    providerCount: 120,     // events with real token data
    estimatedCount: 22      // events with estimated tokens
  }
}
```

---

## 6. Admin API Enhancements

### New Endpoints

```
GET /api/admin/usage                    — current cumulative (backward compatible)
GET /api/admin/usage/timeline?range=30d — daily aggregations for the last N days
GET /api/admin/usage/timeline?range=12m — monthly aggregations for the last N months
GET /api/admin/usage/users?range=30d    — per-user breakdown over time
GET /api/admin/usage/apps?range=30d     — per-app breakdown over time
GET /api/admin/usage/models?range=30d   — per-model breakdown over time
GET /api/admin/usage/conversations?range=7d — conversation-level detail
GET /api/admin/usage/export?format=csv&range=90d — export
```

### Query Parameters

- `range`: `7d`, `30d`, `90d`, `12m`, `all`
- `granularity`: `hourly`, `daily`, `weekly`, `monthly` (auto-selected if omitted)
- `userId`: Filter by fingerprint
- `appId`: Filter by app
- `modelId`: Filter by model
- `format`: `json` (default), `csv`

---

## 7. Admin UI Enhancements

### New: Timeline Tab

- Line chart: total tokens over time (prompt vs completion stacked)
- Toggle: daily / weekly / monthly granularity
- Filter by app, model, user
- Hover for exact numbers

### Enhanced: Users Tab

- Usage timeline per user (sparkline charts)
- Token consumption ranking with trend arrows
- Conversation count per user + message count per conversation
- Privacy indicator showing the tracking mode (anonymous/pseudonymous/identified)

### Enhanced: Overview Tab

- "Last 30 days" trend line
- "Today vs yesterday" comparison
- Token quality indicator (% from provider vs estimated)
- Active users over time chart

---

## 8. Implementation Phases

### Phase 1: Accurate Token Capture (Foundation)

**Goal:** Get real token counts from providers instead of word-count guesses.

1. Extend adapter return contract to include `usage` field
2. **OpenAI adapter**: Add `stream_options: { include_usage: true }`, extract usage from final chunk
3. **Anthropic adapter**: Extract `usage` from `message_delta` and `message_start` events
4. **Google adapter**: Extract `usageMetadata` from responses
5. **Mistral/vLLM adapters**: Same as OpenAI (they're OpenAI-compatible)
6. **StreamingHandler**: Use real usage data when available, fall back to estimation
7. Add `tokenSource` field to tracking calls
8. **Update `estimateTokens()`**: improve the fallback with a better heuristic (chars/4 is closer to reality than word count)

**Risk:** Minimal — adapters already receive this data, we're just extracting it.

### Phase 2: Anonymous Fingerprinting

**Goal:** Privacy-preserving user identification with permanent (non-rotating) fingerprints.

1. Create `server/services/UserFingerprint.js` — SHA-256 one-way hashing with pepper, no time-based salt rotation
2. Add `usageTrackingMode` config to platform.json (+ migration)
3. Integrate fingerprinting into `recordChatRequest`/`recordChatResponse`
4. Update admin UI to show tracking mode indicator
5. Add fingerprint mode toggle to admin settings panel

**Risk:** Low — purely additive. Existing session-ID mode remains default during rollout.

### Phase 3: Time-Series Event Storage

**Goal:** Enable over-time analysis.

1. Create `server/services/UsageEventLog.js` — JSONL append-only writer (following `feedbackStorage.js` pattern)
2. Wire into `recordChatRequest`/`recordChatResponse` to emit events
3. Create `server/services/UsageAggregator.js` — daily/monthly rollup generation
4. Add scheduled rollup task (runs on server start + daily interval)
5. Add retention/cleanup for old event data
6. New API endpoints for timeline queries

**Risk:** Medium — file I/O at scale. Mitigated by buffered writes (same 10s pattern as existing tracker) and daily rollup pre-computation.

### Phase 4: Enhanced Admin Dashboard

**Goal:** Visualize everything.

1. Timeline tab with recharts line/area charts
2. Enhanced user/app/model tabs with trend data and conversation counts + message counts
3. Export enhancements (date-range filtered CSV/JSON)
4. Data quality indicators (provider vs estimated percentages)
5. Privacy mode indicator

**Risk:** Low — purely frontend, no backend changes beyond Phase 3 APIs.

---

## 9. Migration Strategy

### Config Migration

New migration `V{next}__enhanced_usage_tracking.js`:

```javascript
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'features.usageTrackingMode', 'anonymous');
  ctx.setDefault(platform, 'usageTracking', {
    eventRetentionDays: 90,
    dailyRetentionDays: 365,
    monthlyRetentionDays: -1
  });
  await ctx.writeJson('config/platform.json', platform);
}
```

### Data Migration

- Existing `usage.json` remains untouched (cumulative counters continue working)
- New JSONL event log starts fresh from deployment date
- No historical backfill needed — time-series starts when the feature ships
- Mark all pre-enhancement token data as `tokenSource: "estimated"` retroactively

---

## 10. Files to Create or Modify

### New Files
| File | Purpose |
|------|---------|
| `server/services/UserFingerprint.js` | One-way user identity hashing |
| `server/services/UsageEventLog.js` | JSONL event writer |
| `server/services/UsageAggregator.js` | Daily/monthly rollup computation |
| `server/routes/admin/usage.js` | Enhanced usage API endpoints |
| `server/migrations/V{next}__enhanced_usage_tracking.js` | Config migration |
| `client/src/features/admin/components/UsageTimeline.jsx` | Timeline chart component |

### Modified Files
| File | Change |
|------|--------|
| `server/adapters/openai.js` | Add `stream_options`, extract usage from final chunk |
| `server/adapters/anthropic.js` | Extract usage from `message_delta`/`message_start` |
| `server/adapters/google.js` | Extract `usageMetadata` |
| `server/adapters/mistral.js` | Same as OpenAI |
| `server/adapters/vllm.js` | Same as OpenAI |
| `server/adapters/BaseAdapter.js` | Standardize usage return field |
| `server/services/chat/StreamingHandler.js` | Use real tokens when available |
| `server/services/chat/NonStreamingHandler.js` | Add tokenSource, emit events |
| `server/usageTracker.js` | Add fingerprinting, event emission, tokenSource |
| `server/routes/admin/cache.js` | Wire new usage endpoints |
| `client/src/features/admin/pages/AdminUsageReports.jsx` | Add timeline tab, enhance existing tabs |
| `contents/config/platform.json` | New tracking config fields |

---

## 11. Decisions Made

- **Cost estimation**: Skipped for now. Focus on accurate token tracking first. Can be added as a future phase.
- **Fingerprint rotation**: No rotation. Permanent fingerprints (pepper-only) for full historical tracking per anonymous user.
- **Conversation granularity**: Per-conversation totals + message count. Good balance between insight and storage.

## 12. Remaining Open Questions

1. **Real-time vs batch aggregation**: Should daily rollups be computed on-the-fly from JSONL, or pre-computed on a schedule? Pre-computed is faster for reads but adds a background process. Recommendation: pre-computed on a schedule (daily cron-like task at midnight + on server start).

2. **OpenAI Responses API** (`openai-responses.js`): This newer adapter uses a different endpoint format. Needs separate investigation for token extraction — should this be included in Phase 1?
