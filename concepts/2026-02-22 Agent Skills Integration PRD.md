# PRD: Agent Skills Integration for iHub Apps

**Date:** 2026-02-22
**Author:** Daniel Manzke / Claude
**Status:** Draft
**Priority:** High

---

## 1. Problem Statement

iHub Apps currently has a powerful tool system for extending LLM capabilities (web search, document extraction, Jira integration, etc.), but these tools are defined in a proprietary format inside `contents/config/tools.json` with corresponding server-side scripts. This approach has several limitations:

- **Authoring friction:** Creating new tools requires editing JSON configuration, writing server-side JavaScript scripts, and understanding the internal adapter/converter pipeline. Non-developers cannot contribute capabilities.
- **No portable knowledge:** Tools execute code but cannot carry domain expertise, procedural instructions, or organizational context. There is no mechanism to give an LLM "how-to" knowledge that doesn't involve function calling.
- **No ecosystem compatibility:** The tool format is proprietary to iHub. Skills authored for Claude Code, Cursor, VS Code, Gemini CLI, and other agents cannot be reused, and vice versa.
- **Context inefficiency:** All tool definitions are injected into every request regardless of relevance. There is no progressive disclosure mechanism.

**Agent Skills** (agentskills.io) is an open standard — originally developed by Anthropic and now adopted by 25+ agent products — that solves these problems with a lightweight folder-based format centered on a `SKILL.md` file containing YAML metadata and markdown instructions.

## 2. Proposed Solution

Integrate the Agent Skills standard into iHub Apps as a first-class capability alongside (not replacing) the existing tool system. This gives iHub users access to the growing ecosystem of portable skills while preserving all existing tool functionality.

### 2.1 How Agent Skills Work

A skill is a folder containing at minimum a `SKILL.md` file:

```
my-skill/
├── SKILL.md          # Required: YAML frontmatter + markdown instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: additional documentation
└── assets/           # Optional: templates, resources
```

The `SKILL.md` file has this structure:

```yaml
---
name: pdf-processing
description: Extract text and tables from PDF files, fill forms, merge documents.
license: Apache-2.0
metadata:
  author: example-org
  version: "1.0"
compatibility: Requires poppler-utils for PDF rendering
allowed-tools: Bash(pdftotext:*) Read
---

# PDF Processing

## When to use this skill
Use this skill when the user needs to work with PDF files...

## Steps
1. Extract text using pdfplumber...
2. ...
```

Skills use **progressive disclosure** with three context tiers:

1. **Discovery (~100 tokens per skill):** Only `name` and `description` are loaded at startup and injected into the system prompt so the LLM knows what's available.
2. **Activation (<5000 tokens):** When a user task matches a skill's description, the LLM reads the full `SKILL.md` body into its context.
3. **Execution (as needed):** The LLM reads referenced files (`scripts/`, `references/`, `assets/`) only when the instructions require them.

This is fundamentally different from iHub's current tools, which are all function-calling based. Skills are **instruction-based** — they teach the LLM *how* to do something rather than giving it a function to call.

### 2.2 Mapping to iHub Architecture

| Agent Skills Concept | iHub Equivalent | Integration Approach |
|---|---|---|
| Skill discovery | `configCache` loads `tools.json` | Extend `configCache` to also scan skill directories and parse frontmatter |
| Skill metadata in system prompt | Tools injected via `RequestBuilder` | Inject `<available_skills>` XML block into system prompt |
| Skill activation (full SKILL.md read) | No equivalent — tools are always fully loaded | LLM requests skill content via a new `activate_skill` tool or system prompt instruction |
| Skill scripts | Tool scripts in `server/tools/` | Execute skill scripts via existing `ToolExecutor` infrastructure |
| Skill references/assets | No equivalent | Served via new API endpoint; LLM reads on demand |
| Permission control | Group-based permissions on tools | Extend group permissions to include skill access |
| Per-app skill assignment | `tools` array in app config | Add `skills` array in app config |

## 3. Goals & Non-Goals

### Goals

- **G1:** Users can install and use Agent Skills from the open ecosystem (GitHub, npm, etc.) without any code changes.
- **G2:** Organization admins can author custom skills (domain knowledge, internal workflows) using only markdown and optional scripts.
- **G3:** Skills integrate seamlessly with the existing chat experience — the LLM automatically discovers relevant skills and activates them on demand.
- **G4:** Skills respect iHub's group-based permission system — admins control which skills are available to which user groups.
- **G5:** Skills work with all LLM providers supported by iHub (OpenAI, Anthropic, Google, Mistral, local models).
- **G6:** The admin UI provides skill management (browse, enable/disable, configure, upload).

