# iFinder query cookbook

Worked calls for tasks that come up repeatedly. Tool names are the MCP names
(`iFinder_search`); in a chat app the same functions are `iFinder.search`.

## Explore an unfamiliar profile

```js
iFinder_listProfiles();
iFinder_discover({ searchProfile: 'searchprofile-legal' });
```

`discover` returns document count, top facet values, sample titles and the
field catalog in one call. Read the sample titles: they tell you what kind of
documents these are far faster than any field list.

## Find documents by a person

```js
// Who writes here at all?
iFinder_getFacetValues({ facet: 'creators.keyword', maxValues: 100 });

// Then filter on the exact spelling it reported.
iFinder_search({
  query: '*',
  filter: ['creators.keyword:"DOE, John"'],
  sort: ['modificationDate:desc']
});
```

Names are stored in lexical order (`"DOE, John"`). Looking one up by loose
spelling is what the plain field is for: `creators:john`.

## Restrict to a time range

```js
iFinder_search({
  query: 'Quartalsbericht',
  filter: ['modificationDate:[2026-01-01 TO 2026-06-30]']
});
```

Open-ended on either side with `*`: `[2026-01-01 TO *]`. Dates are ISO 8601 in
UTC. `creationDate`, `indexingDate`, `message.sendDate` and `task.dueDate`
behave the same way.

## Restrict to a document kind

```js
// Learn the vocabulary first — "PDF" or "pdf" is deployment-specific.
iFinder_getFacetValues({ facet: 'application.keyword' });

iFinder_search({ query: 'contract', filter: ['application.keyword:PDF'] });
iFinder_search({ query: 'contract', filter: ['file.extension.keyword:docx'] });
iFinder_search({ query: 'contract', filter: ['mediaType.keyword:"application/pdf"'] });
```

`application` is the human-facing label (Word, PDF, Confluence), `mediaType` the
MIME type, `file.extension` the lower-cased suffix.

## Restrict to a source system or folder

```js
iFinder_getFacetValues({ facet: 'sourceName.keyword' });

iFinder_search({ query: 'onboarding', filter: ['sourceName.keyword:"SharePoint"'] });
```

`navigationTree` holds the breadcrumb hierarchy and is filtered under its plain
name. Its segments are separated by a unit-separator control character, so read
values off a facet rather than composing them by hand:

```js
iFinder_getFacetValues({ facet: 'navigationTree', maxValues: 100 });
```

## Where does a topic live?

```js
iFinder_search({
  query: 'Datenschutz',
  maxResults: 0,
  returnFacets: ['sourceName.keyword', 'application.keyword', 'language.keyword']
});
```

`maxResults: 0` gives the distribution without the hits — a cheap way to decide
where to look before fetching anything.

## Everything in a profile, newest first

```js
iFinder_search({ query: '*', sort: ['modificationDate:desc'], maxResults: 25 });
```

## Page a large result set

```js
const page1 = await iFinder_search({ query: '…', maxResults: 50, from: 0 });
const page2 = await iFinder_search({ query: '…', maxResults: 50, from: 50 });
```

Check `totalFound` first. Past a few hundred, narrow with filters instead of
paging.

## Read a document

```js
const hits = await iFinder_search({ query: 'Kündigungsfrist', maxResults: 5 });
const doc = await iFinder_getContent({ documentId: hits.results[0].id, maxLength: 20000 });
```

`iFinder_getMetadata` gives the same document's metadata without the text — use
it when you only need the date, author or link.

Both take the hit's `id` and nothing else. A title or a link as `documentId` is
rejected with a hint, not resolved.

## Find the id of a document you only know by title

Tool results are not replayed in later turns, so a document cited earlier may
be known by its title alone. Search for it, then match the hit:

```js
const hits = await iFinder_search({ query: 'title:"Schulungsangebot.pptx"', maxResults: 5 });
const hit = hits.results.find(h => h.deepLink === citedLink) ?? hits.results[0];
await iFinder_getMetadata({ documentId: hit.id });
```

Better still, keep the id in the answer where it does not show: as the markdown
link title, `[Title](deepLink "SharePoint › Vertrieb · onedrive-d4HF8X5AZOWTbeGW")`,
which renders as a tooltip naming the source and can be read back next turn.

## Two people, one document

```js
filter: ['creators.keyword:("DOE, John" OR "ROE, Jane")'];
```

Each `filter` entry is its own clause, and entries are ANDed. To OR values of
the same field, keep them inside one entry.

## Exclude something

```js
iFinder_search({ query: 'policy', filter: ['NOT application.keyword:PowerPoint'] });
```

## Specific fields only, to keep a response small

```js
iFinder_search({
  query: '…',
  returnFields: ['id', 'title', 'modificationDate', 'accessInfo.deepLink', 'sourceName']
});
```

`returnFields: ["*"]` returns everything, which is useful when inspecting one
document and wasteful for a result list.

## Custom fields

```js
iFinder_getFields({ filterPrefix: 'cust.' });
iFinder_search({ query: '*', filter: ['cust.classification.keyword:"class 1"'] });
```

## Anti-patterns

```text
✗ filter: ['creators:"DOE, John"']
    Exact match against the analyzed field — matches on word overlap, not identity.
✓ filter: ['creators.keyword:"DOE, John"']

✗ filter: ['title.keyword:"Annual Report"']
    `title` has no keyword variant, so this matches nothing and does not error.
✓ query:  'title:"Annual Report"'

✗ query: 'Kündigungsfrist AND application.keyword:PDF'
    A filter term inside the query counts toward the relevance score.
✓ query: 'Kündigungsfrist', filter: ['application.keyword:PDF']

✗ sort: ['title:asc']
    Analyzed text fields carry no sortable doc values.
✓ sort: ['file.name.keyword:asc']

✗ filter: ['application.keyword:pdf']
    Casing is deployment data, not convention.
✓ iFinder_getFacetValues({ facet: 'application.keyword' }) first, then filter on
  a value it reported.
```
