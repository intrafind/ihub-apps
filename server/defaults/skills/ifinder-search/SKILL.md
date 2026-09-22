---
name: ifinder-search
description: >
  Search an IntraFind iFinder enterprise index through the iHub iFinder tools
  (iFinder_search, iFinder_getFields, iFinder_getFacetValues, iFinder_discover,
  iFinder_getContent, iFinder_getMetadata, iFinder_listProfiles). Use this skill
  whenever a question has to be answered from iFinder documents, or when a
  search returns nothing, too much, or the wrong thing and the query needs
  fixing. It covers the IntraFind query syntax — Lucene plus the `MODE/`,
  `THES/`, `ENTITY/`, `NEAR/`, `UNIT/`, `DATE/`, `NUMBER/` and `OR/` operators
  for linguistic matching, thesaurus expansion, entity and proximity search —
  when a field needs a `.keyword` suffix, filters versus query terms, facets,
  sorting, paging and the discovery loop for an unfamiliar corpus. Do NOT use it
  for web search or for other document sources.
license: Apache-2.0
metadata:
  author: IntraFind
  version: '1.2'
---

# Searching iFinder

iFinder is an enterprise search index over documents pulled from file shares,
SharePoint, Confluence, mail, ticket systems and similar sources. You reach it
through iHub tools that call the iFinder public API **as the signed-in user**,
so results are already cut to what that person is allowed to see. A document
you cannot find may simply not be yours to read.

## The one rule that breaks most queries

Every text field is indexed **twice**:

| You want to                                  | Use                 | Example                        |
| -------------------------------------------- | ------------------- | ------------------------------ |
| match words, ranked by relevance             | the plain name      | `creators:john`                |
| match a value exactly, filter, facet or sort | the `.keyword` name | `creators.keyword:"DOE, John"` |

`creators:"DOE, John"` finds documents whose author field _contains those
words_. `creators.keyword:"DOE, John"` matches only that exact string, whole and
unanalyzed. Use the plain name in the `query`, the `.keyword` name everywhere
values must match exactly.

Three things this rule does **not** apply to:

- **Dates, numbers and booleans** take no suffix: `modificationDate`,
  `file.size`, `file.isDirectory`.
- **`navigationTree`** is a hierarchy field, faceted and filtered under its
  plain name.
- **Some fields have no `.keyword` at all** — `content`, `title`, `url`,
  `subject`, `otherText`. You cannot facet or sort on them. A filter on
  `title.keyword` matches nothing; it does not error.

And some fields are the other way round: `id`, `aclAllows`, `agentType`,
`context`, `accessInfo.*` are stored but not analyzed, so only the `.keyword`
variant matches. `accessInfo.source:fileshare` finds nothing;
`accessInfo.source.keyword:fileshare` works.

**When unsure, ask the deployment rather than guessing:** `iFinder_getFields`
returns every field with the exact name to use per purpose. A `null` means the
field does not serve that purpose at all.

```
iFinder_getFields()
→ creators:         { type: text, fullTextSearch: "creators",
                      filter/aggregation/sort: "creators.keyword" }
  content:          { type: text, fullTextSearch: "content",
                      filter: null, aggregation: null, sort: null }
  modificationDate: { type: date, fullTextSearch: null,
                      filter/aggregation/sort: "modificationDate" }
```

This is also the only way to learn a deployment's **custom fields**, which are
named `cust.*` and differ per installation.

## Query syntax

The `query` takes Lucene syntax.

```
annual report                          words, relevance-ranked
"annual report"                        exact phrase
title:budget AND language:de           field-qualified, boolean
creators:john OR owners:john           either
report NOT draft                       exclusion
budget*                                prefix wildcard
modificationDate:[2026-01-01 TO *]     open-ended range
_exists_:cust.classification           the field is present
*                                      everything
```

Boolean operators also accept German aliases: `UND`, `ODER`, `NICHT`.

