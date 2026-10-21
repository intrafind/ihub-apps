# Spec 2: Knowledge provider contract and tools

Resolves [#2904](https://github.com/intrafind/ihub-apps/issues/2904) · Part of
[#1036](https://github.com/intrafind/ihub-apps/issues/1036) · Phase 1 implements the local
provider · 2026-10-20

One contract through which chats, agents and workflows reach a project, whichever tier backs it
and whatever kind its items are. iHub builds **no RAG pipeline**: no embeddings, no vector index,
no chunking service, no reranker. The local provider is BM25 over extracted text, which
`server/sources/documentRetrieval.js` already does for the support bot; everything beyond that
is delegated to iFinder (phase 2) or, later, to OpenSearch or Qdrant behind the same contract.

## 1. Shape of the contract

```js
// server/services/knowledge/KnowledgeProvider.js
export class KnowledgeProvider {
  id;                                    // 'local' | 'ifinder' | 'opensearch' | 'qdrant'
  capabilities(project)                  // → { loadAll, iterate, search, passages, preview, write }
  async list(project, ctx, { cursor, limit = 100 } = {})
                                         // → { items: KnowledgeDoc[], nextCursor }
  async search(project, ctx, { query, limit = 8, itemIds, kinds, budgetChars })
                                         // → { hits: KnowledgePassage[], retrieval }
  async read(project, ctx, docRef, { section, maxChars } = {})
                                         // → { doc: KnowledgeDoc, text, retrieval, truncated }
  async loadAll(project, ctx, { itemIds, budgetChars })
                                         // → { docs: [{ doc, text }], tokens, truncatedDocs }
  async put(project, ctx, { name, text, contentType, provenance, pinned })
                                         // → KnowledgeDoc (status ready)
  async remove(project, ctx, docRef)     // → boolean
}
```

`ctx` is `{ user, chatId, language, run: { type, id, nodeId } | null, purpose: 'chat' | 'workflow'
| 'agent' | 'ui' }`. Every call receives the resolved project document; access was decided
before by `projectAccessRequired` or `ProjectScope` (§4.2), never by the provider.

Types shared by every provider (`server/services/knowledge/types.js`):

```js
KnowledgeDoc {
  id,                        // the item id ('itm_…'), or iFinder's document id in phase 2
  projectId, kind, name, status, pinned,
  bytes, chars, tokens,      // of the text; null for link items until fetched
  url,                       // external link when the kind has one (url, page, cloud, iFinder)
  provenance,                // as on the item (spec 1 §3)
  updatedAt
}
KnowledgePassage {
  docId, projectId,
  sectionId, path: ['Title', 'Heading'], part: '2/3',
  text, score, chars
}
docRef = { projectId, itemId }             // what read() and remove() take
retrieval = { mode: 'full' | 'search' | 'section' | 'outline', query?, section?, sections,
              totalSections, totalTokens, returnedTokens }   // today's shape from selectContent
```

Errors are `KnowledgeError(code, message, { projectId, itemId })` with the codes of spec 1 §5.4
plus `NOT_SUPPORTED` (a capability the provider lacks) and `ITEM_NOT_READY`.

Providers are registered in `server/services/knowledge/registry.js`;
`providerFor(project)` returns the one for the project's tier (`ihub` → `local`). An app, a
workflow or an agent never names a provider.

## 2. The local provider

`server/services/knowledge/LocalKnowledgeProvider.js`, capabilities `{ loadAll: true, iterate:
true, search: true, passages: true, preview: 'text', write: true }`.

### 2.1 Text of an item

`ItemTextService.getText(project, item, ctx)` is the one place that turns an item into text:

- `storage: 'text'` → `blobs.get('project-files', item.text.blobKey)`, unwrap the data key with
  the `KeyProvider`, decrypt (spec 3 §6). A per-process LRU (`ITEM_TEXT_CACHE`, 64 entries, 64 MB)
  keyed by `blobKey` holds decrypted text, since a project is read on every turn.
- `storage: 'link'` → the kind's `fetch(item, ctx)` through today's handlers and their TTL
  caches (`URLHandler`, `PageHandler`, `IFinderHandler`); the iFinder cache stays keyed per user.
  A fetch error puts the item under `unavailable` with its code (`SOURCE_FORBIDDEN`,
  `SOURCE_GONE`) and the turn goes on without it; the stored item is **not** changed, because an
  iFinder `403` or `404` is the reading user's, not the project's — another member may still
  have access. Only the refresh of a picked item (spec 3 §4) marks an item `stale`.

`loadAll`, `search` and `read` use every `ready` item and every `stale` item whose snapshot is
still readable (a failed refresh keeps the old text, spec 3 §4); items in any other status, and
items whose text cannot be read, are listed under `unavailable` with the reason in every result,
so the model can say so.

### 2.2 Index

`documentRetrieval.js` grows a second entry point beside `getDocumentIndex(content)`:

```js
buildCorpusIndex(docs: [{ id, name, text }]) → CorpusIndex
   // sections: [{ docId, id, title, level, path, text }], parts, postings, avgLength, …
searchCorpus(index, query, { limit, docIds })   → [{ docId, partIndex, score }]
```

It is the same splitting (headings 1–4, 6 000-char parts, fenced code kept whole), tokenizer,
stemmer and BM25 (k1 1.2, b 0.75, title ×3, path ×1, prefix matches at 0.5) as today, over
several documents, with `docId` on every section instead of the `<!-- Source: file -->` marker
trick. The per-document index stays for `knowledge_read` with a `section`.

The corpus index is cached per process in an LRU of 32 entries keyed by project id plus a
fingerprint (`sha256` of every ready item's `id`, `text.sha256` or link-cache timestamp, and
the reading user for per-user link items). A change to any item evicts it. It is rebuilt from
stored text, never from anything the browser sent, and at 50 items of 20 MB originals (far less
as text) a rebuild is milliseconds, so no persistent index exists.

### 2.3 Operations

- `list` returns the items as `KnowledgeDoc`, `ready` first, then by name; `status` and
  `provenance` included so a workflow can skip what is not usable.
- `search` builds or fetches the corpus index, runs `searchCorpus`, and renders the best parts
  as `KnowledgePassage` up to `limit` (default 8) and `budgetChars` (default
  `RESULT_BUDGET_CHARS`, 40 000, under the 64 KB spill threshold). Short hits bring their
  subsections, as `selectContent` does today. Relative-score cut-off 0.2 stays.
- `read` returns one item's text through `selectContent` with the same `{ section, name,
  budgetChars }` arguments as today's source tools: the whole text when it fits, a section
  subtree by id or title, the outline otherwise.
- `loadAll` returns every ready item's text (or the subset in `itemIds`), the total tokens, and
  which items were cut when `budgetChars` is set.
- `put` runs spec 3 §3.3 (`text` or `bytes` → extract → encrypt → store) with the provenance
  of the writing run and returns the new `KnowledgeDoc`. Quotas apply.
- `remove` deletes the item through `ProjectService` (cascade of spec 1 §9.1 for one item).

## 3. How a kind's fetch feeds the provider

| Kind | What `fetch` returns | When it runs | Stale |
| --- | --- | --- | --- |
| `upload` | never fetched; the text is stored | at upload | never |
| `office365`, `google-drive`, `nextcloud` | `{ bytes, contentType, name, lastModified, url }` through the integration service with the **picking** user's stored token | at pick, and on refresh by an editor with a connected token | refresh sees a newer `lastModified` (marked, old text kept) or `SOURCE_GONE` / `SOURCE_FORBIDDEN` |
| `url`, `page` | `{ text, contentType, url }` through today's handlers, TTL cached | at use, per process | fetch error at use |
| `ifinder-document` | `{ text, url, metadata }` with the **reading** user's JWT, TTL cached per user | at use | `getContent` returns 403/404 for this user (reported in the tool result, item not marked, since another member may still read it) |
| `ifinder-query` | the query's hits as one text, as `IFinderHandler.loadDocumentsByQuery` renders them; an empty `ref.query` takes the model's `query` | at use | as above |

Snapshotted kinds carry `snapshotAt`; the citation card says "text taken 12 Oct 2026" and the
project page offers refresh. Link kinds carry nothing: they are current by construction.

## 4. Tools

### 4.1 Definitions

One tool file, `server/defaults/tools/knowledge.json` (copied into `contents/tools/` by the
migration of spec 1 §10.1), script `knowledge.js`, with three functions that the loader expands
to `knowledge_search`, `knowledge_read` and `knowledge_list`:

```json
{
  "id": "knowledge",
  "name": { "en": "Project knowledge", "de": "Projektwissen" },
  "description": { "en": "Search, list and read the documents of the projects available in this chat" },
  "script": "knowledge.js",
  "enabled": true,
  "functions": {
    "search": {
      "description": { "en": "Search the projects for passages that answer a question. Returns ranked passages with the document and section they come from. Search with the key terms of the question; search again with other terms when the results do not answer it." },
      "parameters": { "type": "object", "properties": {
        "query":   { "type": "string", "description": { "en": "Key terms of the question" } },
        "project": { "type": "string", "description": { "en": "Limit to one project id (see the project list in the tool description)" } },
        "limit":   { "type": "integer", "minimum": 1, "maximum": 20, "default": 8 }
      }, "required": ["query"] }
    },
    "read": {
      "description": { "en": "Read one document in full, or one of its sections, by the document id from a search result or the list." },
      "parameters": { "type": "object", "properties": {
        "document": { "type": "string" },
        "project":  { "type": "string" },
        "section":  { "type": "string", "description": { "en": "Section id or heading; omit for the whole document (the outline is returned when it is too long)" } }
      }, "required": ["document"] }
    },
    "list": {
      "description": { "en": "List the documents of the projects with their id, name, kind, size and status." },
      "parameters": { "type": "object", "properties": {
        "project": { "type": "string" }
      } }
    }
  }
}
```

The tools are **added automatically** by `getToolsForApp` (next to the websearch tools) when
the request has any project in scope whose effective mode is `tools` (§6); they are never
listed in an app's `tools` array, and `isToolSelected` cannot select them. Per request the
loader rewrites the `description` of each function to append the scope: `Projects available:
faq ("FAQ", 3 documents, loaded in full), ihub-documentation ("iHub Documentation", 1 document,
search it)`, so the model knows which ids `project` accepts and which projects it already has
in context.

### 4.2 Scope and dispatch

`server/tools/knowledge.js` exports `search`, `read` and `list`. Each receives the merged
params `{ ...args, user, chatId, appConfig, language }` and resolves the **scope** with
`ProjectScope.fromRequest({ appConfig, user })`:

```
scope = [ { project, mode, write } ]  built from
  appConfig.projects                      (admin pinning, spec 1 §6.1)
  appConfig._projectId                    (container, injected by RequestBuilder from the chat)
  appConfig._attachedProjectIds           (chat-input picker, injected the same way)
  appConfig._workflowProjects             (workflow / node / profile projects, injected by the executors)
each resolved through ProjectRepository and filtered by projectAccess('use') for `user`
```

`project` omitted → the call runs across every project in scope whose mode is `tools`; hits
are ranked together (one corpus index per project, merged by score) and each hit carries its
project id. `project` given → that project only, `PROJECT_NOT_FOUND` when it is not in scope.
A tool call never widens the scope: the model cannot name a project the request did not bring.

Dispatch: `runTool` keeps no prefix branch; `knowledge` is an ordinary script tool. The
`source_` branch in `runTool`, `SourceManager.createSourceTool` and the global source tool
registry are deleted.

### 4.3 Results

```js
// knowledge_search
{ hits: [{ n: 1, document: 'itm_k3Fq', project: 'prj_…', name: 'Mietvertrag.pdf',
           section: 'kuendigung', path: 'Mietvertrag › § 12 Kündigung', part: '1/1',
           text: '…', score: 7.3 }],
  unavailable: [{ document, name, reason: 'extracting' | 'failed' | 'stale' | 'SOURCE_FORBIDDEN' }],
  retrieval: { mode: 'search', query, totalSections, returnedTokens },
  sources: [ /* Source envelope, §5 */ ] }

// knowledge_read
{ document, project, name, content: '<section id=… path=… part=…>…</section>',
  retrieval: { mode: 'full' | 'section' | 'outline', … }, sources: [ /* one */ ] }

// knowledge_list
{ projects: [{ id, name, mode, documents: [{ id, name, kind, status, pinned, tokens, chars, provenance: { origin, by, at }, url }] }] }
```

Classification: `knowledgeSourceSeam.classifyKnowledgeSource` maps the `knowledge_` prefix to
`'sources'` before its `includes('search')` check, so the answer badge reads *Projects*, not
*Web search*; `toolClassify`, `shared/run/toolActivity.js` (`toolKind: 'search'`, scope
`'documents'`), `producers/web.js` (exclusion list) and `McpServerService` (not exported over
MCP) get the same prefix where they had `source_`.

## 5. Mapping onto the `Source` model (#2637)

Every hit and every read becomes a `Source` through a registered producer
(`registerSourceProducer({ id: 'project', matches: ({ toolId }) => toolId === 'knowledge_search'
|| toolId === 'knowledge_read', fromToolResult })` — `knowledge_list` carries no sources), so the panel, inline numbering, storage and sharing need no project code:

```js
{
  provider: 'project',
  kind: 'document',
  ref: { id: item.id, scope: project.id },     // content and metadata actions, §5.1
  id: item.id,
  title: item.name,
  site: project.name,                          // "Case 2026-114"
  url: item.url,                               // picked: opens in OneDrive/SharePoint/Drive/Nextcloud;
                                               // url/page: the page; iFinder: the deep link; upload: none
  fileName: item.name, type: 'PDF',
  snippet: hit.text.slice(0, 400),
  passages: [{ text: hit.text, marker: 's:1' }],   // up to 10, one per hit of the same item
  private: true,
  provenance: { origin: 'picked', kind: 'office365', at: item.snapshotAt }
}
```

`provenance` is a **new optional field on `SourceInput`** (`shared/sources/source.js`):
`{ origin: 'uploaded' | 'picked' | 'linked' | 'written', kind?, at? }`, kept by
`normalizeSource` and `mergeSource`. The card renders it as the chip the epic asks for:
*Uploaded*, *Picked from SharePoint · text taken 12 Oct 2026*, *Linked*. `written` renders as
*Uploaded* with the run in the details dialog. Web and iFinder sources carry no provenance and
render as today.

`private: true` on every project source: it was found with the caller's membership, so chat
shares drop it (as `shareableSourceSet` already does for anything with a `ref`). The answer
text keeps its citations.

`resolveCitations` numbers project sources like every other: `[n]` links are not possible for
uploads (no URL), so the model is told to cite with the hit number in square brackets and the
`s:N` passage markers map to the right card. The shipped support bot prompt says so.

### 5.1 Content and metadata actions

`registerSourceProvider({ id: 'project', content, metadata })`
(`server/services/sources/providers/project.js`):

- `content({ ref, user, format })`: `use` access on `ref.scope` is checked for `user`;
  `format=text` streams the item's text (`text/plain`, `fileName` = item name + `.txt`), which
  gives **Download** for free; `format=original` or `pdf` answers `410 ORIGINAL_DISCARDED` for
  text items (the client falls back to the text preview) and redirects link kinds to their
  source (`url`, `page`, the iFinder provider's own content action for iFinder items).
- `metadata({ ref, user })`: name, kind, status, provenance, `snapshotAt`, chars, tokens, url.

`DocumentPreviewModal` gains a text mode: when `format=pdf` answers `ORIGINAL_DISCARDED` it
shows the text with the hit passages highlighted (`PdfPassageViewer` has a sibling
`TextPassageViewer`). A picked cloud document's **Open** action goes to `url`, the source
system, with the member's own rights there.

## 6. Load-all versus search

Decided per request, per project in scope, by `KnowledgeScopePlanner.plan(scope, model)`:

```
budgetTokens = min(platform.projects.loadAllMaxTokens (50 000), floor(model.contextWindow × 0.4))
for each project in scope, with its link mode:
  context → inject every ready item                                   effective: 'loaded'
  tools   → inject pinned items only; offer the tools                 effective: 'searched'
  auto    → tokens(ready items) ≤ remaining budget → inject all       effective: 'loaded'
            otherwise → inject pinned items, offer the tools          effective: 'searched'
  remaining budget decreases by what was injected; projects are planned in scope order
  (container, admin links, attachments)
pinned items are always injected, in every mode, ahead of everything else; when pinned text
alone exceeds the load-all budget the plan still injects it and flags `overBudget`, but never
past the hard limit of 75 % of the model's context window: beyond it the remaining pinned text
is cut (the cut items are listed as `cut` on the plan and in the scope event, and stay
reachable through `knowledge_read`)
```

The injected block replaces `{{projects}}` in the system prompt (`PromptService`, and the
workflow prompt node with a function replacer so `$` stays literal), or is appended as
`\n\n<projects>…</projects>` when the placeholder is absent, exactly where `{{sources}}` was:

```xml
<projects>
  <project id="faq" name="FAQ" mode="loaded">
    <document id="itm_…" name="faq.md" origin="uploaded">…text…</document>
  </project>
  <project id="ihub-documentation" name="iHub Documentation" mode="searched" documents="1" tool="knowledge_search"/>
</projects>
```

`<project-instructions>` of the container (spec 1 §6.3) goes before this block.

The plan is reported to the client as the SSE event `knowledge/scope { projects: [{ id, name,
mode: 'loaded' | 'searched', documents, tokens, pinned, overBudget }] }` on the run ledger
(replayed on re-sync like `sources/added`), stored on the answer as `knowledge`, and shown as
the badge the epic asks for: *3 projects · 2 loaded in full · 1 searched*. The existing
answer-source badge (`promptSources` → `'sources'`) is replaced by this event.

## 7. Prompt injection: the placeholder

`{{sources}}` and `{{source}}` are renamed to `{{projects}}` (one placeholder; the legacy
singular is dropped). The migration rewrites shipped and customised prompts (spec 1 §10.1 step
3), the workflow editor's placeholder hints list `projects`, and the admin app editor shows the
same hint beside the project picker. The XML tag names are `<projects>`, `<project>`,
`<document>`: "source" now means an answer citation everywhere in the product.

## 8. Workflows and agents: iterate and write back

- **Prompt, planner and verifier nodes** get the tools and the injected block from their
  `projects` (node over workflow, spec 1 §6.2), through the same planner (§6) with the node's
  model. `PlannerNodeExecutor` keeps its catalog idea: `taskTemplate.projects` is the planner's
  enum of project ids.
- **`project-items` node** (new type): `config: { project: '$.input.project' | 'prj_…',
  filter: { kinds?, status: ['ready'], pinned? }, outputVariable }` writes `KnowledgeDoc[]` into
  the state so the existing `loop` node iterates it one document per step, each step calling
  `knowledge_read` (or the `project-read` convenience below) with `$.item.id`.
- **`project-read` node**: `config: { project, document: '$.item.id', section?, outputVariable }`
  → `{ text, doc, retrieval }`, so a loop body can be a transform plus a prompt node without a
  tool call.
- **`project-write` node**: `config: { project, name: 'Memo {{item.name}}', text: '$.data.memo',
  contentType: 'text/markdown', pinned: false, outputVariable }` → `put` with provenance
  `{ origin: 'written', run: { type: 'workflow', id: executionId, nodeId } }`. Allowed when the
  running user is editor or owner of a user project, or when the link on the workflow has
  `write: true` for an admin project.
- **Agents**: the profile's `projects` reach every generated prompt node; an agent writes
  through `project-write` in its generated workflow or through a `knowledge_write` function
  that is deliberately **not** in phase 1 (writes from a chat tool call would need an approval
  seam; workflows have explicit nodes instead).
- **Workflow input** of type `project` (spec 1 §6.2) is how the law-consultation workflow gets
  "one project per case".

The MCP gateway resource adapter lists `ihub://project/<id>` for the projects visible through
the caller's apps, and reads them through `loadAll` (mode `context`) or returns the document
list with a hint to the tools.

## 9. Other providers behind the same contract

| Provider | `list` | `search` | `read` | `loadAll` | `put` | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `local` (phase 1) | items | BM25 corpus | `selectContent` | yes | encrypt and store | this spec |
| `ifinder` (phase 2, #2908) | smart collection documents (`fi_smartcollections` API) | search service with `search.smart-collection-id`, or the retrieval API once TCC-1742 is fixed, with the reading user's JWT; passages from iFinder | `getContent` | `NOT_SUPPORTED` (`capabilities.loadAll: false`) | push indexer API of #2907 | picked cloud documents are pushed as copies, or referenced when iFinder indexes the site |
| `opensearch`, `qdrant` (later) | index query by project id | the engine's query (BM25 or kNN) over a text field, the shape of Dify's External Knowledge API: `POST /retrieval { knowledge_id, query, retrieval_setting: { top_k, score_threshold } } → records[{ content, score, title, metadata }]` | stored document text | no | index a document | iHub still stores the text blob; the engine holds the index |

What every provider must give: `list` and `search` (required in both tiers), `read`,
`capabilities`. `loadAll` and `put` are optional and announced.

## 10. Decisions a reviewer may want to challenge

1. **Static tool definition, runtime scope** instead of per-app closures in a global registry
   (today's `source_<id>` pattern): one tool file admins can read and localize, no process-local
   state a second worker lacks, and the `project` parameter replaces one tool per project.
2. **Search across all projects in scope by default.** The alternative (require `project`)
   costs a tool call per project; the scope text in the description keeps the model informed.
3. **`provenance` as a new `Source` field** rather than overloading `markers` or `site`: the
   chip must survive `mergeSource` and storage, and later integrations (Jira, Confluence) carry
   their own origin.
4. **Budget rule `min(loadAllMaxTokens, 0.4 × contextWindow)`.** Simple and visible; the
   compaction threshold is 0.5, so a fully loaded project leaves room for the conversation.
5. **No `knowledge_write` chat tool in phase 1.** Writing into a shared project from a chat
   turn needs the approval seam; workflows have an explicit node, which is the epic's use case.
