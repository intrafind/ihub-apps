# Product Requirements Document (PRD): iHub Workflows

**Date:** 2026-02-27
**Status:** Draft — Gap Analysis & Feature Specification
**Reference:** Langdock Workflows PRD (Feb 2026)

---

## 1. Executive Summary

iHub Apps already has a production-grade workflow engine (`server/services/workflow/`) with DAG-based execution, 7 active node types, human-in-the-loop checkpoints, real-time SSE streaming, and a configuration-driven JSON schema. This PRD identifies the gaps between iHub's current workflow system and the capabilities described in the Langdock Workflows PRD, then specifies the features needed to reach parity and beyond.

The core thesis: iHub's foundation is strong — the execution engine, state management, variable system, and permission model are all in place. What's missing is primarily the **trigger layer** (schedules, webhooks, forms, integration events), the **visual builder UI**, **version control** (draft/published), **cost monitoring**, and a handful of additional node types (Loop, HTTP Request, Code, Guardrails, Delay, Notification, Image Generation).

---

## 2. Current State Analysis

### 2.1 What iHub Already Has (Production-Ready)

| Capability | iHub Implementation | Langdock Equivalent |
|---|---|---|
| **Workflow Engine** | `WorkflowEngine.js` — full DAG execution with topological sort | Core engine |
| **State Management** | `StateManager.js` — file-based persistence with checkpoints | Execution state |
| **Agent Node** | `AgentNodeExecutor.js` — LLM calls with tool access, structured output, model override | Agent Node |
| **Decision Node** | `DecisionNodeExecutor.js` — expression, equals, contains, exists, LLM-based conditions | Condition Node |
| **Human-in-the-Loop** | `HumanNodeExecutor.js` — pause/resume, form inputs, approval buttons | HITL |
| **Transform Node** | `TransformNodeExecutor.js` — data manipulation, field mapping | (No direct equivalent — Langdock uses Code Node) |
| **Tool Node** | `ToolNodeExecutor.js` — direct tool invocation without LLM | Action Node (partial) |
| **Variable System** | JSONPath (`$.data.field`, `$.nodeOutputs.nodeId.field`) + Handlebars templates | `{{node.output.field}}` syntax |
| **Execution Streaming** | SSE for real-time progress events | Real-time execution |
| **Permissions** | Group-based `allowedGroups` per workflow | Editor access |
| **Execution Registry** | Tracks all executions per user with status filtering | Runs tab |
| **Start/End Nodes** | Input variable collection (text, number, date, select, file, image) | Manual Trigger + Form Trigger (partial) |
| **Multi-language** | All node configs support localized strings (en/de) | Not mentioned in Langdock |
| **Error Handling** | Configurable per-workflow: fail, retry, llm_recovery | Fail/Continue/Error callback |
| **Tools Ecosystem** | 15+ built-in tools: web search, document search, people search, screenshots | Integrations |
| **LLM Adapters** | OpenAI, Anthropic, Google, Mistral — all with streaming | Multi-model support |
| **Cycle Support** | `allowCycles` flag + `maxIterations` safety | Loop Node (different approach) |

### 2.2 What iHub Has Defined But Not Implemented

| Feature | Schema Status | Notes |
|---|---|---|
| Parallel/Join Nodes | Defined in `nodeTypeEnum` | No executor, no scheduler support |
| Memory Node | Defined in `nodeTypeEnum` | No executor |

### 2.3 Gap Summary (What's Missing)

| Gap | Priority | Langdock Equivalent | Complexity |
|---|---|---|---|
| **Visual Workflow Builder** | P0 | Canvas + AI chat builder | High |
| **Trigger System** | P0 | Manual, Form, Schedule, Webhook, Integration triggers | High |
| **Version Control** | P1 | Draft (v0) + Published versions | Medium |
| **Loop Node** | P1 | Loop Node with concurrency | Medium |
| **HTTP Request Node** | P1 | HTTP Request Node with cURL import | Low |
| **Code Node** | P1 | JavaScript sandbox | Medium |
| **Cost Monitoring** | P1 | Per-node badges, workspace caps | Medium |
| **Notification Node** | P2 | In-app + external notifications | Low |
| **Delay Node** | P2 | 1s–24h pause | Low |
| **Guardrails Node** | P2 | PII, moderation, jailbreak detection | Medium |
| **Image Generation Node** | P3 | Text-to-image | Low |
| **Web Search Node** | P2 | Standalone search results | Low (tool exists) |
| **File Search Node** | P2 | RAG knowledge folder search | Low (tool exists) |
| **Parallel Execution** | P2 | Independent branches run concurrently | Medium |
| **Sub-Workflows** | P3 | Nested workflows | High |
| **Field Modes (Manual/Auto/AI)** | P2 | Three input modes per field | Medium |
| **Workflow Templates** | P3 | Marketplace/gallery | Low |

