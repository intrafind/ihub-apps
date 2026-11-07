# Models and providers in one admin area

Follows #3357 (timeouts per provider). Builds on that PR's branch.

## Why

Web search engines, cloud storage, people directories and tools are integrations now. What is left under
**Providers** is one thing: the connections to model endpoints (OpenAI, Google, a T-Systems LLM Hub, a vLLM
server, the iFinder Model Gateway). Those are not a separate product area. They are the first half of one job:
*make models available to apps*.

Today an admin does that job on two unrelated pages:

| Admin wants to…                              | Today                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| Connect a new AI service                      | Providers → Create (a form that still asks for a "Category", incl. "Custom / Generic API Keys") → key → back to Models → Import from URL → pick the provider again |
| Know why a model fails                        | Models list shows `provider` as a raw API-type string (`openai`) and a key badge; the health test lives on the other page |
| See what a provider offers                    | Providers page, "3 linked, 2 enabled", names truncated; no way to open those models filtered |
| Raise a timeout for all Gemini models         | Providers page (new in #3357) or each model                                              |
| Start on a fresh install                      | Models page "Get started" panel with two buttons; says nothing about keys or the default model |

## Jobs to be done

1. **Connect** a service: pick or describe the endpoint, give it a key, see that it works.
2. **Stock** it: import or create the models it serves.
3. **Release** models: enable what users may pick, choose the default.
4. **Operate**: see at a glance what is broken (key missing, endpoint down, model disabled), fix it where you are.
5. **Tune**: timeouts, limits, hints, per provider and per model.

Every job starts from the same list of things and moves between provider and model. So: one area, two views of
the same objects, each one click from the other.

## Decisions

### 1. One sidebar entry, two tabs

```
AI Workspace
  Apps
  Models        ← one entry; active for /admin/models* and /admin/providers*
  Prompts …
```

The page has a header and a tab bar, like **OAuth** and **Integrations** already do (`AdminTabs`, one route per
tab, each tab deep-linkable):

```
Models                                                    [＋ Add model] [Import models] [⋮]
Connect AI providers and choose the models your apps can use     ← the tab's primary actions

 [ Models  14 ]  [ Providers  5 ]
 ─────────────────────────────────
```

The primary actions of the open tab sit beside the title (not on the filter row, where they wrapped).

URLs do not change: `/admin/models`, `/admin/providers`, `/admin/providers/new`, `/admin/providers/:id`. No
redirects, no new top-level route, bookmarks and audit-log links keep working. The sidebar's separate
**Providers** item goes away. The existing `adminPages.providers` permission still decides whether the
**Providers** tab is shown.

### 2. Models tab: a catalog you can operate

```
┌ Setup ───────────────────────────────────────────────────────────── (only until done) ┐
│ ① Connect a provider  ✓      ② Enable models  ● 2 enabled      ③ Choose a default  ○   │
│                                                              [Choose default model →]   │
└────────────────────────────────────────────────────────────────────────────────────────┘

[🔍 Search models…]  [All providers ▾]  [All types ▾]  [All models ▾]

 Model                    Provider                      API key       Status
 GPT-5                    OpenAI                        ✓ stored      ● Enabled  Default
 Gemini 3 Pro             Google  ⏱ own timeouts        ✓ env         ● Enabled
 gpt-oss-120b             T-Systems LLM Hub ↗           ✓ provider    ○ Disabled
```

- **Setup strip:** derived from real state, no stored flag. ① a provider has a key, or a model is enabled
  (the shipped local provider needs no key, so "keyless" alone must not make a fresh install look half done),
  ② at least one model is enabled, ③ an enabled default model exists. Each unfinished step has the one action that
  completes it. It disappears once all three are true. It replaces the "Get started" panel, which only knew
  the number of models.
- **Provider column** shows the provider's *name* (a custom provider's name, `Google`, …), linking to its
  detail page, instead of the raw API type. Models that use no provider entry (iAssistant, realtime speech
  backends) show their type.
- **Filters:** Provider, Type (chat, transcription, text-to-speech, … taken from the data), Status. All three
  live in the URL (`?provider=google&type=chat&status=enabled`), so the Providers tab can link to "its models".
- **Actions:** the header had five equal buttons. Now **Add model** is the primary, **Import models** the
  secondary; **Upload config**, **Enable all**, **Disable all** move into a **⋯** menu (they are rare and
  Disable all is destructive).
- Row actions, test results, details popup, clone/download/delete: unchanged.

### 3. Providers tab: connections with health

```
Models                                                              [Test all] [＋ Add provider]
[🔍 Search providers…]

▸ Timeouts for all providers   connect 30 s · stream idle 60 s                        [Edit]

 Provider                        API key        Models                 Connectivity     Actions
 OpenAI   openai · OpenAI        ✓ stored       4 linked, 4 enabled →  ● All OK          Test  Import  Configure
 Google ⏱ google · Google        ✓ env          3 linked, 3 enabled →  ● All OK          Test  Import  Configure
 LLM Hub  llmhub · OpenAI API    ✓ stored       40 linked, 12 enabled →○ Not tested      Test  Import  Configure  Delete

▸ Other credentials (2)  ← only if legacy non-LLM entries exist
```

- **Columns:** Description and Status are gone. The description is a tooltip on the name; the status was
  always "Enabled" (the switch on the provider page is fixed), so only a disabled provider is tagged.
- **Models → link** opens the Models tab filtered by that provider.
- **⏱** marks a provider that overrides the timeouts.
- **Timeouts for all providers** (from #3357) collapses to one summary line so it no longer sits on top of
  the list; **Edit** expands the two fields.
- **Only model providers are listed.** The "Cloud Storage" and "Custom / Generic API Keys" groups are gone
  from the main view. An installation that still has such entries keeps them reachable under a collapsed
  **Other credentials** group, so nothing silently disappears. **Add provider** no longer asks for a category:
  it always creates an LLM provider. (The API still accepts the old categories; this is a UI-only decision.)
- New row action **Import** opens the existing import dialog preset to that provider.

### 4. Provider detail: connection, tuning, models in one place

Sections, top to bottom: **Connection** (name, ID, API type, base URL, gateway, key) → **Timeouts** → **Linked
models** (with **Add model**, **Import models**, **Sync with gateway**). **Add model** opens the model editor
with this provider already chosen. The breadcrumb reads *Admin › Models › Providers › Name*; **Back** returns
to the Providers tab.

### 5. What does not change

Server routes, data files, the model editor, the import and sync dialogs, API-key resolution, permissions.
No migration, no compatibility shim. This is a client reorganisation.

## Accessibility

Tabs use the existing `AdminTabs` (WAI-ARIA tabs, arrow keys). Each tab is a route, so the page title and
heading change with it. The **⋯** menu is a button with `aria-haspopup="menu"`, `aria-expanded`, `role="menu"` /
`menuitem`, Escape closes and returns focus. Setup steps are an ordered list with the state in text, not only
colour. Filters are labelled selects.

## Out of scope

Changing which groups may use a model, per-model usage charts, a model/provider "catalog" of known vendors with
logos, merging the two edit pages.
