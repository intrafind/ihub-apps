# Built-ins own the shipped tools: ownership, side-effect and tool-id tests, iAssistant `ask` (implementation notes)

**Date:** 2026-11-02
**Status:** Implemented on `claude/modest-turing-had15v-builtins-2973`
**Issue:** [intrafind/ihub-apps#2973](https://github.com/intrafind/ihub-apps/issues/2973)
**Decisions:** [07 · Types and built-in configuration](07-types-and-built-in-configuration.md) (who owns what), [03 §6.9](03-product-concept.md)
**User docs:** [docs/integrations.md → Built-in integrations](../../docs/integrations.md#built-in-integrations), [docs/ifinder-iassistant-admin-guide.md](../../docs/ifinder-iassistant-admin-guide.md), [docs/answer-sources.md](../../docs/answer-sources.md)

These notes are for whoever continues the work: what this change closed of #2973, where it lives,
why it is shaped this way, and what is still open.

## What was open on #2973 (status 2026-11-02)

1. No test failed when a shipped tool had no owner (tests pinned fixed lists).
2. No snapshot of `sideEffect` / `dataFlow` of the built-in actions.
3. The iAssistant `ask` action was missing.
4. No before/after fixture for "`getToolsForApp` returns the same ids".
5. Guidance and example prompts on the built-in actions: **moved to #2974** (action detail), not
   done here.

## 1 · Ownership test

`server/tests/tool-ownership.test.js` (in `npm run test:tool-loading`).

Every tool iHub ships has exactly one owner. The owners are read from the code, never listed in
the test:

| Owner | Where the test reads it |
| --- | --- |
| built-in integration action | every `actions[]` of every shipped `builtIn` definition in `server/defaults/integration-definitions/`; tool id = `toolId` or `<singleton instanceId>__<action>` (`toolIdFor`) |
| platform tools (workflows, agents, page reader) | `PLATFORM_TOOL_IDS`, `server/services/tools/platformTools.js` |
| projects | `KNOWLEDGE_TOOL_IDS`, `server/services/knowledge/knowledgeTools.js` |
| skills | `SKILL_TOOL_IDS` (`server/toolLoader.js`), `SYSTEM_SKILL_TOOL_IDS` (`server/services/systemSkillTools.js`) |
| apps as tools | prefix `APP_TOOL_ID_PREFIX` (`app__`, `server/services/chat/appToolsGateway.js`) |
| workflows as tools | prefix `WORKFLOW_TOOL_ID_PREFIX` (`workflow_`, `server/toolLoader.js`) |

The constants `SKILL_TOOL_IDS`, `WORKFLOW_TOOL_ID_PREFIX`, `APP_TOOL_ID_PREFIX` and
`SYSTEM_SKILL_TOOL_IDS` were literals before; they are exported now and the code that generates
or dispatches those tools uses them, so the test and the runtime read the same value.

Checks:

- every tool of every file in `server/defaults/tools/` (a function-style file expands to one tool
  per function, `expandShippedTool`) has exactly one owner;
- every tool id an owner claims is claimed by nobody else (catches an action taking a platform
  tool's id, or an action id starting with `app__` / `workflow_`);
- every action of a native built-in is implemented by its registered connector;
- the check itself fails a tool without owner and a tool with two (unit cases).

**When it fails:** a new file in `server/defaults/tools/` needs an owner — an action on a built-in
definition (`toolId` keeps a historical id), an entry in `PLATFORM_TOOL_FILE_IDS`, or a feature
module that reads it. Do not add a list to the test.

## 2 · Side effect and data flow snapshot

`server/tests/integrations/builtinActionPolicies.test.js` (in `npm run test:integrations`),
snapshot `server/tests/integrations/__snapshots__/builtin-action-policies.json`, same convention as
`server/tests/loop/contracts.test.js`.

- Every action of every shipped `com.intrafind__*` definition must declare `sideEffect` (not
  `unknown`) and `dataFlow` in the file itself.
- The pairs must match the snapshot. Change one on purpose with
  `UPDATE_SNAPSHOTS=1 node --test server/tests/integrations/builtinActionPolicies.test.js` and
  review the diff.

## 3 · The iAssistant `ask` action

| What | Where |
| --- | --- |
| Definition (version 1.1.0, release notes) | `server/defaults/integration-definitions/com.intrafind__iassistant/` |
| Connector action (parameters, `run`) | `server/services/integrations/protocols/native/connectors/iassistant.js` |
| One turn: scope, profiles, conversation, citations | `server/services/integrations/iAssistantAsk.js` |
| Answer Sources for the tool | `iAssistantAskSourceProducer` in `server/services/sources/producers/ifinder.js` |
| Tests | `server/tests/iassistantAsk.test.js` (in `npm run test:ifinder`) |

Decisions taken while building it (none needed a product decision; say so if one is wrong):

- **Tool id `iassistant__ask`.** A new action, so no `toolId` (the issue: new built-ins use
  `<instanceId>__<action>`).
- **`bindExplicitly: true`.** Apps on the iAssistant model already bind `iassistant` (V192). Without
  this flag every such app would suddenly offer an `ask` tool. With it, an app gets `ask` only
  when its binding names it (`"integrations": { "iassistant": { "actions": ["ask"] } }`). The app
  editor needed no new toggle: the iAssistant panel already renders the installation's binding row
  (`IntegrationBindingRow`), which lists the action with a checkbox and the "only when ticked"
  note for `bindExplicitly` actions.
- **No config migration.** Installations have `actions.enabled: ["*"]`, so `ask` is enabled;
  the version bump to 1.1.0 has no definition migration, so the runner only stamps
  `definitionVersion` at the server start. V211 (reserved for this work) is **not** used.
- **One ephemeral conversation per call.** A tool call is one question; nothing is kept per chat,
  so a later call does not see the earlier one. The conversation is created `ephemeral: true` with
  the labels `ihub`, `ihub-tool` and the app id, so it does not show up as a conversation in the
  user's iFinder Workspace.
- **Settings without a model.** The iAssistant model's `resolveConfig` is reused with an empty
  model config: the app's `iassistant` block, then the installation's defaults. A model-level
  iAssistant config (`models/*.json` of the iAssistant model) does not apply to the tool.
- **Whom it asks**, first match wins: the chat's scope (`ctx.scope`, from
  `integrationScopes.iassistant`, already validated by the chat route) → the app's `pinnedScope`
  → the model's `assistant` argument, validated through `iAssistantScopes.validateScope`
  (refused with `SCOPE_NOT_ALLOWED`) → the app's configured setup. So a picked or pinned scope
  always overrides the model.
- **Citations are renumbered.** iAssistant numbers its result documents (`<cite type="r">N`) and
  passages (`<cite type="s">N`) from 1 per turn; the calling model merges the sources of all its
  tool calls. Every marker becomes a passage number reserved for the call
  (`allocatePassageMarkers`, like the knowledge tools), the answer text is rewritten, and a
  citation of a document iHub does not list (untitled `publicpush-*` items) is dropped.
- **Sources beside the result.** The tool reports the documents with `reportToolCallSources`; the
  model reads the answer plus a short list (`n`, title, id, profile, 300-character excerpt). The
  producer adds the scope the result names, so the frame equals the iAssistant chat answer's
  (documents of provider `ifinder`, private, with the "Asked …" scope).
- **Errors** the model or user can act on are `IAssistantAskError` with a `code`
  (`INVALID_QUESTION`, `NOT_SIGNED_IN`, `NOT_AVAILABLE`, `ASSISTANT_NOT_AVAILABLE`,
  `SCOPE_NOT_ALLOWED`, `ANSWER_FAILED`); iFinder failures stay plain errors.
- `ConversationApiService.sendMessage` takes an optional `signal` now, so an aborted chat aborts the
  turn.

## 4 · Tool-id regression fixture

`server/tests/builtin-app-tool-ids.test.js` (in `npm run test:tool-loading`), fixture
`server/tests/fixtures/builtin-app-tool-ids.json`.

23 app configs bound to iFinder, iAssistant, Jira, the web search engines (Brave, Qwant, auto,
native Google/Anthropic, switched off) and the iHub tools, each with the tool ids `getToolsForApp`
returns (compared as sets). Scheduled tasks are on (filesystem storage in a temp dir), so the
scheduling tools appear. The installations get their definition's current version in the test, so
a version bump does not break it.

**When it fails:** a refactor changed what an app offers its model. If that is intended (#2913
removing a legacy branch on purpose), change the fixture in the same PR and say why in the PR.

## Open

- **Guidance and example prompts** on the built-in actions (including `ask`): #2974.
- The MCP gateway exposes `iassistant__ask` like any integration tool; a gateway caller has no
  app, so the installation's defaults apply and no scope is pinned. Revisit if a gateway client
  needs a scope.
- `isCitationProducingTool` (`server/services/loop/toolClassify.js`) does not know `ask`; the
  wrap-up nudge treats it like any tool. Harmless today.