### Non-Goals

- Replacing the existing tool system. Skills and tools serve different purposes (instructions vs. function calls) and coexist.
- Building a skill marketplace or registry. Skills are managed as local files, similar to how apps/models are configured today.
- Supporting skill execution in a sandboxed environment. Script execution uses the same trust model as existing tool scripts.
- Real-time collaborative skill editing.

## 4. User Stories

### US-1: Admin installs a community skill
> As an iHub admin, I want to install a skill from the Agent Skills ecosystem (e.g., from GitHub) by placing the skill folder in the skills directory and optionally configuring it in the admin UI, so my users gain new capabilities without custom development.

### US-2: Admin authors a custom skill
> As an iHub admin, I want to create a custom skill by writing a `SKILL.md` file with our organization's specific procedures (e.g., "How to write a compliance report using our template"), so the AI follows our internal standards.

### US-3: User benefits from skills transparently
> As an iHub user, I want the AI to automatically detect when a skill is relevant to my request and apply its specialized knowledge, without me having to explicitly select or invoke skills.

### US-4: Admin assigns skills to apps
> As an iHub admin, I want to assign specific skills to specific apps, so the "Legal Review" app has access to legal skills while the "Data Analysis" app has access to data skills.

### US-5: Admin controls skill permissions
> As an iHub admin, I want to control which user groups can access which skills via the existing group permissions system.

### US-6: User views active skills
> As a user, I want to see which skills the AI activated during my conversation, so I understand what knowledge informed its response.

## 5. Technical Design

### 5.1 Skill Storage & Discovery

Skills are stored on the filesystem under a configurable directory:

```
contents/
├── config/
│   ├── tools.json          # Existing tool definitions
│   └── skills.json         # NEW: Skill registry & configuration
├── skills/                  # NEW: Skill directories
│   ├── pdf-processing/
│   │   ├── SKILL.md
│   │   ├── scripts/
│   │   └── references/
│   ├── data-analysis/
│   │   └── SKILL.md
│   └── compliance-review/
│       ├── SKILL.md
│       └── assets/
│           └── template.docx
├── apps/
└── models/
```

**`contents/config/skills.json`** — Skill registry with metadata overrides and admin configuration:

```json
{
  "skills": {
    "pdf-processing": {
      "enabled": true,
      "directory": "pdf-processing",
      "overrides": {
        "description": "Custom description for our org"
      }
    },
    "compliance-review": {
      "enabled": true,
      "directory": "compliance-review",
      "allowScriptExecution": true
    }
  },
  "settings": {
    "skillsDirectory": "contents/skills",
    "maxSkillBodyTokens": 5000,
    "maxSkillsPerRequest": 10,
    "allowScriptExecution": false
  }
}
```

### 5.2 Skill Loader Service

New server module: `server/services/skillLoader.js`

**Responsibilities:**

1. Scan the skills directory for valid skill folders (containing `SKILL.md`)
2. Parse YAML frontmatter from each `SKILL.md` and validate against the Agent Skills spec
3. Cache skill metadata in `configCache` alongside tools, apps, and models
4. Serve full skill content and referenced files on demand via API

**Key Functions:**

```javascript
// Called at startup and on config reload
async function loadSkillsMetadata(skillsDirectory)
// Returns: Map<skillName, { name, description, path, license, compatibility, metadata }>

// Called when LLM activates a skill
async function getSkillContent(skillName)
// Returns: { body: string, references: string[], scripts: string[] }

// Called by RequestBuilder to get skills for an app
function getSkillsForApp(app, userGroups)
// Returns: Array<{ name, description }> filtered by app config and permissions
```

### 5.3 System Prompt Integration

The `RequestBuilder` is extended to inject skill metadata into the system prompt. This follows the Agent Skills integration spec:

```xml
<available_skills>
  <skill>
    <name>pdf-processing</name>
    <description>Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF documents or when the user mentions PDFs, forms, or document extraction.</description>
  </skill>
  <skill>
    <name>compliance-review</name>
    <description>Review documents against our compliance framework. Use when reviewing contracts, policies, or regulatory documents.</description>
  </skill>
</available_skills>
```