---

## 3. Feature Specifications

### 3.1 Trigger System (P0)

The trigger system is the single largest gap. Currently workflows can only be started via `POST /api/workflows/:id/execute`. We need five trigger types.

#### 3.1.1 Manual Trigger

**Status:** Partially exists — the Start Node + UI button already enables manual execution.

**Enhancements needed:**
- Zero-configuration mode (no input variables required)
- "Test Run" mode that doesn't count toward usage limits
- Distinguish between test runs and production runs in the execution registry

#### 3.1.2 Form Trigger

**What exists:** The Start Node already supports input variables with types (text, textarea, number, date, boolean, select, file, image). The `StartWorkflowModal.jsx` collects these inputs.

**What's needed:**
- Public form URL generation (`/api/workflows/:id/form`) that renders a standalone form page without requiring authentication
- Form customization: title, description, thank-you message, color theme
- Form embedding via iframe
- File upload support in public forms
- Rate limiting on public form submissions
- CAPTCHA or similar bot protection for public forms
- Form field validation rules (min/max length, regex patterns)

**Implementation approach:**
- New route: `GET /api/workflows/:id/form` — serves the form HTML
- New route: `POST /api/workflows/:id/form/submit` — processes submissions
- Add `trigger` config section to workflow schema:
  ```json
  {
    "trigger": {
      "type": "form",
      "config": {
        "publicAccess": true,
        "title": { "en": "Submit Request" },
        "description": { "en": "Fill out this form..." },
        "thankYouMessage": { "en": "Thank you!" },
        "theme": { "primaryColor": "#4F46E5" },
        "rateLimit": { "maxPerHour": 100 }
      }
    }
  }
  ```

#### 3.1.3 Scheduled Trigger

**What's needed:**
- Cron-based scheduler running within the Node.js process (or as a sidecar)
- Visual schedule builder in the admin UI (with quick presets: every N minutes, hourly, daily, weekly, monthly)
- Timezone support
- Schedule enable/disable without deleting the workflow
- Execution history showing scheduled vs manual runs
- Missed-run detection and configurable catch-up policy

**Implementation approach:**
- Use `node-cron` or `croner` library for in-process scheduling
- New service: `server/services/workflow/SchedulerService.js`
- Scheduler reads workflow configs on startup, registers cron jobs
- Reloads on config changes (watch `contents/workflows/` directory)
- Trigger config:
  ```json
  {
    "trigger": {
      "type": "schedule",
      "config": {
        "cron": "0 9 * * 1-5",
        "timezone": "Europe/Berlin",
        "enabled": true,
        "catchUpMissedRuns": false
      }
    }
  }
  ```

#### 3.1.4 Webhook Trigger

**What's needed:**
- Unique webhook URL per workflow: `POST /api/workflows/:id/webhook`
- Optional secret-based authentication (query param or header)
- Asynchronous processing: respond with 202 Accepted immediately
- Optional synchronous mode: wait for workflow completion and return result
- JSON payload validation against an optional schema
- File upload support via multipart/form-data
- Rate limiting per webhook
- Webhook URL regeneration (invalidates old URL)

**Implementation approach:**
- New route: `POST /api/webhooks/:webhookId` (using a generated UUID, not the workflow ID directly, for security)
- Webhook config stored in workflow definition:
  ```json
  {
    "trigger": {
      "type": "webhook",
      "config": {
        "webhookId": "uuid-generated-on-creation",
        "secret": "optional-secret",
        "responseMode": "async",
        "payloadSchema": {},
        "rateLimit": { "maxPerMinute": 60 }
      }
    }
  }
  ```

#### 3.1.5 Integration Trigger

**What's needed:**
- Event listeners for connected integrations (Jira issue created, email received, etc.)
- Polling-based triggers for integrations without webhook support
- Event filtering (specific project, label, sender, etc.)
- Deduplication to prevent processing the same event twice

