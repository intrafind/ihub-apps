# Integration Scope Labels on Sources (#3056)

Part of #2911, follow-up of #3050 (per-chat scopes). Status: implemented on
`claude/exciting-feynman-2aju98-scope-sources`.

## What it does

The Sources panel under an answer says where each document was found:

- every iFinder card shows the search profile's display name ("Contracts"), or its id when the
  name is unknown;
- the panel header says where the answer searched ("Searched in Contracts") or whom it asked
  ("Asked HR assistant");
- when the sources span several profiles (iAssistant over all profiles, several searches), a row
  of filter chips shows one profile at a time;
- everything is stored with the answer, so a reopened chat shows the same labels.

## Data model (shared/sources)

Two additions to the Sources contract, both optional:

| Where | Field | Meaning |
|---|---|---|
| Source | `scopeName` | Display name of `ref.scope`. Kept only beside a `ref.scope`; after a merge it always names the scope the merged source keeps (`mergeSource` → `scopeNameOf`). |
| Source set / frame | `scopes[]` | `{ integrationId, id, name?, action? }`. `name` is a string or `{ en, de }`; `action` is `search` or `ask`. Folded once per `integrationId + id` (a later sighting may add the name), at most `MAX_SCOPES`. Present only when non-empty. |

`ref.scope` is unchanged: it stays the handle `GET /api/sources/ifinder/content|metadata` needs.

`storedSourceSet` keeps `scopes`; `shareableSourceSet` drops them (they name the owner's private
profiles and assistants). `finalizeSourceFrame` and `boundStoredSources` pass them through.

## Who fills it

| Producer | `scopeName` | `scopes` |
|---|---|---|
| `iFinder_search` (`producers/ifinder.js`) | from the result's `searchProfileName`, else the profile id | `{ integrationId: 'ifinder', id: <profile>, name, action: 'search' }`, also for zero hits |
| `iFinder_getContent` / `iFinder_getMetadata` | same | none (a read is no search) |
| iAssistant stream (`adapters/iassistant-conversation.js`) | per document: the ACCESS link's profile, else the conversation's, named from the user's profile list | `describeAnswerScope(...)`: `{ integrationId: 'iassistant', id: 'assistant:<id>' \| 'all' \| 'configured', name, action: 'ask' }` |
| iAssistant history route (`conversationRoutes.js`) | same names | none |

Where the names come from:

- `searchProfileNames()` in `scopes/iFinderScopes.js` reads `iFinderSearchProfiles` (the same
  per-user, cached list the scope picker uses). It never rejects; an unreadable list gives an empty
  map and the ids show.
- `tools/iFinder.js` reads the names *beside* the iFinder call (`Promise.all`), so it adds no wait,
  and adds `searchProfileName` to the result.
- The iAssistant adapter reads names lazily (`_nameSources`, memoized with `once`), only when the
  first documents arrive; a turn without documents makes no extra request.
- `describeAnswerScope()` in `scopes/iAssistantScopes.js` uses `listScopes` (cached assistants
  list) and falls back to the id (`assistant:x` → `x`, `all` → "All my search profiles").

## UI (client)

- Pure helpers in `client/src/features/chat/sources/sourcesView.js`: `scopeLabelOf`,
  `sourceScopesOf`, `matchesScope`, `answerScopeLabel`.
- `AnswerSources.jsx`: label pill on `SourceCard`, scope lines in the panel header,
  `ScopeFilter` (toggle buttons with `aria-pressed`) when more than one scope.
- i18n keys `sources.foundIn`, `sources.searchedIn`, `sources.asked`, `sources.scopeFilter`,
  `sources.scopeFilterAll`, `sources.noneCitedInScope` (en/de in `shared/i18n/`).

## Adding another store (SharePoint, enaio, …)

1. Register a scope provider (`server/services/integrations/scopes/`).
2. In its source producer, set `ref: { id, scope }` and `scopeName` on every source, and
   `scopes: [{ integrationId, id, name, action }]` on the frame where it searched.
3. Nothing else: the panel, storage and filter read the generic fields.

## Tests

- `server/tests/loop/sourceModel.test.js` — contract (`scopeName`, `scopes`, store/share/bound).
- `server/tests/iFinderSources.test.js` — producer, iAssistant over all profiles, history route.
- `server/tests/integrationScopes.test.js` — tool adds `searchProfileName`, `describeAnswerScope`.
- `server/tests/iassistantConversationWire.test.js` — lazy naming in the stream.
- `tests/unit/client/answer-sources.test.jsx` — card label, header, filter, reopened chat.

Run: `npm run test:ifinder`, `npm run test:loop`, `npm run test:chat`,
`npx jest --config tests/config/jest.config.js tests/unit/client/answer-sources.test.jsx`.

## Open points

- Answers stored before this change have no labels; there is no backfill (none needed: no config
  shape changed, so no migration).
- The cited list at the end of the answer (`CitedSources`) shows no scope label; only the panel
  does.