For **tool-based activation** (recommended for iHub since it's a web app without filesystem access for the LLM), a new internal tool is registered:

```json
{
  "id": "activate_skill",
  "name": { "en": "Activate Skill" },
  "description": { "en": "Load the full instructions for a skill when it's relevant to the current task." },
  "isInternalTool": true,
  "parameters": {
    "type": "object",
    "properties": {
      "skill_name": {
        "type": "string",
        "description": "The name of the skill to activate"
      }
    },
    "required": ["skill_name"]
  }
}
```

When the LLM calls `activate_skill`, the `ToolExecutor` loads the full `SKILL.md` body and returns it as the tool result. The LLM then has the full instructions in context.

A companion tool for reading skill resources:

```json
{
  "id": "read_skill_resource",
  "name": { "en": "Read Skill Resource" },
  "description": { "en": "Read a referenced file from an activated skill (scripts, references, assets)." },
  "isInternalTool": true,
  "parameters": {
    "type": "object",
    "properties": {
      "skill_name": { "type": "string" },
      "file_path": {
        "type": "string",
        "description": "Relative path from the skill root, e.g. 'references/REFERENCE.md' or 'scripts/extract.py'"
      }
    },
    "required": ["skill_name", "file_path"]
  }
}
```

### 5.4 Skill Activation Flow

```
User sends message
    │
    ▼
RequestBuilder.prepareChatRequest()
    ├── Load app config (includes skills array)
    ├── Load skill metadata for app → inject <available_skills> into system prompt
    ├── Add activate_skill + read_skill_resource to tool list
    └── Build request with existing tools + skill tools
    │
    ▼
LLM receives message + system prompt with skill metadata + tools
    │
    ▼
LLM decides task matches "pdf-processing" skill
    │
    ▼
LLM calls: activate_skill({ skill_name: "pdf-processing" })
    │
    ▼
ToolExecutor handles activate_skill:
    ├── Validate skill_name exists and user has permission
    ├── Load full SKILL.md body via skillLoader
    ├── Track activation in action tracker (for UI display)
    └── Return SKILL.md body as tool result
    │
    ▼
LLM now has full skill instructions in context
    │
    ▼
LLM follows instructions, may call read_skill_resource for additional files
    │
    ▼
LLM may also call existing tools (web search, etc.) as part of skill execution
    │
    ▼
Response streamed to user with skill activation indicator
```

### 5.5 App Configuration Extension

Extend the app config schema (`appConfigSchema.js`) to support skills:

```javascript
// In app JSON config
{
  "id": "legal-review",
  "name": { "en": "Legal Review" },
  // ... existing fields ...
  "tools": ["webContentExtractor"],
  "skills": ["compliance-review", "contract-analysis"],  // NEW
  "skillSettings": {                                       // NEW (optional)
    "autoActivate": false,
    "maxActiveSkills": 3
  }
}
```

**Schema addition:**

```javascript
skills: z.array(z.string()).optional(),
skillSettings: z.object({
  autoActivate: z.boolean().optional(),
  maxActiveSkills: z.number().min(1).max(10).optional()
}).optional()
```

### 5.6 Permission Model

Extend `groups.json` to include skill permissions:

```json
{
  "groups": {
    "admin": {
      "permissions": {
        "apps": ["*"],
        "models": ["*"],
        "skills": ["*"]
      }
    },
    "users": {
      "permissions": {
        "apps": [],
        "models": ["gemini-2.0-flash"],
        "skills": ["pdf-processing", "data-analysis"]
      }
    }
  }
}
```

The existing `filterResourcesByPermissions()` function in `authorization.js` is extended to handle skill filtering using the same wildcard and array-matching logic already in place for apps and models.

### 5.7 Admin UI

New admin section under `/admin/skills`:

**Skill List View:**
- Table of all discovered skills with name, description, status (enabled/disabled), source directory
- Enable/disable toggle per skill
- Filter and search

**Skill Detail View:**
- Full SKILL.md content rendered as markdown (preview)
- Metadata display (name, description, license, compatibility, author, version)
- Configuration overrides (custom description, script execution toggle)
- File browser for skill contents (scripts, references, assets)
- Assigned apps list
- Assigned groups list

**Skill Upload:**
- Upload a `.zip` containing a skill folder
- Validate against Agent Skills spec on upload
- Extract to skills directory

### 5.8 Slash Command Activation

Skills integrate with iHub's existing `/` command system (currently used for the prompt library via `PromptSearch.jsx`). When a user types `/` in an empty chat input, the search modal shows both prompts and skills.

**Discovery flow:**

1. User types `/` in the chat input → `ChatInput.jsx` opens the search modal
2. The search modal fetches skills from `/api/skills` alongside prompts from `/api/prompts`
3. Skills appear in a dedicated "Skills" section with a distinguishing icon (e.g., a lightning bolt)
4. User selects a skill → the full `SKILL.md` body is fetched from `/api/skills/:name/content`
5. The skill instructions are injected as a system-level context message prepended to the next LLM request (similar to how prompt templates inject their content)

**Implementation approach:**

Extend `PromptSearch.jsx` (or create a unified `CommandPalette.jsx`) to:
- Fetch both prompts and skills in parallel
- Use Fuse.js to search across both result sets
- Display results in grouped sections (Prompts / Skills)
- On skill selection, fetch full content and attach to the next message as skill context

**Slash command format in chat input:**

```
/pdf-processing     → activates the pdf-processing skill
/compliance-review  → activates the compliance-review skill
```

When activated via slash command, the skill instructions are injected directly — bypassing the LLM's `activate_skill` tool call. This gives users explicit control over which skill to apply.

**Interaction with LLM auto-activation:** Both mechanisms coexist. The LLM can still auto-activate skills via the `activate_skill` tool when it detects relevance. If a user has already activated a skill via slash command, the LLM sees the instructions in context and does not need to call the tool.

### 5.9 Export/Import

Skills are included in iHub's existing configuration backup system (`server/routes/admin/backup.js`). The `contents/skills/` directory is automatically included when exporting via `GET /api/admin/backup/export` and restored when importing via `POST /api/admin/backup/import`, since the backup system already archives the entire `contents/` directory.

**Additionally**, individual skill export/import is supported for sharing single skills between iHub instances without full config migration:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/skills/:name/export` | Export a single skill as a `.zip` file |
| `POST` | `/api/admin/skills/import` | Import a skill `.zip` (validates against Agent Skills spec before extraction) |

**Single skill export** creates a zip containing the skill folder:

```
pdf-processing.zip
└── pdf-processing/
    ├── SKILL.md
    ├── scripts/
    └── references/
```

**Single skill import** validates the zip contents:
1. Must contain exactly one top-level directory
2. Directory must contain a valid `SKILL.md` with conforming frontmatter
3. Skill name must not conflict with an existing skill (or user confirms overwrite)
4. Extracts to `contents/skills/` and reloads `configCache`

This mirrors the pattern used for individual app/model management in `server/routes/admin/apps.js` and `server/routes/admin/models.js`.

### 5.10 Client-Side Changes

**Chat UI indicators:**
- When the LLM activates a skill, display a subtle indicator in the chat (similar to how tool calls are currently shown)
- Show skill name and description in an expandable card
- Track activated skills in the conversation metadata

**Skills selector (optional):**
- Similar to existing `ToolsSelector.jsx`, allow users to manually suggest skills if the app enables user-directed skill selection

### 5.11 API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/skills` | List available skills (filtered by user permissions) |
| `GET` | `/api/skills/:name` | Get skill metadata |
| `GET` | `/api/skills/:name/content` | Get full SKILL.md body |
| `GET` | `/api/skills/:name/files/:path` | Read a skill resource file |
| `GET` | `/api/admin/skills` | Admin: list all skills with config |
| `PUT` | `/api/admin/skills/:name` | Admin: update skill configuration |
| `POST` | `/api/admin/skills/upload` | Admin: upload new skill (zip) |
| `DELETE` | `/api/admin/skills/:name` | Admin: remove skill |
| `POST` | `/api/admin/skills/validate` | Admin: validate a skill directory |
| `GET` | `/api/admin/skills/:name/export` | Admin: export single skill as zip |
| `POST` | `/api/admin/skills/import` | Admin: import single skill from zip |

### 5.12 Provider Compatibility

Skills are provider-agnostic by design. The system prompt injection and tool-based activation work identically across all providers because:

1. System prompt injection is handled by `RequestBuilder` before provider-specific formatting
2. `activate_skill` and `read_skill_resource` are standard tools processed by the existing `ToolCallingConverter` pipeline
3. The skill instructions themselves are plain text returned as tool results

**Consideration for models without tool support:** For models that don't support tool calling, skill activation can fall back to including all relevant skill instructions directly in the system prompt (at the cost of higher token usage). The `skillSettings.autoActivate` flag on the app config controls this.

## 6. Implementation Phases

### Phase 1: Core Infrastructure (Week 1-2)

- Skill loader service (`server/services/skillLoader.js`)
- YAML frontmatter parser with validation against Agent Skills spec
- Integration with `configCache` for skill metadata caching
- `activate_skill` and `read_skill_resource` internal tools
- `RequestBuilder` changes to inject `<available_skills>` into system prompt
- `ToolExecutor` handler for skill activation tools
- Skills field in app config schema
- Basic API endpoints (`GET /api/skills`, `GET /api/skills/:name/content`)

### Phase 2: Permissions & Admin (Week 3-4)

- `skills` permission in groups configuration
- Permission filtering in skill loader
- Admin API endpoints (CRUD, upload, validate)
- Admin UI: skill list view with enable/disable
- Admin UI: skill detail view with metadata and preview
- Admin UI: skill assignment to apps
- Admin UI: skill upload (zip)
- Single skill export/import endpoints
- Admin UI: export/import buttons on skill list and detail views

### Phase 3: Client Experience (Week 5)

- Slash command (`/`) integration: extend search modal to include skills alongside prompts
- Slash command activation flow: fetch full skill content and inject into LLM context
- Chat UI: skill activation indicator cards (for both slash-command and LLM-initiated activation)
- Conversation metadata: track activated skills
- Optional skills selector component for user-directed activation
- Action tracker integration for skill activation events

### Phase 4: Advanced Features (Week 6+)

- Skill script execution with configurable sandboxing
- Auto-activate mode for models without tool calling
- Skill dependency resolution (skills that reference other skills)
- Skill analytics (activation frequency, user satisfaction)
- Bulk skill import from Git repositories

## 7. Success Metrics

| Metric | Target | Measurement |
|---|---|---|
| Skill activation rate | >30% of conversations in skill-enabled apps | Server-side activation tracking |
| Admin skill creation time | <15 minutes for a basic skill | User testing |
| Ecosystem skill compatibility | 100% of valid Agent Skills spec skills work | Automated validation testing |
| No regression on existing tools | 0 broken tool integrations | Existing test suite + manual verification |
| Context efficiency | <200 tokens overhead per skill in discovery mode | Token counting in RequestBuilder |

## 8. Security Considerations

- **Script execution is off by default.** The global `allowScriptExecution` setting defaults to `false`. Admins must explicitly enable it globally and per-skill.
- **File access is sandboxed.** `read_skill_resource` only serves files within the skill's own directory. Path traversal attempts (e.g., `../../config/platform.json`) are rejected.
- **Permission enforcement.** Skills respect the same group-based permission model as apps and tools. A user can only activate skills their group has access to.
- **Input validation.** Skill names are validated against the Agent Skills spec (lowercase alphanumeric + hyphens, max 64 chars). File paths are validated and sanitized.
- **Upload validation.** Uploaded skill zips are validated against the spec before extraction. Malformed or oversized files are rejected.

## 9. Decisions & Resolved Questions

| Question | Decision | Rationale |
|---|---|---|
| **Versioning** | No built-in versioning. Version tracked only via optional `metadata.version` field in SKILL.md frontmatter. | Keeps implementation simple. Skills are files — use Git for version control if needed. |
| **Sharing between instances** | Yes — export/import for individual skills (zip) plus full config backup/restore. Same pattern as apps and models. | Consistent with existing iHub patterns in `backup.js`, `apps.js`, `models.js`. |
| **Remote skill registries** | Not in scope for initial release. | Can be revisited once the local skill system is stable and usage patterns emerge. |
| **Slash command activation** | Yes — skills appear in the `/` command palette alongside prompts. Users can explicitly activate a skill before sending a message. | Gives users direct control; complements LLM auto-activation. Fits naturally into the existing `PromptSearch` UX. |

### Remaining Open Questions

1. **What is the token budget for skills?** The spec recommends <5000 tokens per skill body. Should we enforce this or make it configurable?
2. **Should skill activation count against tool call limits?** Currently, tool calls in a conversation loop are implicitly bounded. Skill activation adds to this.

## 10. Appendix: Agent Skills Specification Summary

### Required Frontmatter Fields

| Field | Constraints |
|---|---|
| `name` | 1-64 chars, lowercase alphanumeric + hyphens, no leading/trailing/consecutive hyphens, must match directory name |
| `description` | 1-1024 chars, describes what the skill does AND when to use it |

### Optional Frontmatter Fields

| Field | Purpose |
|---|---|
| `license` | License name or reference to bundled LICENSE file |
| `compatibility` | Environment requirements (max 500 chars) |
| `metadata` | Arbitrary key-value pairs (author, version, etc.) |
| `allowed-tools` | Space-delimited list of pre-approved tools (experimental) |

### Directory Structure

```
skill-name/
├── SKILL.md          # Required
├── scripts/          # Optional: executable code
├── references/       # Optional: additional documentation
└── assets/           # Optional: templates, static resources
```

### Progressive Disclosure Tiers

1. **Metadata** (~100 tokens): `name` + `description` loaded at startup
2. **Instructions** (<5000 tokens): Full `SKILL.md` body loaded on activation
3. **Resources** (as needed): Referenced files loaded on demand

### Adopters

The Agent Skills standard is supported by: Claude Code, Claude.ai, Cursor, VS Code, GitHub, Gemini CLI, OpenAI Codex, Roo Code, Goose, Amp, and 15+ other agent products.
