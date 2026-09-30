# Answer Sources: What an Integration Found

Web search, iFinder, iAssistant, and any other tool, MCP server or integration can tell the user
"I have found this for you" in one way. Whatever finds something reports it as **sources**. The
chat lists every source in one **Sources** panel under the answer, turns every citation into the
same numbered badge, and offers each source the actions its data allows. It stores the sources
with the answer and leaves out of a share whatever was found with the user's own permissions.

> Not to be confused with [knowledge sources](sources.md) (`sources.json`), the documents and
> websites an app can *search*. Answer sources are what a turn *found*.

Design and background: `concepts/unified-sources/2026-09-30 Answer Sources.md`, issue
[intrafind/ihub-apps#2637](https://github.com/intrafind/ihub-apps/issues/2637).

## What users see

- Under every answer that searched or found something: **Searched for “…”**, **N searches** or
  **N sources**, with the sources' icons. It opens the **Sources** panel, a side panel on desktop
  and a bottom sheet on phones.
- The panel lists what the answer cites under **Cited in this answer**, numbered like its inline
  badges, and everything else it found under **Also considered**. Web pages, documents and records
  share one card design: the site or system they come from, the title, an excerpt or cited passage,
  the date, and whether the page or document was read.
- Each citation in the text is a numbered badge. This covers links to a source (`[n](url)`, a
  document's deep link) and iAssistant's `<cite>` markers alike. Hover or focus highlights the
  paragraph and its card. A click opens the panel on that card.
- Each card offers the actions its data allows. A click on the title opens the link.

| Action | Offered when the source has | Runs |
|---|---|---|
| Open (the title) | a `url` | in the user's browser; through Office in the Outlook task pane |
| Copy link | a `url` | clipboard |
| Preview (PDF) | a `ref` | the provider's PDF rendition, with the source's passages highlighted |
| Download | a `ref` | the provider's file |
| Add to email | a `ref`, in the Outlook task pane | the file, attached to the mail being written |
| Open in App | a `ref`, where the page can open another app | a new chat of the chosen app, with the file attached |
| Details | a `ref` | the provider's metadata |

## The model

A source (`shared/sources/source.js`):

| Field | Meaning |
|---|---|
| `id` | identity within the answer, computed: `provider:ref.id`, else `provider:id`, else `url:<normalized url>` |
| `provider` | the system the source lives in (`web`, `ifinder`, a tool or integration id, `mcp:<server>`); it decides the actions |
| `kind` | `page` (web page), `document` (file in a document system), `item` (record: ticket, person, row) |
| `title`, `url`, `site`, `favicon`, `snippet`, `publishedDate`, `fileName`, `type` | display fields; `url` and `favicon` are http(s) only, `snippet` loses any markup |
| `passages[]` | `{ text, marker? }`: cited or retrieved passages |
| `ref` | `{ id, scope? }`: the handle the provider's content actions use (iFinder: document id and search profile) |
| `read` | `{ ok, words?, truncated? }`: a read of the page or document |
| `cited` | the provider reports that the answer relies on it |
| `markers[]` | provider inline markers pointing at it (iAssistant `r:3`; passages carry `s:7`) |
| `private` | found with the user's own permissions or network; a share never carries it |

An answer's sources are `{ items, queries }`: the sources, merged by `id`, in the order they were
first found, plus what was searched for. The same `mergeSources` folds them on the server, for the
stored answer, and on the client, for the live panel. `resolveCitations(markdown, sources)` numbers
the sources in the order the answer first cites them.

## How an integration returns results

None of the three ways needs code in the chat or the panel. The loop asks for a tool call's
sources after every call (`services/sources/index.js`). The first way that applies wins.

### 1. Declare a mapping in the tool definition (no code)

For a tool whose result does not speak the contract, for example an OpenAPI tool, add `sources`
to its definition in `contents/tools/<id>.json`. It can go on the whole tool, or on one function
(`functions.<name>.sources`, which wins):

```json
"sources": {
  "provider": "jira",
  "kind": "item",
  "list": "issues",
  "fields": {
    "id": "key",
    "title": "fields.summary",
    "url": "browseUrl",
    "snippet": "fields.status.name",
    "publishedDate": "fields.updated"
  },
  "query": "jql",
  "public": false
}
```

| Key | Meaning |
|---|---|
| `provider` | the system the hits live in (default: the tool id) |
| `kind` | `page`, `document` or `item` |
| `list` | path to the hits in the result; without it, the result itself (an array of hits, or one hit) |
| `fields` | path per source field inside a hit: `id`, `title`, `url`, `site`, `snippet`, `publishedDate`, `fileName`, `type`, `favicon` |
| `ref` | `{ "id": "<path>", "scope": "<path>" }`: only for a provider registered on the server (see [Actions](#actions-source-providers)) |
| `query` | the argument that holds what was searched for; shown as **Searched for “…”** |
| `public` | whether a share may show the hits (default `false`) |

Paths are dot-separated (`fields.summary`, `items.0.url`). A key that contains dots itself
(`accessInfo.deepLink`) is matched whole first. An invalid declaration is logged once and ignored.

A tool that returns iFinder document ids can declare `"provider": "ifinder"` with a `ref`. Its hits
then get Preview, Download, Add to email, Open in App and Details like any iFinder document.

### 2. Report sources in the result

Any tool can put a `sources` array next to its own data. So can a script tool, an app invoked as a
tool (which does this for its caller), or an A2A agent:

```json
{
  "accounts": [ … ],
  "sources": [
    { "title": "ACME account", "url": "https://crm.example/acme", "kind": "item" },
    { "title": "ACME homepage", "url": "https://acme.example/", "private": false }
  ]
}
```

MCP tools use the standard `resource_link` content block (`uri`, `name`, `title`, `description`,
`mimeType`), `structuredContent.sources`, or a text block holding such a JSON object. The sources
of an MCP tool belong to `mcp:<serverId>`.

What a tool reports this way is **private unless a source says `"private": false`**. The platform
cannot tell whether a tool's hits are public, and a share must never show a viewer what the owner
found with their own permissions.

### 3. Register a producer (code)

An integration with a result shape of its own registers a producer:

```js
import { registerSourceProducer } from '../services/sources/index.js';

registerSourceProducer({
  id: 'confluence',
  matches: ({ toolId }) => toolId.startsWith('confluence_'),
  fromToolResult: ({ toolId, toolDef, args, result, failed }) => ({
    items: result.pages.map(page => ({ provider: 'confluence', id: page.id, title: page.title, url: page.link })),
    queries: [result.cql]
  })
});
```

The built-in producers work the same way. Web search and the page reader use
`services/sources/producers/web.js`, and the iFinder tools use `producers/ifinder.js`.

Model adapters report what they found on the stream chunk as `chunk.sources`; the iAssistant
adapter does this. Provider-run web search (Anthropic, Google, OpenAI) reports through the chunk's
`groundingMetadata`, which the loop turns into sources (`shared/sources/grounding.js`).

## Actions: source providers

Open and Copy link need only a `url`. Preview, Download, Add to email, Open in App and Details
fetch the source through the provider that owns it. The route is one for all providers:

```
GET /api/sources/:provider/content?id=<ref.id>[&scope=<ref.scope>][&format=original|pdf|text]
GET /api/sources/:provider/metadata?id=<ref.id>[&scope=<ref.scope>]
```

A provider is server code, registered by its integration. It fetches with the signed-in user's own
permissions in that system:

```js
import { registerSourceProvider, sourceProviderError } from '../services/sources/providers.js';

registerSourceProvider({
  id: 'nextcloud',
  async content({ ref, user, format }) {
    // → { contentType, stream } or { contentType, body }, optionally contentDisposition / fileName
  },
  async metadata({ ref, user }) {
    // → { title, filename, sizeFormatted, author, sourceName, modificationDate, deepLink, … }
  }
});
```

`ifinder` is built in (`services/sources/providers/ifinder.js`). The iFinder document routes
(`/api/integrations/ifinder/document*`) use the same provider.

A source keeps its `ref` only when its provider is registered, because a ref that no provider
serves would offer actions that cannot work. A source with a `ref` is always private.

## On the wire, in the ledger, in storage

- **Loop**: `ctx.addSources(frame)` merges into `ctx.sources`. `LoopResult.sources` is
  `{ items, queries, supports }` for every loop caller: chat, workflows, agents, app-as-tool and
  MCP `tools/call`. See [Agent Loop](agent-loop.md).
- **SSE and ledger**: one event, `sources/added { step?, callId?, toolId?, items, queries?,
  supports? }`. It is written to the run ledger, so a re-sync replays it. See [SSE v2](sse-v2.md).
  A tool call's frame carries its `callId`, and the tool activity rows list each call's own
  sources from it.
- **Stored answer**: `sources: { items, queries }`, bounded to 256 KB (passages go first, then
  sources). Google's grounding supports are written into the stored text as citation markers. See
  [Chat Persistence](chat-persistence.md).
- **Share**: only sources that are not private and carry no `ref`. See
  [Chat Sharing](chat-sharing.md).

## What is private

| Source | Private |
|---|---|
| Web search results of the platform's own search (Brave, Staan, Qwant, provider-run search) | no |
| Hits of an MCP or custom tool named after a search engine | yes; a custom tool's `sources` declaration can say `"public": true` |
| A page only the page reader read | yes (the reader can reach intranet hosts on the SSL whitelist) |
| iFinder and iAssistant documents | yes |
| MCP, envelope and declared sources | yes, unless a source (or the declaration) says otherwise |
| Anything with a `ref` | always |

A source that several producers found is public if any of them found it publicly. For example, a
page a web search returned stays public after the page reader reads it. A public sighting never
makes public what a private one reported, though: the source then shows only what the public
sighting said about it (title, excerpt, passages), and takes from the private one only whether it
was read and cited. A private tool's excerpt for a URL cannot reach a share because a web search
returned the same URL.
