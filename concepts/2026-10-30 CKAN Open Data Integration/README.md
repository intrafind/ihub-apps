# CKAN Open Data Portal: the first catalog integration

**Date:** 2026-10-30 · **Status:** Proposal, researched and tested · Part of [Unified Integrations](../2026-10-20%20Unified%20Integrations/README.md) (epic [intrafind/ihub-apps#2911](https://github.com/intrafind/ihub-apps/issues/2911))
**Files in this folder:** this README (research, tests, proposal) · [`ckan-openapi.json`](ckan-openapi.json) (trimmed CKAN Action API document, 12 read operations, tested) · [`integration.json`](integration.json) (draft definition in the format of [04 · Architecture §1.1](../2026-10-20%20Unified%20Integrations/04-architecture.md); fields that go beyond that format are under `_proposed`)

## Requirement

> A customer wants an app which can use the API of CKAN. The use case will be to find the datasets, to get the metadata, to access the data and resources. The integration should consider the integration concepts and issues already written. The goal is one integration which can be installed; when installed it can be configured; each integration has a set of tools and configuration parameters; the integration can be configured in an app; integrations can be stored in our marketplace so we do not have to deliver all of them. We need a strong interface which holds for further integrations. Let's use CKAN as the first iteration to bring all integrations together.

## Summary

CKAN is the open-source software behind most public open data portals: GovData and the German state and city portals, data.gov, open.canada.ca, data.gov.uk, hundreds of municipal portals, and data.europa.eu offers a CKAN-compatible search API on top. Companies and research institutes run it as an internal data catalog. One integration therefore reaches a whole class of systems, which is exactly what the unified integrations platform is for.

The CKAN **Action API** is small, uniform and read-mostly: every call is `GET or POST /api/3/action/<name>` and every answer is `{ help, success, result | error }`. Public portals need no authentication; private datasets and all writes need an API token in the `Authorization` header. Tabular files can be loaded into the **DataStore**, which adds `datastore_search` (filters, full text, sort, paging) and, where the portal enables it, read-only SQL.

We tested the API against five live portals and ran a trimmed OpenAPI document through iHub's existing `OpenApiToolRunner`. **It works today**: every read operation, including DataStore queries and SQL aggregations, succeeded through the runner without code changes. Two gaps surfaced (array parameters, response trimming syntax) and a handful of things the planned integration interface has to provide (companion OpenAPI document, envelope unwrapping, declarative Answer Sources, scopes from an action, health probe, `none` auth mode, per-user API keys, one non-API action for reading a file).

**Recommendation:** make CKAN the walking skeleton of the platform. Implement the thinnest vertical slice of #2912 (definition schema), #2913 (`openapi` adapter), #2920 (install wizard from `ConfigField`s), #2921 (app binding) and #2924 (marketplace type `integration`) that lets an admin install *CKAN Open Data Portal* from the IntraFind registry, point it at a portal, bind it to an "Open Data Assistant" app, and let a user ask "Which datasets about Kitas exist in Norderstedt?" with cited answers. Ship it read-only; writes (create, update, delete datasets and resources) are phase 2 behind the approval gate of #2945.

## 1. What CKAN is and who runs it

| Portal | CKAN version | Notes from our probes |
| --- | --- | --- |
| [demo.ckan.org](https://demo.ckan.org) | 2.11.5 | The official demo. 13 public datasets, DataStore extension installed but no indexed resources. Tag list contains spam; fine for API tests, not for a customer demo. |
| [GovData](https://www.govdata.de/ckan) (`ckan.govdata.de`) | 2.10.11 | Germany's national portal, harvests the state portals. DCAT-AP.de profile: formats are URIs (`…/file-type/CSV`), licenses are URIs (`dcat-ap.de/def/licenses/dl-zero-de/2.0`), `extras` carry `spatial_uri`, `issued`, `contributorID`, `publisher_name`. No DataStore. |
| [Open-Data Schleswig-Holstein](https://opendata.schleswig-holstein.de) | 2.11.7 | 33,000 datasets, DCAT-AP.de, `ckanext-dcat`: every dataset is also available as JSON-LD at `/dataset/<name>.jsonld`, the whole catalog at `/catalog.jsonld?page=n`. |
| [open.canada.ca](https://open.canada.ca/data) | 2.10.8 | 48,000 datasets, DataStore active on many resources. |
| [data.boston.gov](https://data.boston.gov) | 2.x | Used for DataStore tests: `datastore_search`, `datastore_info` and `datastore_search_sql` all enabled. |
| [data.europa.eu](https://data.europa.eu) | not CKAN | Offers a CKAN-compatible `package_search` (with facets) under `/api/hub/search/ckan/`, 137,000 results for "Kitas". Nothing else: `package_show`, `organization_list`, `group_list`, `tag_list`, `resource_show`, `datastore_search` and `status_show` return 404 or 500. An instance pointed at it keeps only `search_datasets`; its health check must be `package_search?rows=0`. |

Other CKAN deployments relevant to IntraFind customers: Bavaria (open.bydata.de), Berlin, Hamburg (transparenzportal), Rhineland-Palatinate, NRW, many cities (Bonn, Köln, Leipzig, Dresden), the EU Joint Research Centre, and research data catalogs. Companies also run CKAN as an internal data catalog, which is where private datasets and API tokens matter.

## 2. The API

- **Shape.** `https://<portal>/api/3/action/<action>`. Read actions accept GET with query parameters (lists as repeated parameters or as a JSON list string); every action accepts POST with a JSON body. Always use version `3`.
- **Envelope.** `{ "help": "<docs url>", "success": true, "result": … }` or `{ "success": false, "error": { "__type": "Validation Error" | "Authorization Error" | "Not Found Error", "message": … } }`. HTTP status is 200 on success, 404 for not found, 409 for validation errors, 403 for authorization errors. `help_show?name=<action>` returns the docstring of any action, which is a usable source for model-facing descriptions.
- **Authentication.** Optional. An API token (User › API tokens, or `api_token_create`) goes in the `Authorization` header; the header name is configurable per portal (`apitoken_header_name`), and old portals used `X-CKAN-API-Key`. Permissions equal the web UI: a token sees the user's private datasets and may write where the user may. No OAuth.
- **Read actions we need.** `package_search` (Solr `q`, `fq`, `sort`, `rows` ≤ 1000, `start`, `facet.field`, `facet.limit`, `include_private`), `package_show`, `resource_show`, `resource_search` (`query=field:term`), `organization_list` / `organization_show` (`include_datasets`), `group_list` / `group_show`, `tag_list`, `status_show` (portal title, CKAN version, extensions), `help_show`.
- **DataStore.** `datastore_search` (`resource_id`, `q`, `filters` as JSON object, `fields`, `sort`, `limit` default 100 and max 32,000, `offset`, `distinct`, `records_format` objects | lists | csv | tsv, `include_total`), `datastore_info` (columns, types, row count), `datastore_search_sql` (`sql`, one SELECT, off unless `ckan.datastore.sqlsearch.enabled`; demo.ckan.org does not have it, Boston does), and a dump endpoint `/datastore/dump/<resource_id>?format=csv|tsv|json|xml`. Only resources with `datastore_active: true` have a table.
- **Files.** A resource's `url` is a direct download (uploaded files live under `/dataset/<id>/resource/<id>/download/<file>`); the API does not stream file content. Reading a CSV or PDF means fetching that URL.
- **Writes.** `package_create`, `package_patch` / `package_update`, `package_delete`, `resource_create` (multipart `upload`), `resource_patch`, `resource_delete`, `organization_*`, `member_create`. All need a token.
- **Not in core any more.** The activity stream (`recently_changed_packages_activity_list`) moved to the `activity` extension in 2.10; DCAT export needs `ckanext-dcat`. Treat both as optional capabilities detected from `status_show.extensions`.
- **Limits.** No rate limiting in core; portals behind Cloudflare or nginx may throttle (opendata.swiss returned 403 to our probe without a browser user agent). Responses are large: a `package_search` with 5 results is about 20 KB, dominated by `extras`, `relationships_*`, resource hashes and organization boilerplate.
- **Variance between portals** is the main integration risk: metadata profiles (plain CKAN vs DCAT-AP.de vs Canada's schema), which extensions exist, whether SQL search is on, whether the API sits under a path prefix (`/ckan`, `/data`), and non-CKAN look-alikes (data.europa.eu).

## 3. Use cases and the questions users will ask

| Who | Wants to | Example questions | CKAN actions |
| --- | --- | --- | --- |
| Citizen, journalist, student | find and understand data | "Which datasets about parking does the city publish?" · "Is there data on Kitas in Norderstedt?" · "What does this dataset contain, in plain words?" · "Who publishes traffic data here, and how much?" | `package_search` (+ facets), `package_show`, `organization_list` |
| Analyst, data scientist | assess and access data | "Which license does it have; may I use it commercially?" · "When was it last updated, how often?" · "Which formats exist; give me the CSV link." · "Which columns does the table have?" · "How many active licenses per type?" · "Compare the two datasets on coverage (years, area)." | `package_show` (`license_*`, `metadata_modified`, `extras.temporal_*`, `extras.spatial*`), `resource_show`, `datastore_info`, `datastore_search`, `datastore_search_sql` |
| Data steward, publisher (internal catalog) | curate | "Which of our datasets have no license or no description?" · "List datasets of organization X not updated in two years." · later: "Create a dataset draft from this description", "Add this CSV as a resource" | `package_search` with `fq` and `sort`, `organization_show`; phase 2 writes |
| Developer, integrator | wire data into something | "Give me the API endpoint and the field list for resource Y." · "Which datasets have a GeoJSON or WMS resource?" | `resource_search`, `datastore_info`, `resource_show` |
| iHub itself | ground an answer | answer with citations that link to the dataset page; preview or download a resource from the Answer Sources panel | the integration's `sources` mapping, resource `url` |

Two shapes of app follow from this:

1. **Open Data Assistant** (public portal, no sign-in): the integration is installed with auth `none`, the app binds the read actions, optionally scoped to one publisher. This is the customer's request.
2. **Data Catalog Assistant** (internal CKAN): auth `service-account` or, later, a per-user token (#2929), `includePrivate: true`, curation questions, and in phase 2 writes behind approval.

## 4. Tests

### 4.1 Live API probes (curl, 2026-10-30)

| What | Where | Result |
| --- | --- | --- |
| `status_show` | demo, GovData, SH, Canada | OK; version and extension list returned. data.europa.eu: 404 (not CKAN). |
| `package_search` with `q`, `fq`, `sort`, `rows`, `start`, `fl` | demo, GovData, SH, data.europa.eu | OK. Facets via `facet.field` need a JSON list (`["tags","organization"]`) or repeated parameters; a comma-separated value is a 409 Validation Error. |
| `package_show`, `organization_show?include_datasets=true`, `organization_list?all_fields=true`, `group_list`, `tag_list`, `resource_search?query=format:CSV` | demo | OK. |
| `datastore_search` with `filters`, `fields`, `sort`, `limit`, `q`, `records_format=csv`; `datastore_info`; `datastore_search_sql` with GROUP BY | data.boston.gov | OK. `datastore_search_sql` on demo: "Action name not known" (disabled). |
| Resource download (`/dataset/…/download/dummy_data.csv`) | demo | 200, `application/csv`, 50 bytes. |
| `/datastore/dump/<id>?format=json&limit=5` | Boston | 200, 3.6 KB. |
| DCAT: `/dataset/<name>.jsonld`, `/catalog.jsonld?page=1` | SH | 200 `application/ld+json`. |
| Write without token (`POST package_create`) | demo | `success: false`, `Authorization Error: Access denied`. |
| Bogus `Authorization` / `X-CKAN-API-Key` header on a read | demo | Ignored, read succeeds (anonymous). |
| Metadata profile differences | GovData, SH vs demo | DCAT-AP.de portals: `format` is a URI, `license_id` is a URI, resources carry `access_url`, `download_url`, `license`, `distribution_ref`; `extras` keys differ per portal. |

### 4.2 Through iHub's `OpenApiToolRunner` (unchanged code, `server/services/tools/OpenApiToolRunner.js`)

A 12-operation OpenAPI 3.0 document ([`ckan-openapi.json`](ckan-openapi.json)) was given to the runner as `type: "openapi"` tool definitions (inline source, `baseUrl` per portal, no credential), exactly as an admin could configure today.

| Step | Result |
| --- | --- |
| All 12 tool definitions validate against `openApiToolDefSchema` | pass |
| `getOpenApiToolParameters` derives model-facing JSON schemas (descriptions, enums, defaults, `required`) | pass |
| `package_search` demo, `q=parking` | pass, 0.8 s |
| `package_show`, `organization_list`, `group_list`, `tag_list` demo | pass, 0.3 to 0.5 s each |
| `datastore_search` Boston with `filters={"status":"Active"}`, `fields`, `sort=issued desc`, `limit=3` | pass, 44 rows total, 3 returned with the right columns |
| `datastore_search_sql` Boston, `GROUP BY license_type` | pass, aggregated rows returned |
| `datastore_info` Boston | pass, column list and meta |
| `status_show` GovData, SH, Canada | pass |
| Not-found dataset | runner returns `{ error: true, status: 404, body: { success: false, error: { __type: "Not Found Error" } } }`: the CKAN error body is preserved for the model |
| `facet.field` declared as an array parameter | **fail**, 409: the runner joins arrays with commas, CKAN wants a JSON list or repeated parameters. Workaround used in `ckan-openapi.json`: declare the parameter as a string holding a JSON list. Platform fix: honour OpenAPI `style: form, explode: true` (repeated parameters) in the `openapi` adapter. |
| `xDisplay.hideFields` to trim responses | works only with the `[]` array syntax (`result.results[].extras`); dotted paths without `[]` silently do nothing inside arrays. With 27 hide paths a 5-result search shrinks from 20.7 KB to 12.5 KB. The `help` key and `facets` (duplicate of `search_facets`) should always be dropped. |

Conclusion: CKAN fits the planned `openapi` adapter. Nothing in CKAN needs native code. The differences between portals are configuration, not code.

## 5. The proposed integration

The full draft is [`integration.json`](integration.json). The parts that matter for the interface:

**Identity.** `id: org.ckan/open-data-portal`, `protocol.type: openapi` with the companion document `ckan-openapi.json` in the definition folder (like a skill's companion files); the document's paths are relative to `{baseUrl}{apiPath}`. One definition, installed once per portal (`ckan-govdata`, `ckan-internal`), as #2924 allows. The marketplace package adds `icon.svg` (a neutral open-data icon, see open question 4) and a README; the draft here carries neither.

**Install fields (`ConfigField`, scope `admin`).** `baseUrl` (url, required, `injectAs: urlVariable`, including a path prefix), `apiPath` (advanced, default `/api/3/action`), `tokenHeader` (string with suggestions `Authorization` and `X-CKAN-API-Key`, any header name a portal configures as `apitoken_header_name`), `apiToken` (secret, optional, to the credential store), `defaultFilter` (Solr `fq` applied to every search), `includePrivate`, `datastoreSql` (unlocks the SQL action), `maxRows` (1 to 50, default 10), `metadataProfile` (`ckan` | `dcat-ap-de`). Every enum choice and title carries en and de.

**Enforced defaults.** Install values reach an action through `defaults` with an explicit mode, because the model's arguments must not undo what the admin configured: `fixed` (install value wins, model value dropped: `include_private`, `all_fields`), `cap` (the smaller number wins: `rows` against `maxRows`), `append` (filters are combined: `defaultFilter` AND the model's `fq`), `default` (install value only when the model sent nothing: `sort`, `limit`). Today's `OpenApiToolRunner` applies only OpenAPI schema defaults and sends the model's arguments as they are, so this is adapter work (section 6, item 5).

**Auth modes.** `none` (public portals, the default), `service-account` (one shared token, header injection), `api-key-user` (each user's own token; phase 3, #2929). No OAuth exists in CKAN.

**Actions.** Read, enabled by default: `search_datasets`, `get_dataset`, `get_resource`, `list_organizations`, `get_organization`, `list_groups`, `describe_datastore`, `query_datastore`. Read, off by default: `search_resources`, `list_tags`, `query_datastore_sql` (requires `datastoreSql`), `read_resource_file` (see decision 1). Phase 2, off by default, token required, approval per #2945: `create_dataset` (write), `update_dataset` (write), `add_resource` (write), `delete_dataset` (destructive). Each action carries `sideEffect`, `dataFlow: external`, model guidance, example prompts and a `hideFields` list; the model-facing names are verbs, not CKAN's `package_*` vocabulary.

**Scopes (#3050).** Publishers (organizations) are the natural "where to search" for a portal. The definition points `scopes` at `list_organizations` and applies the pick as `fq=organization:<name>` on `search_datasets` in `append` mode, after the model's arguments. A city administration can thus ship one app per department without one integration per department.

A scope is a search focus, not an access boundary. Access to data is CKAN's job and follows the token (or the absence of one on a public portal); a user who knows a dataset id can call `get_dataset` on it whatever the scope says, exactly as on the portal's website. An admin who wants the focus pinned sets `defaultFilter` on the instance and binds the app with `userMayChange: false`; that fixes what search returns, but direct-id actions can still answer about datasets of other publishers. Hard isolation between publishers inside one app needs ownership checks on every dataset and resource action: `scopes.strict` in iteration 2 makes the adapter check `organization.name` of every `get_dataset` result and resolve the owning dataset of `get_resource`, `describe_datastore` and `query_datastore` before answering. Whether a customer needs that in iteration 1 is open question 5.

**Answer Sources.** Every dataset in a result becomes a source: title, `{baseUrl}/dataset/{name}`, `notes` as snippet; resources become file sources with their `url` for preview and download. Declared in the definition, not coded.

**Health.** `search_datasets` with `rows: 0` (works on every portal and look-alike; `status_show` does not).

**Instructions.** One paragraph of model guidance (dataset, resource, organization, DataStore vocabulary; cite the portal page; never invent download URLs; DCAT-AP.de URIs) in en and de, added to the system prompt when the integration is active, as [03 §6.5a](../2026-10-20%20Unified%20Integrations/03-product-concept.md#65a-action-detail-what-it-does-how-to-use-it-test-it) foresees.

**App binding.** An "Open Data Assistant" app in the marketplace next to the integration:

```jsonc
"integrations": [
  { "id": "ckan-govdata", "actions": ["search_datasets", "get_dataset", "get_resource", "list_organizations", "describe_datastore", "query_datastore"],
    "connection": "none", "scope": { "default": "stadt-norderstedt", "userMayChange": true } }   // userMayChange: false pins the publisher for this app
]
```

## 6. What CKAN asks of the integration interface

These are the generic requirements the first catalog integration exercises. Each maps to an epic sub-issue; the ones marked *new* are not in [04 · Architecture](../2026-10-20%20Unified%20Integrations/04-architecture.md) yet and are proposed here.

| # | Requirement | Where it lands |
| --- | --- | --- |
| 1 | A definition may carry **companion files** (OpenAPI document, icon, README) and the marketplace installs the folder, as it does for skills. | #2924, #2912 |
| 2 | `openapi` adapter: **`baseUrl` and path prefix from an install field** (`injectAs: urlVariable`); header injection of a secret install field; the `none` auth mode. | #2913, #2912 (`auth.modes` gains `none`) |
| 3 | `openapi` adapter: **array parameters** serialized per OpenAPI `style`/`explode` (repeated query parameters), not comma-joined. *new, bug-level* | #2913 |
| 4 | **Response post-processing** declared per action: `hideFields` (document the `[]` syntax), and *new*: an **envelope mapping** (`success`, `result`, `error` paths) so the model sees `result` and a structured error, not `{help, success, result}`. | #2913 |
| 5 | **Action defaults** from install values with an enforcement mode (`fixed`, `cap`, `append`, `default`) so the model cannot undo admin settings (`include_private` fixed, `rows` capped by `maxRows`, `fq` appended to `defaultFilter`); **conditional actions** (`requires: install.datastoreSql`). *new* | #2912, #2913 |
| 6 | **Model-facing action names and descriptions** that differ from the OpenAPI `operationId` and summary, plus `guidance` and `examples` per action. | #2912, #2974 |
| 7 | **Scopes from an action**: `scopes()` of the adapter runs a declared read action and maps its result to `[{id, name}]`; the pick is applied with an enforcement mode like a default; optional `strict` ownership checks on follow-up actions (iteration 2). *new for non-native adapters* | #2913, #3050 |
| 8 | **Declarative Answer Sources** mapping (items path, title, url template, snippet, kind) so a definition produces citations without a producer module. *new* | #2913 (adapter contract), Answer Sources provider for `openapi` |
| 9 | **Health probe as a declared action and arguments**, not `status_show`-style assumptions. *new* | #2920 (test before save), instance health loop |
| 10 | **Install wizard** rendered from the `ConfigField` list above, including enum, secret, number with min/max, boolean, and advanced fields. | #2920 |
| 11 | **App binding** with a subset of actions, a connection mode and a default scope; one picker in the app editor. | #2921 |
| 12 | **Per-user API key** connections for internal catalogs. | #2929 (phase 3) |
| 13 | One **non-API action** (`read_resource_file`: GET a URL with size cap and text extraction). *decision needed* | see below |

Decisions requested:

1. **`read_resource_file`.** Either (a) allow a per-action `request` override inside an `openapi` definition (the `http` adapter's request template reused for one action), or (b) tell the model to use the built-in Web integration's *read page* action, which exists today but is a separate integration the app may not have enabled. Recommendation: (a); it keeps the integration self-contained and the SSRF guard, size cap and content extraction are the same code.
2. **Envelope mapping as a generic adapter feature** versus a CKAN-only normalizer. Recommendation: generic; most RPC-style APIs (JSON-RPC, Jira Agile, many internal services) wrap results the same way.
3. **Walking skeleton versus full Phase 1 first.** Recommendation: skeleton. CKAN needs no OAuth, no token re-index and no migration, so it can exercise definition, adapter, wizard, binding and marketplace type without the risky parts of Phase 1, and the result is a sellable integration.

## 7. Delivery plan

**Iteration 1, the walking skeleton (this issue):**

1. `IntegrationDefinition` and `ConfigField` Zod schemas, `IntegrationRegistry` loading `server/defaults/integrations/` and `contents/integration-definitions/` (subset of #2912; no `Connection` record yet).
2. `OpenApiAdapter` over `OpenApiToolRunner` with items 2 to 5 of the table above; tool ids `<instanceId>__<action>` (subset of #2913).
3. `contents/config/integrations.json` with `InstalledIntegration`, admin routes `GET/POST /api/admin/integrations`, `_test`; install wizard from `ConfigField`s (subset of #2920).
4. `app.integrations[]` binding resolved in `toolLoader.getToolsForApp` next to `app.tools` (subset of #2921; `app.tools` stays until #2915).
5. Marketplace type `integration` with companion files (#2924) and the CKAN definition plus an "Open Data Assistant" app published in `intrafind/ihub-marketplace`.
6. Declarative Answer Sources and scopes for the `openapi` adapter (items 7 and 8), so answers are cited and a publisher can be picked per chat.
7. Docs: `docs/integrations.md` (new, in `SUMMARY.md`) with the CKAN walkthrough; changelog entry.

**Iteration 2:** writes behind #2945 approval (`create_dataset`, `update_dataset`, `add_resource`, `delete_dataset`), `read_resource_file`, DCAT-AP.de normalization of format and license URIs, per-user tokens (#2929).

**Stopgap available now:** the twelve `type: "openapi"` tool definitions from section 4.2 plus an app with `tools: ["ckan_package_search", …]` can be hand-installed on any current iHub. It proves the use case to the customer within a day, but has none of the install, configure, scope and marketplace properties this concept is about.

## 8. Alternatives considered

- **Community MCP servers for CKAN** exist (`ckan-mcp-server` on PyPI at 0.0.1, OpenAscot's multi-portal server, city-specific servers for Toronto and Ontario). They are early-stage Python processes, would run as `mcp-stdio` (which registries may not distribute, per #2924) or need hosting, and add nothing the Action API does not already give over HTTP. Not recommended as the shipped path; a customer who already runs one can add it as an MCP integration.
- **DCAT / JSON-LD** instead of the Action API: cleaner metadata, but only on portals with `ckanext-dcat`, and no search, no DataStore. Could later feed a project (knowledge) through a harvester; out of scope here.
- **Native connector module** (`server/services/integrations/connectors/ckan/`): unnecessary; every behaviour needed is declarative once items 3 to 9 exist, and a declarative definition is what the marketplace can distribute.

## 9. Open questions

1. Which portal is the customer's: public (GovData-harvested state portal, city portal) or an internal CKAN with private datasets? This decides whether `service-account` auth is in iteration 1.
2. Should the `dcat-ap-de` metadata profile normalize `format` and `license` URIs in the adapter (so every portal looks the same to the model) or stay model guidance only? Recommendation: guidance in iteration 1, normalization in iteration 2 after seeing real questions.
3. Does the customer need file content (CSV preview, PDF summary) in iteration 1? If yes, decision 1 above moves forward.
4. Icon: CKAN's logo is trademarked by the Open Knowledge Foundation; use a neutral "open data" icon in the marketplace entry.
5. Does any customer need hard isolation between publishers inside one app (`scopes.strict`, ownership checks on direct-id actions) in iteration 1? The public-portal use case does not; an internal catalog with department-level separation might, although CKAN's own organization permissions and a token per department are the simpler answer.

## Sources

- [ckan.org/features/api](https://ckan.org/features/api), [CKAN 2.11 API guide](https://docs.ckan.org/en/2.11/api/index.html), [DataStore extension](https://docs.ckan.org/en/2.11/maintaining/datastore.html)
- Live probes on 2026-10-30 against demo.ckan.org, ckan.govdata.de, opendata.schleswig-holstein.de, open.canada.ca, data.boston.gov, data.europa.eu
- [`ckan-mcp-server` on PyPI](https://pypi.org/project/ckan-mcp-server/), [OpenAscot CKAN MCP](https://lobehub.com/mcp/openascot-ckan-mcp), [ckanext-openapi](https://ecosystem.ckan.org/extension/ckanext-openapi)
- Unified Integrations concept: [README](../2026-10-20%20Unified%20Integrations/README.md), [03 · Product concept](../2026-10-20%20Unified%20Integrations/03-product-concept.md), [04 · Architecture](../2026-10-20%20Unified%20Integrations/04-architecture.md), [05 · Roadmap](../2026-10-20%20Unified%20Integrations/05-roadmap.md); [third-party-integrations/19-openapi-packages.md](../third-party-integrations/19-openapi-packages.md)
