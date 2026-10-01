# Building an Integration

This guide is for developers who connect iHub to another system: a wiki, a ticket tracker, a
document store, a CRM, a search engine. It walks through the path from the tool the model calls to
what the user sees under the answer. That covers the results in the **Sources** panel, the actions
on each result (open, preview, download, add to email, open in app, details), and what a shared
chat may show.

Every integration reports what it found through one contract, [Answer Sources](answer-sources.md).
The chat, the panel, citations, storage and sharing work from that contract. A new integration
needs no code in any of them.

## 1. Pick the kind of integration

| You have | Build | Code in iHub | Details |
|---|---|---|---|
| An HTTP API with an OpenAPI document | An OpenAPI tool (`"type": "openapi"`) | none | [Tool Calling](tool-calling.md) |
| An MCP server | An MCP server entry | none | [MCP Integration](mcp-integration.md) |
| A remote A2A agent | An A2A agent entry | none | [Remote A2A Agents](a2a-agents.md) |
| An SDK, several calls per answer, or a per-user sign-in | A script tool: `contents/tools/<id>.json` and `server/tools/<script>.js` | JavaScript | [Tool Calling](tool-calling.md), this guide |
| A service that answers like a model (iAssistant) | A model adapter | JavaScript | [LLM Client](llm-client.md) |

Whatever you build, the user's view of what it found is the same. The rest of this guide is about
that view.

## 2. Choose how it reports what it found

After every tool call, the loop asks for the call's sources (`server/services/sources/index.js`).
The first of these that applies wins:

1. **A `sources` declaration in the tool definition** (no code). It maps fields of the result to
   source fields. Use it for an OpenAPI tool, or for any tool whose result you cannot change. See
   [Answer Sources → Declare a mapping](answer-sources.md#1-declare-a-mapping-in-the-tool-definition-no-code).
2. **A registered producer** (code). Use it when several tools share a result shape of their own,
   as the iFinder tools do, or when the mapping needs logic. See
   `server/services/sources/producers/ifinder.js`.
3. **The tool's own report** (the simplest code path). The tool puts a `sources` array next to its
   data. An MCP server returns `resource_link` blocks or `structuredContent.sources`. An app used
   as a tool and an A2A agent do the same.

A model adapter puts `chunk.sources` on the stream instead
(`server/adapters/iassistant-conversation.js`).

Sources are read from the tool's **full** result, before anything is shortened for the model or
the client. A long result loses none of its sources. The model does read a `sources` array that
is part of the result, so keep its entries short. If you would rather the model not read them,
use a producer.

## 3. Describe each result

A source is a plain object (`shared/sources/source.js`). Fill in what your system knows:

| Field | Shown as | Guidance |
|---|---|---|
| `id` | (identity) | Your system's key for the item (`ACME-12`, a page id). The same item found twice, in two calls or two turns, becomes one source. Without an `id`, the `url` identifies it. |
| `title` | the card title | Always give one. |
| `url` | the title link; *Open*, *Copy link* | The item's address in its own system, http(s) only. Leave it out rather than send a link the user cannot open. |
| `site` | the line above the title | Where the item lives, for example `Jira · ACME` or `HR Wiki`. |
| `snippet` | the excerpt | A sentence or two. Markup is removed. |
| `passages` | *Passages*, highlighted in Preview | `[{ text }]`, the parts the answer relies on (at most 10). |
| `publishedDate` | the date | Anything `Date.parse` reads. |
| `fileName`, `type` | under the title; *Details* | For files. |
| `kind` | the icon | `page`, `document` or `item` (a ticket, a person, a record). |
| `ref` | (enables content actions) | `{ id, scope? }`: your system's handle for the item's content. Only for a provider you register (step 6). |
| `private` | (sharing) | See step 4. |
| `cited` | *Cited in this answer* | Set it when your system knows the answer relies on the item. Otherwise the answer's links decide (step 5). |

`provider` names your system, for example `jira` or `acmewiki`. It defaults to the tool's id, or to
`mcp:<serverId>` for an MCP tool. Give it explicitly when several tools return items of one system.
It must match the provider you register in step 6.

## 4. Decide what a share may show

A shared chat, which on a public link anyone with the link can open, shows only sources that are
**not private and carry no `ref`**. What the owner found with their own permissions must never
reach a viewer who lacks those permissions.

- What a tool reports is **private unless a source says `"private": false`**. A declaration says
  `"public": true` for all its hits.
- Mark a source public only if anyone may see it: a page on the open web, or a public product page.
  Never mark public something that came through the user's sign-in or the company network.
- A source with a `ref` is always private. Its content is fetched with the user's permissions.
- When a public and a private sighting of the same item merge, the result is public but shows only
  what the public sighting reported. Your private excerpt never reaches a share because a web
  search also returned the same URL.
- A name never makes results public. Only the platform's own web search scripts report public hits.

## 5. Let the model cite it

The answer cites a source by linking to its `url`. A badge such as `[1](https://…)` or a worded
link `[ACME-12](https://…)` both become the numbered badge that opens the panel on that card. A
source with a `ref` also counts as cited when the answer names its `ref.id` (six characters or
more) as a whole token, for example a document id in a link title. Two things make this work:

- The result the model reads holds each item's `url`. With the envelope it does already. With a
  producer, make sure the data itself carries the link.
- The tool description, or the app's instructions, ask the model to cite. For example: *"Cite each
  item you use as a Markdown link to its url."*

Everything the answer does not cite is listed under *Also considered*.

## 6. Offer actions on the items (a source provider)

*Open* and *Copy link* need only a `url`. *Preview*, *Download*, *Add to email* (Outlook), *Open in
App* and *Details* fetch the item's content through the system that owns it. To offer them,
register a source provider. All providers share one route:

```
GET /api/sources/<provider>/content?id=<ref.id>[&scope=<ref.scope>][&format=original|pdf|text]
GET /api/sources/<provider>/metadata?id=<ref.id>[&scope=<ref.scope>]
```

The route checks the sign-in, the provider name and the length of `id` (1024 characters at most)
and `scope` (256 at most). It also handles a stream that fails: it answers 502 before the first
byte, and aborts the response after it. Your provider does the rest:

```js
// server/services/sources/providers/acmewiki.js
import acmeWiki from '../../integrations/AcmeWikiService.js';
import { sourceProviderError } from '../providers.js';

async function content({ ref, user, format = 'original' }) {
  // The signed-in user's own access to Acme Wiki, never a service account
  // that can see more than they can.
  const client = await acmeWiki.clientFor(user);
  if (!client) throw sourceProviderError(401, 'Connect your Acme Wiki account first');
  if (format === 'text') {
    const page = await client.getPage(ref.id);
    return { contentType: 'text/plain; charset=utf-8', fileName: `${ref.id}.txt`, body: page.text };
  }
  const file = await client.download(ref.id, { pdf: format === 'pdf' });
  if (!file) throw sourceProviderError(404, 'Page not found');
  return {
    contentType: file.contentType,
    fileName: file.name,
    stream: file.stream // a Node readable; or `body` with a string or Buffer
  };
}

async function metadata({ ref, user }) {
  const client = await acmeWiki.clientFor(user);
  if (!client) throw sourceProviderError(401, 'Connect your Acme Wiki account first');
  const page = await client.getPage(ref.id);
  return {
    title: page.title,
    author: page.author,
    modificationDate: page.updatedAt,
    sourceName: page.space,
    navigationTree: page.breadcrumbs,
    deepLink: page.url
  };
}

export default { id: 'acmewiki', content, metadata };
```

- **Formats.** `original` serves *Download*, *Add to email* and *Open in App*. `pdf` serves
  *Preview*, with the source's passages highlighted. Return the original if it already is a PDF,
  and throw `sourceProviderError(415, …)` if there is none. `text` is the fallback for *Open in
  App* when your system has no file.
- **Errors.** Throw `sourceProviderError(status, message)`. A plain error is logged and answered
  with 500. *Open in App* falls back to `text` after any server error except 401 and 403.
- **Details.** The dialog shows `title`, `filename`, `application`, `sizeFormatted`, `author`,
  `sourceName`, `modificationDate`, `indexingDate`, `language`, `navigationTree` (breadcrumbs) and
  `deepLink`. Every field is optional, and `metadata` itself is too. Without it, *Details* says
  that no further details are available.
- **Permissions.** Everything runs with the requesting user's identity (`user`). Refuse an
  anonymous user if your system needs one. Use a per-user sign-in as `JiraService` does, never a
  shared key that sees more than that user.

A source keeps its `ref` only while its provider is registered. A `ref` that no provider serves
would offer actions that cannot work.

## 7. Register it

An integration that ships with iHub registers in two lists:

- **Provider:** add it to `BUILT_IN` in `server/services/sources/providers.js`. It is imported on
  first use:
  ```js
  const BUILT_IN = {
    ifinder: () => import('./providers/ifinder.js'),
    acmewiki: () => import('./providers/acmewiki.js')
  };
  ```
- **Producer** (only if you chose one in step 2): add it to `BUILT_IN_PRODUCERS` in
  `server/services/sources/index.js`.

`registerSourceProvider()` and `registerSourceProducer()` do the same at runtime, for code that
runs at server start. Do not call them from a tool script, because a tool script is imported on
its first call. After a restart, a stored answer's *Preview* would then find no provider until
someone called the tool again.

## 8. A complete example: Acme Wiki search

The tool definition, `contents/tools/acmeWiki.json` (or `server/defaults/tools/` for a tool that
ships with iHub):

```json
{
  "id": "acmeWiki",
  "name": { "en": "Acme Wiki", "de": "Acme Wiki" },
  "description": { "en": "Search the company wiki. Cite each page you use as a Markdown link to its url." },
  "script": "acmeWiki.js",
  "functions": {
    "search": {
      "description": { "en": "Search wiki pages" },
      "parameters": {
        "type": "object",
        "properties": { "query": { "type": "string", "description": { "en": "What to search for" } } },
        "required": ["query"]
      }
    }
  }
}
```

Each entry in `functions` becomes a tool of its own, here `acmeWiki_search`. The script,
`server/tools/acmeWiki.js`, exports one function per entry. Each receives the model's arguments
plus `user` and `chatId`:

```js
import acmeWiki from '../services/integrations/AcmeWikiService.js';

export async function search({ query, user }) {
  const client = await acmeWiki.clientFor(user);
  if (!client) return { error: 'ACME_AUTH_REQUIRED', message: 'Connect your Acme Wiki account' };
  const pages = await client.search(query, { limit: 10 });
  return {
    results: pages.map(page => ({ title: page.title, url: page.url, excerpt: page.excerpt })),
    // What the Sources panel lists: private (found with the user's own access),
    // with a ref so the Acme Wiki provider can preview and download each page.
    sources: pages.map(page => ({
      provider: 'acmewiki',
      kind: 'page',
      id: page.id,
      ref: { id: page.id, scope: page.space },
      title: page.title,
      url: page.url,
      site: `Acme Wiki · ${page.space}`,
      snippet: page.excerpt,
      publishedDate: page.updatedAt
    }))
  };
}
```

Then add the provider from step 6 and register it (step 7). The result:

- Every search lists its pages under the answer, numbered where the answer links them.
- Each card offers *Preview*, *Download*, *Details*, *Copy link* and, where the host allows it,
  *Add to email* and *Open in App*.
- The pages are stored with the answer, and a reopened chat shows them again.
- A share leaves them out.

When the tool's result is not yours to change, as with an OpenAPI tool, declare the mapping in
the tool definition instead. The paths point into that tool's result:

```json
"sources": {
  "provider": "acmewiki",
  "kind": "page",
  "list": "results",
  "fields": { "id": "id", "title": "title", "url": "url", "snippet": "excerpt", "publishedDate": "updatedAt" },
  "ref": { "id": "id", "scope": "space" },
  "query": "query"
}
```

## 9. Test it

- **What the tool reports.** Call `extractToolSources({ toolId, toolDef, args, result })` with a
  real result of your tool. Assert each source's `id`, `provider`, `private` and, for a provider,
  its `ref`. The template is `server/tests/loop/sourceProducers.test.js`.
- **The provider.** Register a stub with `registerSourceProvider` and request the route with
  `supertest`. The template is `server/tests/sources-route.test.js`.
- **Run it.** Put a new test file where a `test:*` script in `package.json` picks it up, so that
  `npm run test:quick` runs it. `server/tests/loop/*.test.js` (`test:loop`) is picked up
  automatically.
- **Try it.** Start iHub with `npm run dev`, enable the tool for an app, and ask something that
  calls it. Then check four things:
  - The **Sources** panel lists your results.
  - Each action works.
  - A cited result is numbered like its badge.
  - A share of the chat leaves the private results out.

## Checklist

- [ ] Each result has a stable `id`, a `title`, and an http(s) `url` where the item has one.
- [ ] Privacy is decided: private by default, `"private": false` only for content anyone may see.
- [ ] The model reads each result's `url` and is asked to cite.
- [ ] A provider (if any) uses the requesting user's own access and throws `sourceProviderError`
      with a status.
- [ ] The provider and the producer are registered at server start, not from the tool script.
- [ ] Tests cover what the tool reports and, if you added one, the provider.
- [ ] The integration has its page in `docs/` (listed in `docs/SUMMARY.md`) and an entry in
      `docs/releases/next/`.

## Related

- [Answer Sources](answer-sources.md): the contract, the stored and shared forms, and privacy.
- [Tool Calling](tool-calling.md): tool definitions, scripts and methods.
- [MCP Integration](mcp-integration.md): what an MCP tool's results contribute.
- [Agent Loop](agent-loop.md): where tool calls and their sources are collected.