**Implementation approach (phased):**
- Phase 1: Polling-based triggers for existing integrations (Jira, Office365)
- Phase 2: Native webhook receivers for integrations that support them
- Trigger config:
  ```json
  {
    "trigger": {
      "type": "integration",
      "config": {
        "integration": "jira",
        "event": "issue_created",
        "filters": {
          "project": "PROJ",
          "issueType": "Bug"
        },
        "pollingInterval": 60
      }
    }
  }
  ```

#### 3.1.6 Multiple Triggers

Langdock supports only one trigger per workflow. We should consider supporting multiple triggers from the start, since workflows often need to respond to several event sources.

---

### 3.2 Visual Workflow Builder (P0)

The most significant UI gap. Currently workflows are JSON-only, editable only through the admin API.

#### Requirements

**Canvas Editor:**
- Node-based visual editor using a library like React Flow (reactflow.dev) or similar
- Drag-and-drop node placement from a palette
- Visual edge connections between nodes with conditional labels
- Node configuration panel (sidebar) on selection
- Zoom, pan, minimap, auto-layout
- Undo/redo
- Node grouping and annotations

**AI Workflow Builder (Chat Interface):**
- Natural language → workflow generation (like Langdock's conversational builder)
- "Describe your automation" → generates complete workflow JSON
- Iterative refinement via follow-up messages
- "Fix in chat" button when execution errors occur
- Context-aware: knows available tools, integrations, and models

**Implementation approach:**
- New page: `/workflows/builder/:id`
- Client component: `client/src/features/workflows/builder/WorkflowCanvas.jsx`
- Use React Flow for the canvas (MIT licensed, widely adopted)
- Node palette component with all available node types
- Property panel component that renders type-specific forms
- Backend: extend `PUT /api/workflows/:id` to accept canvas layout data (node positions already supported via `position` field in schema)

**Note on iHub's advantage:** The workflow schema already includes `position: { x, y }` for each node, indicating visual builder support was anticipated from the start.

---

### 3.3 Version Control (P1)

#### Requirements

- **Draft version (v0):** The working copy. All edits happen here. Test runs execute against draft.
- **Published versions (v1.0.0+):** Immutable snapshots. Only published versions respond to triggers.
- **Publishing flow:** User clicks "Publish" → enters change description → selects version bump type (patch/minor/major) → creates immutable snapshot.
- **Rollback:** Activate any previous published version as the current production version.
- **Version history:** List all published versions with timestamps, authors, and change descriptions.

**Implementation approach:**
- Store versions in `contents/workflows/{id}/` directory instead of a single file:
  ```
  contents/workflows/research-assistant/
    draft.json          # v0 — always the working copy
    v1.0.0.json         # First published version
    v1.1.0.json         # Feature addition
    v2.0.0.json         # Breaking change
    versions.json       # Version metadata (active version, history)
  ```
- `versions.json` schema:
  ```json
  {
    "activeVersion": "1.1.0",
    "versions": [
      {
        "version": "1.1.0",
        "publishedAt": "2026-02-27T10:00:00Z",
        "publishedBy": "admin",
        "description": "Added email notification step",
        "bumpType": "minor"
      }
    ]
  }
  ```
- API changes:
  - `GET /api/workflows/:id` returns the active published version (or draft if none published)
  - `GET /api/workflows/:id/draft` returns the draft
  - `POST /api/workflows/:id/publish` creates a new published version
  - `PUT /api/workflows/:id/activate/:version` switches the active version
  - Triggers always execute against the active published version
  - Test runs always execute against the draft

---

### 3.4 New Node Types

#### 3.4.1 Loop Node (P1)

**What exists:** Cycle support via `allowCycles` + `maxIterations`, and Handlebars `{{#each}}` for template iteration.

**What's needed:** A dedicated Loop Node that iterates over an array, executing child nodes for each item.

**Specification:**
- Input: array reference (variable path)
- Config: `maxIterations` (default 200, max 2000), optional concurrency, optional `collectOutputs`
- Inside the loop body, `$.loop.currentItem` and `$.loop.index` are available
- Output: collected array of all iteration results (when `collectOutputs` enabled)

**Implementation:**
- New executor: `server/services/workflow/executors/LoopNodeExecutor.js`
- Loop body is a sub-graph (nodes within the loop defined by a `parentLoopId` field or a dedicated `loopBody` array)
- Sequential by default; parallel with configurable concurrency

#### 3.4.2 HTTP Request Node (P1)

**What exists:** The Tool Node can call external APIs through configured tools, but there's no general-purpose HTTP node.

**Specification:**
- Full HTTP method support: GET, POST, PUT, PATCH, DELETE
- Configurable URL, headers, query params, body — all supporting variable interpolation
- cURL import: paste a cURL command, auto-parse into node config
- Response access: `status`, `data`, `headers`
- Timeout configuration
- Optional retry with backoff
- Authentication helpers: Bearer token, Basic Auth, API Key (header or query)

**Implementation:**
- New executor: `server/services/workflow/executors/HttpRequestNodeExecutor.js`
- Use Node.js `fetch` (built-in) or `undici`
- Security: block requests to internal networks (SSRF protection) unless explicitly allowed by admin

#### 3.4.3 Code Node (P1)

**Specification:**
- JavaScript execution in a secure sandbox (using `vm2` or Node.js `vm` with restrictions)
- Access to all previous node outputs as variables
- Built-in utilities: HTTP requests, logging, data conversion (JSON, CSV)
- Returns structured objects for downstream consumption
- Execution timeout (default 30s)
- Memory limit per execution

**Implementation:**
- New executor: `server/services/workflow/executors/CodeNodeExecutor.js`
- Use `isolated-vm` for secure sandboxing (preferred over `vm2` for security)
- Provide a `context` object with previous node outputs and utility functions

#### 3.4.4 Guardrails Node (P2)

**Specification:**
- Content validation with configurable checks:
  - PII Detection (names, emails, SSNs, credit cards)
  - Moderation (hate speech, violence)
  - Jailbreak Detection
  - Hallucination Detection
  - Custom Evaluation (natural language criteria)
- Each check has an independent confidence threshold (0–1)
- Node fails if any check exceeds its threshold
- Two output paths: pass and fail

**Implementation:**
- New executor: `server/services/workflow/executors/GuardrailsNodeExecutor.js`
- PII detection: regex-based + LLM validation
- Moderation/Jailbreak/Hallucination: LLM-based evaluation with calibrated prompts
- Custom: user-provided criteria evaluated by LLM

#### 3.4.5 Delay Node (P2)

**Specification:**
- Pauses execution for a configurable duration (1 second to 24 hours)
- Duration supports variable interpolation
- Free (no AI credits)
- Cannot be interrupted once started

**Implementation:**
- New executor: `server/services/workflow/executors/DelayNodeExecutor.js`
- For short delays (<5 min): in-process `setTimeout`
- For long delays (>5 min): persist state, schedule wake-up via the SchedulerService

#### 3.4.6 Notification Node (P2)

**Specification:**
- Sends alerts to iHub users (in-app notification system)
- Supports markdown formatting
- Target: workflow owner, triggering user, or specified user/group
- For external notifications (email, Slack), use Action/Tool nodes with integrations

**Implementation:**
- New executor: `server/services/workflow/executors/NotificationNodeExecutor.js`
- Requires new notification infrastructure: `server/services/NotificationService.js`
- WebSocket or SSE-based in-app notification delivery
- Notification storage for offline users

#### 3.4.7 Web Search Node (P2)

**Status:** Mostly covered by existing tools (`braveSearch`, `tavilySearch`, `enhancedWebSearch`).

**Enhancement:** Create a dedicated Web Search Node that wraps the existing search tools into a cleaner node-level interface with configurable result count and structured array output.

#### 3.4.8 File Search Node (P2)

**Status:** Mostly covered by existing tools (`iFinder`, `iAssistant`).

**Enhancement:** Create a dedicated File Search Node that queries configured knowledge sources with semantic search, returning results with similarity scores, file metadata, and content snippets.

#### 3.4.9 Image Generation Node (P3)

**Specification:**
- Text-to-image generation using configured AI providers
- Configurable: aspect ratio, style presets
- Output: image URL, file path, prompt used
- PNG format, 60-second timeout

---

### 3.5 Cost Monitoring (P1)

#### Requirements

- **Per-node cost tracking:** After each execution, record token usage and estimated cost per node
- **Per-execution cost:** Sum of all node costs
- **Cost badges:** Display cost next to each node in execution view
- **Workspace-level caps:**
  - Monthly spending cap (configurable by admin)
  - Per-workflow monthly limit
  - Per-execution limit
- **Alerts:** Email/in-app notifications at 50%, 90%, and 100% of limits
- **Cost dashboard:** Admin view with aggregate statistics

**Implementation approach:**
- Extend `ActionTracker` to capture token usage from LLM responses
- New service: `server/services/workflow/CostTracker.js`
- Token-to-cost mapping per model (configurable in model configs)
- Store cost data in execution records
- New admin routes for cost management and dashboard data

---

### 3.6 Field Modes (P2)

Langdock's three-mode system (Manual, Auto, AI Prompt) for every configurable field is a strong UX pattern.

#### Specification

Every node configuration field should support:

- **Manual:** User specifies exact value with optional variable interpolation. Default mode. No AI credits.
- **AI Prompt:** User provides natural language instructions. AI generates the value at runtime. Consumes credits.
- **Auto:** AI determines value automatically from context of previous nodes. Consumes credits.

**Implementation:** Each field in the node config gains a `mode` property:
```json
{
  "query": {
    "mode": "manual",
    "value": "{{start.output.searchTerm}}"
  }
}
```
or:
```json
{
  "query": {
    "mode": "ai_prompt",
    "prompt": "Generate a search query based on the user's request that would find relevant academic papers"
  }
}
```

---

### 3.7 Parallel Execution (P2)

#### Requirements

- When multiple nodes are connected to a single source with no dependencies between them, they should execute in parallel
- The DAGScheduler already uses topological sort — extend it to identify independent nodes at each level and execute them concurrently
- Add a Join node that waits for all parallel branches to complete before continuing

**Implementation:**
- Modify `DAGScheduler.js` to return execution levels (groups of independent nodes)
- Execute nodes within the same level concurrently using `Promise.all`
- Implement the `ParallelNodeExecutor.js` and `JoinNodeExecutor.js` (schema already defined)

---

### 3.8 Execution Improvements

#### 3.8.1 Re-run Failed Executions

Allow users to re-run a failed execution from the point of failure, preserving successful node outputs.

#### 3.8.2 Execution Export

Already partially exists (`POST /api/workflows/executions/:executionId/export`). Enhance with:
- JSON export of full execution data
- CSV export of tabular outputs
- PDF report generation

#### 3.8.3 Node Deactivation

Allow individual nodes to be deactivated (skipped during execution) without removing them from the workflow. Useful for debugging and temporary changes.

---

## 4. Workflow Status Model

Adopt a three-state model (matching Langdock):

| State | Description |
|---|---|
| **Not Deployed** | Draft only. No published version. Safe for editing and testing. |
| **On** | Published version active. Triggers are listening. |
| **Off** | Published version exists but triggers paused. For maintenance. |

Map to existing `enabled` boolean: `enabled: true` → On, `enabled: false` → Off, no published version → Not Deployed.

---

## 5. Administration & Governance

### 5.1 What Already Exists

- Admin toggle for enabling/disabling workflows
- Admin routes for listing all workflows and executions
- Group-based permission system
- Platform configuration controls

### 5.2 What's Needed

- **Workflow activation control:** Admin setting to enable/disable the Workflows feature workspace-wide
- **Integration governance:** Admin controls which integrations are available in workflows
- **Cost governance:** Workspace-level spending caps and per-workflow limits
- **Audit logging:** Formal audit trail of workflow changes (create, edit, publish, delete)
- **Execution monitoring dashboard:** Real-time view of running workflows, success/failure rates, cost trends

---

## 6. API Changes Summary

### New Routes

| Method | Path | Description |
|---|---|---|
| GET | `/api/workflows/:id/form` | Render public form |
| POST | `/api/workflows/:id/form/submit` | Process form submission |
| POST | `/api/webhooks/:webhookId` | Receive webhook |
| GET | `/api/workflows/:id/draft` | Get draft version |
| POST | `/api/workflows/:id/publish` | Publish new version |
| PUT | `/api/workflows/:id/activate/:version` | Activate specific version |
| GET | `/api/workflows/:id/versions` | List version history |
| POST | `/api/workflows/executions/:id/rerun` | Re-run from failure point |
| GET | `/api/admin/workflows/costs` | Cost dashboard data |
| PUT | `/api/admin/workflows/cost-limits` | Set workspace cost limits |

### Modified Routes

| Method | Path | Change |
|---|---|---|
| POST | `/api/workflows/:id/execute` | Add `testRun` parameter |
| GET | `/api/workflows/executions/:id` | Include per-node cost data |

---

## 7. Implementation Phases

### Phase 1: Foundation (4–6 weeks)

**Goal:** Enable automated workflow execution beyond manual triggers.

- Trigger system infrastructure (scheduler service, webhook receiver)
- Scheduled Trigger implementation
- Webhook Trigger implementation
- Version control (draft/published)
- HTTP Request Node
- Loop Node
- Cost tracking (basic per-node token counting)

### Phase 2: Builder Experience (4–6 weeks)

**Goal:** Make workflows accessible to non-technical users.

- Visual Workflow Builder (React Flow canvas)
- Node configuration sidebar
- AI Workflow Builder (chat-based generation) — leverage existing chat infrastructure
- Form Trigger with public URLs
- Field modes (Manual/Auto/AI Prompt)
- Code Node (JavaScript sandbox)

### Phase 3: Enterprise Features (4–6 weeks)

**Goal:** Production-grade governance and safety.

- Cost monitoring dashboard and limits
- Guardrails Node
- Notification Node + notification infrastructure
- Parallel execution
- Execution re-run from failure
- Node deactivation
- Audit logging
- Admin governance controls

### Phase 4: Polish & Expand (Ongoing)

- Integration triggers (Jira, Office365 events)
- Image Generation Node
- Web Search / File Search dedicated nodes
- Sub-workflows
- Workflow templates/gallery
- Delay Node
- "Fix in chat" for execution errors
- Workflow import/export

---

## 8. iHub Advantages Over Langdock

Areas where iHub is already ahead or can differentiate:

| Advantage | Description |
|---|---|
| **Multi-language UI** | All workflow configs support localized strings (en/de/etc.) — Langdock doesn't mention this |
| **Transform Node** | Data manipulation without LLM — more efficient than forcing everything through AI |
| **Flexible Decision Node** | Supports 6 condition types (expression, equals, contains, exists, always, LLM) vs Langdock's 2 (manual JS, AI prompt) |
| **Enterprise Search** | Built-in iFinder and iAssistant integration for document search |
| **People Search** | Microsoft Entra integration for organizational queries |
| **LLM Recovery** | `llm_recovery` error handling mode — AI-assisted error recovery |
| **Configuration-driven** | JSON-based workflow definitions enable version control, CI/CD, and infrastructure-as-code patterns |
| **Multi-provider LLM** | Already supports OpenAI, Anthropic, Google, Mistral with per-node model override |

---

## 9. Success Metrics

### Adoption

- Active workflows per workspace
- Workflows created per week
- Percentage of workspaces with Workflows enabled
- Trigger type distribution (manual vs automated)

### Engagement

- Total executions per month
- Average nodes per workflow
- Visual builder vs JSON-only creation ratio
- AI builder usage rate

### Reliability

- Workflow success rate
- Mean time to resolution for failures
- "Fix in chat" usage and success rate

### Business Value

- Estimated time saved per workflow
- Cost per execution vs manual process equivalent
- Ratio of AI-powered nodes to static nodes

---

## 10. Technical Dependencies

| Dependency | Purpose | License |
|---|---|---|
| React Flow | Visual workflow builder canvas | MIT |
| `croner` or `node-cron` | Cron-based scheduling | MIT |
| `isolated-vm` | Secure JavaScript sandbox for Code Node | MIT |
| `undici` or `node:fetch` | HTTP Request Node | MIT / Built-in |

---

## 11. Open Questions

1. **Trigger multiplicity:** Should a single workflow support multiple triggers (e.g., both schedule and webhook), or one trigger per workflow like Langdock?
2. **Workflow storage migration:** Moving from single-file to versioned-directory storage is a schema migration. Should this be handled by the existing migration system (`server/migrations/`)?
3. **Cost model:** Should we adopt API-based pricing like Langdock, or a simpler token-counting model?
4. **Code Node language:** JavaScript only (like Langdock) or also Python? Python via Agent Node with Data Analysis is Langdock's workaround — should we do the same?
5. **Public form security:** What level of bot protection is needed for public form triggers? CAPTCHA, rate limiting, or both?
6. **Long-running delays:** For Delay Nodes >5 minutes, do we persist and schedule wake-ups, or keep the execution in memory?