Reserved characters (`+ - && || ! ( ) { } [ ] ^ " ~ * ? : \ /`) need escaping
with `\` when they are part of a literal value. Quote any value containing
spaces, commas or a colon.

### IntraFind operators

iFinder does not run a plain Lucene parser. The search service hands OpenSearch
the query as `intrafind_query_string`, which adds operators plain Lucene has no
equivalent for. They work in `query` and in `filter`:

| Operator                    | Does                                                                    |
| --------------------------- | ----------------------------------------------------------------------- |
| `MODE/e&Müller`             | Exact — no lemma, compound or diacritic loosening                       |
| `MODE/c&Bundesligaspiel`    | Decompound — also matches documents saying just "Liga"                  |
| `THES/&Stiefel`             | Expand with thesaurus synonyms, broader and narrower terms              |
| `ENTITY/PERS`               | Any person name, whatever it says — also `LOC`, `ORG`, `EMAIL`, `PHONE` |
| `NEAR/S(vertrag kündigung)` | Both terms in the same sentence (`P` paragraph, `5` within 5 tokens)    |
| `UNIT/>=(5 kg)`             | A weight over 5 kg written in the text, units converted                 |
| `DATE/>=(2026-01-01)`       | A date in the text, however it is written                               |
| `NUMBER/[10 TO 100]`        | A number in that range in the text                                      |
| `OR/2(a b c d)`             | OR group where at least 2 clauses must match                            |

`NEAR/S` is the one to reach for first: two terms in the same sentence is a far
stronger signal than two terms in the same document, and it sharpens a vague
query without guessing at field names.

A field prefix goes in front: `content:NEAR/S(ENTITY/PERS AND Kündigungsfrist)`.

These operators are normally active, but a deployment can have them switched
off, and a parser that does not know an operator treats it as a literal term and
quietly matches nothing. So when an operator matters, run the query with and
without it and compare `totalFound` rather than trusting a zero.

Full grammar, every option and worked examples:
[references/intrafind-query-syntax.md](references/intrafind-query-syntax.md).

## Query or filter?

`iFinder_search` takes both. They are ANDed together, but only the `query`
influences ranking.

```
iFinder_search({
  query: "Kündigungsfrist",
  filter: [
    'application.keyword:PDF',
    'creators.keyword:"DOE, John"',
    'modificationDate:[2026-01-01 TO *]'
  ]
})
```

Put the **topic** in `query` and every **narrowing criterion** in `filter`.
Folding a filter into the query (`Kündigungsfrist AND application.keyword:PDF`)
still works but skews relevance, because the format term counts toward the
score.

## Standard fields worth knowing

Content and identity: `title`, `content`, `subject`, `id`, `url`,
`accessInfo.deepLink` (the link to give a user).

People: `creators`, `owners`, `task.assignee`, `appointment.organizer`,
`message.sender` — all lexical order, `"DOE, John"`.

Dates: `modificationDate`, `creationDate`, `indexingDate`, `message.sendDate`,
`task.dueDate`. ISO 8601, UTC.

Source and type: `sourceName` (the data source), `sourceType` (human-readable
system name), `application` (Word, PDF, Confluence…), `mediaType` (MIME type),
`documentClasses`, `navigationTree` (the breadcrumb hierarchy),
`sourceLocations.label`.

Files: `file.name`, `file.extension` (lower-cased), `file.size` (bytes),
`file.isDirectory`.

Language: `language` (main, ISO 639-1), `languages` (all detected).

Per-class fields exist under a class prefix — `person.*`, `task.*`,
`appointment.*`, `message.*`, `image.*`, `container.*`, `attachment.*`,
`project.*`, `document.pageCount`. See
[references/field-reference.md](references/field-reference.md) for the full
catalog with the `.keyword` column.

A plain-word query searches a configured default set of fields, not everything —
`title`, `content` and a bundle of metadata copied into `otherText`. Fields
outside it (dates, ACLs, IDs, processing status) are reachable only when named
explicitly.

## Discovery loop for an unfamiliar corpus

Do not guess at an index you have not looked at.

1. **`iFinder_listProfiles()`** — which search profiles exist. A profile scopes
   the corpus; the wrong one is the difference between 4 hits and 4,000. A
   deployment with no iAssistants configured reports only the default, which is
   a limitation of the upstream API rather than an error.
2. **`iFinder_discover({ searchProfile })`** — one probe returning total
   document count, top facet values, sample titles and the field catalog. This
   is the fastest way to see what a profile actually contains.
3. **`iFinder_getFacetValues({ facet: "sourceName.keyword" })`** — the full
   value list for one field when the probe's top-N is truncated. Use it to learn
   the exact spelling of a source, author or application before filtering on it.
   Guessing `application.keyword:pdf` when the index says `PDF` returns nothing.
4. **`iFinder_search`** with what you learned.

## Reading results

`iFinder_search` returns `totalFound`, `results[]` and, when you asked for them,
`facets[]`. Each hit carries `id`, `score`, `title`, `sourceName`, dates,
`deepLink` and the fields you requested in `returnFields`.

Then:

- **`iFinder_getMetadata({ documentId })`** — full metadata for one hit, no
  content. Cheap.
- **`iFinder_getContent({ documentId })`** — the extracted text. This is what
  you read to answer a question. Use `maxLength` to cap it.

Cite documents by `title` plus `deepLink`, never by bare `id` — the id means
nothing to the reader.

### Size the result set before you pull it

Every hit that matched text carries its teasers, so a 50-hit response is large
whatever you put in `returnFields` — `returnFields` selects document fields, it
does not shrink the teasers. When you do not yet know whether a query is any
good, spend one hit first:

```
iFinder_search({
  query: "…",
  maxResults: 1,
  returnFacets: ["application.keyword", "sourceName.keyword"]
})
```

That returns `totalFound` and the value distribution of the whole result set for
the price of a single hit — enough to see whether the filter matched, which
formats and sources the topic lives in, and how many hits are worth fetching.
Then run the real search.

### The same file appears more than once

`totalFound` counts index documents, not distinct files. A document crawled from
two sources — a SharePoint copy and a file-share copy of the same spreadsheet —
is two documents with two ids, and a folder holding several revisions multiplies
that again. Nine hits can be one file.

Before reporting a count to the user, group by `file.name` (or `title`) and say
how many distinct documents there are. `returnFacets: ["sourceName.keyword"]`
shows at a glance when one result set spans several copies of the same corpus.

## Paging

`maxResults` is capped at 100 per call. Page with `from`:

```
iFinder_search({ query: "…", maxResults: 50, from: 0 })   // hits 1–50
iFinder_search({ query: "…", maxResults: 50, from: 50 })  // hits 51–100
```

Check `totalFound` before paging. If it is in the thousands, narrow with filters
instead — reading 40 pages is never the right answer.

## Sorting

`sort` takes `field:asc` / `field:desc`, applied in order. Only sortable fields
work: dates, numbers, and the `.keyword` variant of text fields.

```
sort: ["modificationDate:desc"]                   // newest first
sort: ["sourceName.keyword:asc", "title:desc"]    // ✗ title has no .keyword
```

Omit `sort` to rank by relevance — which is the right default for a question,
and the wrong one for "the latest N".

## Facets

Pass `returnFacets` to get the value distribution of a result set alongside the
hits:

```
iFinder_search({
  query: "Datenschutz",
  returnFacets: ["sourceName.keyword", "application.keyword", "language.keyword"]
})
```

Good for "where does this topic live?" and for offering the user a next filter.
The facet block that rides along with a search is capped; `iFinder_getFacetValues`
returns the long tail.

## When a search disappoints

| Symptom                                 | Likely cause                                    | Fix                                        |
| --------------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| 0 hits with a filter                    | `.keyword` missing, or on a field that has none | `iFinder_getFields`, then re-filter        |
| 0 hits, exact value                     | wrong spelling or casing                        | `iFinder_getFacetValues` on that field     |
| 0 hits, plausible query                 | wrong search profile                            | `iFinder_listProfiles`, then retry         |
| far too many hits                       | topic-only query                                | move criteria into `filter`                |
| right topic, wrong docs                 | ranking skewed by filter terms in the query     | move them to `filter`                      |
| a known document missing                | the user cannot read it                         | say so; do not retry                       |
| sort ignored                            | sorting on an analyzed text field               | use the `.keyword` variant                 |
| 0 hits with `THES/`, `NEAR/`, `ENTITY/` | operator inactive, or a typo in it              | re-run without it and compare `totalFound` |
| a German compound finds nothing         | analyzer stopped at the surface form            | `MODE/c&` or `MODE/s&`                     |
| a name or code matches too loosely      | lemma or compound expansion                     | `MODE/e&`                                  |

Never report "there are no documents about X" after one failed query. Confirm
the profile and the field names first — the common case is a query fault, not an
empty corpus.

## Related references

- [references/field-reference.md](references/field-reference.md) — the standard
  field catalog with types, `.keyword` availability and purposes.
- [references/query-cookbook.md](references/query-cookbook.md) — worked queries
  for recurring tasks.
- [references/intrafind-query-syntax.md](references/intrafind-query-syntax.md) —
  the IntraFind operators (`MODE/`, `THES/`, `ENTITY/`, `NEAR/`, `UNIT/`,
  `DATE/`, `NUMBER/`, `OR/`, `DISMAX/`) in full.
