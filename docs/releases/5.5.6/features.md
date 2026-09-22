# Features — 5.5.6

## One OAuth Client for Claude Instead of One Per User

Adding iHub as a custom connector in Claude used to create a new OAuth client
record every single time. Every user who connected added another
indistinguishable "Claude" row to **Admin → OAuth → Clients**, and
`oauth.dcr.maxClients` (default 100) quietly became a cap on *users* — the
101st person to connect was told the registration limit had been reached.

Two changes fix it, and they work together.

**Client ID Metadata Documents (recommended).** Claude can identify itself with
an HTTPS URL pointing at a metadata document it publishes, so nothing is stored
on the iHub side at all — one stable identity for everyone. Turn it on under
**Admin → MCP gateway → Client identification**; the trusted-hosts list ships
with `claude.ai` and nothing else. Claude Code works too, on its loopback
callback. A side benefit: because the client identity no longer changes between
connections, remembered consent (`consentMemoryDays`) finally survives a
reconnect.

**Dynamic registration de-duplication (automatic).** For clients that do not
support metadata documents, a repeat registration with identical public
metadata now returns the client ID it was already given instead of creating
another record. Nothing to configure, and the `maxClients` cliff is gone:
a client already on file still connects once the cap is reached.

Existing dynamically registered clients, consents and refresh tokens keep
working, and nothing is deleted automatically. The clients list gains kind
badges (admin / personal / dynamic), a filter that hides dynamic records by
default, a registration count and first-user attribution on the ones it shows,
and a **Remove unused dynamic clients** action for tidying up on your own
schedule.

Details, including the security posture around fetching a metadata document,
are in `docs/mcp-integration.md`.

## See and Revoke Who Is Connected

**Admin → OAuth → Connections** is a new tab answering the question the client
list never could: which user granted which application which scopes, and when.
Filter by user or client, and revoke any grant. The clients list now shows a
connection count per client, a user's detail page lists their connections, and
applications identified by a metadata document appear as read-only rows even
though they have no client record.

Users get the same view of their own grants under **Settings → Integrations →
Connected apps**, with the scopes spelled out in the same plain language as the
consent screen, and a **Disconnect** button.

Disconnecting deletes the consent *and* revokes the application's refresh
tokens, so it has to ask for permission again rather than quietly carrying on
with a token it already had. An access token it already holds keeps working
until it expires — both screens say so, with the actual number of minutes.

Four new audit events (`oauthConnection` granted and revoked, `oauthClient`
registered, `oauthCimd` rejected) record all of this under **Admin → Audit
log**.

## Discover an iFinder Index Instead of Guessing at It

Searching iFinder well means knowing which fields exist and which of them need a
`.keyword` suffix — a filter on `title.keyword`, which has no keyword variant,
matches nothing and reports no error. Until now nothing in iHub could answer
that question, so an app, agent or MCP client had to guess.

Four functions now read the answer off the deployment:

- **`iFinder_getFields`** — the index field catalog, straight from the live
  mapping. Per field it reports the exact name to use for full-text search,
  filtering, faceting and sorting, with `null` where the field serves no such
  purpose. It is also the only way to see a deployment's custom `cust.*` fields.
- **`iFinder_getFacetValues`** — enumerate the values of one facet with document
  counts, far beyond the capped facet block a search returns. Use it to learn
  the exact spelling of a source, author or application before filtering on it.
- **`iFinder_listProfiles`** — the search profiles the user can reach, derived
  from the iAssistants iFinder exposes plus the configured default.
- **`iFinder_discover`** — now also returns the field catalog alongside the
  totals, top facets and sample titles it already produced.

`iFinder_search` gained the four parameters the integration always supported but
never declared, which meant a model calling it could not reach them at all:
`filter` (criteria ANDed with the query without skewing relevance), `sort`,
`returnFacets` and `from` for paging past the 100-hit cap.

A new **`ifinder-search` skill** ships with the platform and teaches a client the
whole surface — the query syntax, the `.keyword` rule, filters versus query
terms, facets, sorting, paging, and the discovery loop for an unfamiliar corpus
— with a full field reference, a query cookbook and a grammar reference beside
it. Grant it to a group and MCP clients see it as a resource; grant the `iFinder`
tool to the same group and a client such as Claude can search the index on its
own.

That includes the part of iFinder that a plain Lucene client never reaches.
iFinder does not run a plain query parser: the search service hands OpenSearch
the query as `intrafind_query_string`, which adds `NEAR/S(a b)` for two terms in
one sentence, `MODE/e&` and `MODE/c&` for exact matching and German
decompounding, `THES/&` for thesaurus expansion, `ENTITY/PERS` for any person
name, `UNIT/`, `DATE/` and `NUMBER/` for values written in running text, and
`OR/2(…)` for minimum-should-match control. The tool descriptions and the skill
now document them, so a model can use them instead of guessing at keywords.

Installations upgrade automatically: a migration adds the new functions and
search parameters to an existing `tools/iFinder.json`, and refreshes the two
descriptions that predate the operator documentation — but only where they are
still the shipped text, so any wording an admin changed stays exactly as it is.

See [iFinder Integration](../../iFinder-Integration.md) and the
[iFinder Quick Reference](../../iFinder-Quick-Reference.md).
