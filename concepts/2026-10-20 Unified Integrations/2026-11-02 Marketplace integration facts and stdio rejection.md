# Marketplace integration facts and stdio rejection at catalog load

Implementation note for the two last gaps of issue #2924 (marketplace item type `integration`).
Product source: [03 · Product concept](03-product-concept.md) §8 ("Card facts, always the same
four") and [04 · Architecture](04-architecture.md) §6 ("stdio only from shipped or admin-written
definitions, never from registries").

## What was missing

1. A registry item whose definition is an MCP server over `stdio` was refused only at install
   (`IntegrationRegistry._validateForInstall`). The catalog still listed it, and nothing was
   logged when the catalog was loaded.
2. The marketplace card and detail of an integration showed nothing about the definition: no
   sign-in, effect, where it runs, action count, no actions.

## Where the data comes from

A catalog item (`server/validators/catalogSchema.js`) carries only `name`, `version`,
`compatibility`, `releases`, `migrations` and `source`. It does **not** carry the definition's
protocol, auth or actions. So the server fetches the definition (`integration.json`) of every
integration item when the catalog is loaded and derives a small `facts` summary from it. The
registry file format is unchanged; a `facts` field a registry writes is dropped.

## Flow

```
RegistryService.fetchCatalog(registry)          (refresh and "Test connection")
  └─ validateCatalog(...)                         (unchanged, lenient on failure)
  └─ screenCatalogItems(catalog, registry, auth)  (new, 4 definitions at a time)
       per integration item:
         fetchContent(resolveItemUrl(item.source)) → raw integration.json
         registryProtocolRefusal(definition)       → reason → item dropped + logger.warn
         definitionFacts(definition)                → item.facts
         fetch failed / not JSON                    → item.facts = null (kept)
  → written to the registry's cache file as before

getAllItems()      → item.facts without `actions` (cards)
getItemDetail()    → item.facts with `actions`; a catalog cached before this change derives
                     the facts from the content preview (which is the definition)
```

The install path calls the same `registryProtocolRefusal` (defence in depth: a catalog cached
before the check, or a definition changed between refresh and install).

## Files

| File | Role |
| ---- | ---- |
| `server/services/integrations/definitions/registryItems.js` | **Pure.** `registryProtocolRefusal(definition)` (MCP without fixed remote transport → reason), `definitionFacts(definition)` (authModes, effect, runs, actionCount, actions, protocol) |
| `server/services/integrations/definitions/IntegrationRegistry.js` | `_validateForInstall` uses `registryProtocolRefusal` |
| `server/services/marketplace/RegistryService.js` | `screenCatalogItem(s)`, `listFacts`, the `facts` in `getAllItems` / `getItemDetail` |
| `client/src/features/admin/components/marketplace/integrationItemFacts.js` | **Pure.** `integrationFactRows(facts, t)` (four label/value rows), `sideEffectTone`, `actionTitle` |
| `client/src/features/admin/components/marketplace/MarketplaceIntegrationFacts.jsx` | `MarketplaceIntegrationFacts` (the `<dl>` on the card) and the default `MarketplaceIntegrationSection` (facts + action list with the shared `Badge`) for the detail |
| `MarketplaceItemCard.jsx`, `MarketplaceItemDetail.jsx` | Render the above for `type === 'integration'`; the detail only inside its overview tab body |
| `shared/i18n/{en,de}.json` | `admin.marketplace.integrationFacts.*`; reuses `admin.integrationCatalog.facts.*`, `authModes.short.*`, `sideEffect.*` |

## Fact rules

- **Sign-in:** `auth.modes`, shown with the short labels of Admin → Integrations.
- **Effect:** `read-write` when any action is `write` or `destructive`; `read` when every action is
  `read`; otherwise `unknown` (no declared actions, or one without a side effect).
- **Where it runs:** the definition's `runs` (`cloud`, `on-prem`, `local`), else null.
- **Actions:** the number of declared actions; `null` for `mcp` and `a2a` without declared actions
  (the system lists them at runtime), shown as "listed by the server".

## Tests

- `server/tests/RegistryService.integrationItems.test.js` (in `npm run test:marketplace`): a
  registry with a good item, a stdio item, a `script` item and an unreachable one; only the stdio
  item is dropped and logged; facts in list and detail; the pure helpers.
- `tests/unit/client/marketplace-integration-facts.test.jsx`: card and detail render the facts and
  actions from the real `en.json`; the new keys exist in `de.json`.

## Open points / how to continue

- An old cache file (written before this change) can still list a stdio item until the registry is
  refreshed; install refuses it. A refresh fixes the listing.
- A definition that cannot be fetched keeps its item (with `facts: null`) rather than hiding it on
  a network error. If product wants such items hidden, change `screenCatalogItem` to return null.
- A refresh now makes one extra request per integration item. If a registry lists hundreds,
  consider asking publishers to copy the facts into the catalog (a catalog format change, needs a
  decision) instead of fetching.
