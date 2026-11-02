# iHub integration: chat tools only

**Date:** 2026-11-01
**Status:** Implemented (branch `claude/exciting-feynman-2aju98-ihub-tools`)
**Epic:** [intrafind/ihub-apps#2911](https://github.com/intrafind/ihub-apps/issues/2911)
**Decision:** product owner, 2026-11-01 — the always-installed iHub integration owns only the
tools users call in chats. See [03 · Product concept §6.9](03-product-concept.md).

## What changed

Migration V199 had moved all 22 of iHub's own tools into the always-installed integration
`ihub` (`com.intrafind/ihub`). That made the knowledge, agent and evidence tools depend on an
installation and its action switches, and listed workflow internals on the Integrations page.
Now every tool belongs to the feature that uses it:

| Owner | Tools | Where it is loaded |
| --- | --- | --- |
| iHub integration (installation `ihub`) | `ask_user`, `schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task`, `run_scheduled_task_now`, `list_task_runs`, `get_task_run` | `server/services/integrations/protocols/native/connectors/ihub/index.js` (`IHUB_TOOL_FILE_IDS`), discovered like every integration action |
| Projects | `knowledge_search`, `knowledge_read`, `knowledge_list` | `server/services/knowledge/knowledgeTools.js`: `knowledgeToolsFor` (offered), `runKnowledgeTool` (run) |
| Workflows and agents ("platform tools") | `write_artifact`, `read_memory`, `write_memory`, `read_inbox`, `write_inbox`, `create_task`, `list_tasks`, `mark_task_done`, `evidence_collect`, `evidence_validateQuotesFastPath`, `evidence_composeReport` | `server/services/tools/platformTools.js`, added to `loadTools()` as plain tools |

All three read the shipped tool files in `server/defaults/tools/<id>.json` as data, through
`server/services/tools/shippedToolDefinitions.js` (expand function-style files such as
`evidence`, run the implementation in `server/tools/<script>.js` with schema defaults applied).
The files stay in `server/defaults/tools/` because released migrations (V087, V160, V173) read
them; `server/utils/setupUtils.js` (`RETIRED_IHUB_TOOL_FILES`) keeps initial setup from copying
them into `contents/tools/` again.

## How each owner behaves

### iHub integration

- The definition `server/defaults/integration-definitions/com.intrafind__ihub/integration.json`
  lists the eight actions, `compatibility.ihub >=5.6.0` and the `1.0.0` release with notes in
  `releases/1.0.0/`. It stays at 1.0.0 because it has not shipped yet.
- The tools carry `_integration` (`fixedToolId: true`), so `app.tools: ["ask_user"]` selects them
  by id, and the installation's groups and action switches apply.

### Project knowledge tools

- `getToolsForApp` (`server/toolLoader.js`) calls `knowledgeToolsFor` when the app object carries a
  project link (`hasProjectScope`) and there is a user. `knowledgeToolsFor` returns nothing when the
  projects feature (`features.projects`) is off or no project is reached; otherwise the three tools,
  localized, with the scope appended to each description.
- `loadTools()` never contains a `knowledge_*` tool — not from a leftover
  `contents/tools/knowledge.json`, not from an integration. `runTool` sends every `knowledge_*` id
  to `runKnowledgeTool`, which refuses while the projects feature is off. The implementation
  (`server/tools/knowledge.js`) resolves the request's scope again on every call.
- Consequence: `app.tools: ["knowledge"]` selects nothing; the tools come with projects only.

### Platform tools of workflows and agents

- `loadPlatformTools` in `server/toolLoader.js` localizes the shipped definitions and skips every
  id a `contents/tools/` file has (enabled or not). So, as before V199, an edited file takes the
  place of the shipped definition and a file with `enabled: false` switches the tool off.
- `loadLocalTools()` = configured tools + platform tools. `loadTools()` adds the integration tools
  to it; the inbound MCP gateway (`server/services/mcp/McpServerService.js`) lists
  `loadLocalTools()` plus the people directory tools, so a group grant exposes a platform tool
  over MCP as it did before V199.
- Everything that resolves them by id keeps working: workflow prompt nodes
  (`PromptNodeExecutor.getAgentTools` → `getToolsForApp`), agent runs
  (`server/agents/runtime/agentToolRegistrar.js`), `app.tools` (exact or base id, `evidence`),
  group grants (`configCache.getToolsForUser`), a scheduled run's memory tools
  (`server/services/scheduler/tasks/runMemory.js`, which now reads `loadTools()`), and `runTool`.

## Migration V202

`server/migrations/V202__ihub_integration_chat_tools_only.js`, test
`server/tests/migration-v202.test.js`:

1. Removes the retired tool files that are back in `contents/tools/` as shipped (initial setup
   had copied them again on every start since V199). A switched-off iHub file becomes an entry of
   `actions.disabled`; a switched-off platform tool file is kept (it is the off switch); an edited
   `knowledge.json` is kept with a warning (no longer read).
2. Removes the moved action names from the `ihub` installation's `actions.enabled`,
   `actions.disabled` and `actions.overrides` in `config/integrations.json`.
3. A platform tool the installation had switched off (all of a file's actions) stays off: its
   shipped file is written to `contents/tools/` with `enabled: false`. A switched-off knowledge
   action and a single evidence function cannot be carried over and are named in a warning.

Missing files or installation: no-op. A second run changes nothing.

## Tests

| Test | Covers |
| --- | --- |
| `server/tests/integrations/ihubConnector.test.js` | the installation's tools are exactly the eight kept ones; selection by id; switches |
| `server/tests/knowledge-local-provider.test.js` (`describe('tools')`) | knowledge tools offered without any knowledge action on `ihub`; not offered without a project or with projects off; run through `runTool` |
| `server/tests/platform-tools.test.js` | platform tools load as plain tools, ignore the `ihub` switches, give way to a tool file, are not seeded, resolve for prompt nodes, agent runs, grants, the MCP gateway, `runTool`, memory tools |
| `server/tests/migration-v202.test.js`, `migration-v199.test.js` | the migrations |

Run: `npm run test:integrations`, `npm run test:tool-loading`, `npm run test:projects`,
`npm run test:migrations`.

## Open points

- The Integrations page has no place for the platform tools; an admin switches one off with a
  tool file (`contents/tools/<id>.json`, `enabled: false`), e.g. through **Admin → Tools**.
- The evidence tools share one file: they can only be switched off together.
