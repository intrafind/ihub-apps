# 2026-11-02 · Custom integration builder and the tool-file migration

**Status:** implemented (#2975, #2915 item 1) · Part of [Unified Integrations](README.md) · builds on [Tool approval](2026-11-02%20Tool%20approval.md)

Implementation notes for whoever continues this work. The product side is [03 §6.8](03-product-concept.md) and decision 8 (clean break for `/api/admin/tools`, decided 2026-10-31); the API side is [04 §1.1 and §4](04-architecture.md).

## What exists now

| Piece | Where | Notes |
| --- | --- | --- |
| Builder page | `client/src/features/admin/pages/AdminIntegrationBuilderPage.jsx`, route `/admin/integrations/builder/:instanceId` (`new` for a new one) | Tabs Basics, Sign-in, Source, Actions, Review. Entry points: **Add manually** (header and Catalog tab of Admin → Integrations), **Edit in builder** on an installation page whose definition is `custom/…` |
| Draft rules | `client/.../integrations/builder/builderModel.js` | Pure: empty draft, source switch, operations/tools → actions, placeholders, step errors, `draftForSave`. Unit-tested in `tests/unit/client/integration-builder.test.jsx` |
| Step components | `client/.../integrations/builder/*.jsx` | `BuilderActionCard` reuses `ToolApprovalFields` (#3136); the OpenAPI source is the default export of `components/OpenApiToolEditor.jsx` (the file keeps its name because `CredentialRefSelect` lives there and twelve editors import it) |
| Draft schema | `server/validators/integrationBuilderSchema.js` | What the routes accept |
| Draft ↔ package | `server/services/integrations/builder/builderPackage.js` | Pure: `draftToPackage`, `packageToDraft`, `exportPackage` |
| Service | `server/services/integrations/builder/IntegrationBuilderService.js` | Writes through `IntegrationRegistry.writeInstalled` / `stageInstalled`+`commitStaged` and `InstalledIntegrationService` — no store of its own. Update keeps the previous folder until the installation saved, then drops it |
| Routes | `server/routes/admin/integrationBuilder.js` | `POST /api/admin/integrations/builder`, `GET`/`PUT …/builder/:id`, `POST …/builder/_import`, `POST …/builder/_export/:id`, `GET /api/admin/integrations/tools` |
| `http` adapter | `server/services/integrations/protocols/http/` | `httpTemplates.js` (escaping, response mapping, pure) and `HttpAdapter.js` (SSRF guard: `safeFetch` direct, `assertSafeHost` + `httpFetch` when proxied; no redirects) |
| Migration | `server/migrations/V211__tools_to_custom_integrations.js` | Tool files → `custom/<slug>` definitions + installations; tests `server/tests/migration-v211.test.js` |

## Decisions taken in the implementation

1. **Definition id `custom/<installation id>`.** One custom definition per custom installation; the builder never shares a custom definition between installations. `isCustomDefinitionId` in the definition schema names the namespace.
2. **Fixed tool ids (`toolId`) for custom definitions.** The schema allowed `toolId` only on built-ins; it now also allows it on `custom/…` definitions, because the migration must keep tool ids (`myTool`, `myTool_search`). The builder never mints one: on save it keeps a `toolId` only where the previous definition had it for the same action name (tested: a draft cannot set `ask_user`). A registry definition with `toolId` is refused (`ContentInstaller`), and the export strips them.
3. **Action `parameters` in the definition.** `http` needs a declared schema; a `script` module may leave it to the definition (`NativeAdapter` takes the module's first, then the definition's).
4. **`serviceAccount.kind: "credential"`.** Sends the referenced credential profile the way its own type says (bearer, basic user/password, API key header or query, OAuth2 client credentials) through `OpenApiToolRunner.resolveCredentialAuth`. This is what migrated OpenAPI tools need (their `credentialRef` was any profile type) and the builder's default for OpenAPI and HTTP. MCP and A2A only take `bearer` and `header`.
5. **Remote OpenAPI documents.** `protocol.document` may stay an https URL (a migrated tool with a `url` source); the adapter then hands the runner a URL source, fetched through the SSRF guard and cached. The builder always stores the document as `openapi.json`. `protocol.baseUrl` is optional (the document's first server).
6. **Script tools run their old code.** V211 cannot copy a `server/tools/*.js` script into the definition folder (relative imports are refused, and the module shape differs). The generated `actions/connector.js` calls `ctx.runToolScript(script, { method })`, a context helper the `script` protocol now offers (`server/services/tools/toolScriptRunner.js`, also used by `toolLoader.runTool`).
7. **Local stdio MCP servers** may be built (`writeInstalled(…, { local: true })`) but never exported.
8. **Per-action data flow for MCP tools / A2A skills** is an installation override (`actions.overrides[name].dataFlow`), read by `resolveDataFlow`.
9. **The admin pickers** (app/agent tool selector, workflow tool/prompt/planner nodes, agent memory) moved from `GET /api/admin/tools` (tool files only) to `GET /api/admin/integrations/tools` (`loadTools()`: platform tools, remaining tool files, actions of enabled installations). The user listing `GET /api/tools` was not usable: it filters by the admin's own `permissions.tools`, which is empty on a fresh install.
10. **Group grants.** V211 adds each new installation to every group with an explicit `permissions.integrations` list (no `*`): before, a tool was usable by everyone who could open an app listing it. `permissions.tools` stays as it is (gateways still select by tool id); its general move to `permissions.integrations` is #2915 item 2, not done here.

## Not done here (follow-ups)

- An action test from the builder for an unsaved draft (the per-action test belongs to the action detail, #2974). Today: save, then **Test connection** on the installation page (runs the first read action).
- `permissions.tools` → `permissions.integrations` for all tools (#2915 item 2), `iassistant.*` on bindings (#2915 item 3), the migration dry run (#2915 item 4).
- Rendering a definition's icon on the tiles (the icon URL is stored and exported only).
- Removing the leftover admin-search category `tools` in `server/routes/admin/search.js` (the command palette no longer shows it).

## How to try it

1. `npm run dev`, sign in as `admin` / `password123`.
2. **Admin → Integrations → Add manually** → name "Orders", ID `orders` → Sign-in none → Source **HTTP request**, base URL `https://httpbin.org` → Actions: add one, URL `/anything/{id}`, **Add them as parameters** → Review → Create.
3. On the installation page: **Test connection**, then bind it to an app (`app.integrations.orders`).
4. Back in the builder: **Export for a registry** downloads the package.
