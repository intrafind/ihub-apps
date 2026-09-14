# The IntraFind query syntax

iFinder does not run a plain Lucene query parser. The search service wraps every
search so OpenSearch receives the query as `intrafind_query_string` — a query
type the IntraFind Insight plugin registers — instead of the built-in
`query_string`. That parser accepts all of Lucene's syntax **plus** a set of
IntraFind operators for linguistics, thesaurus expansion, entities, proximity
and units.

The operators are available through the public API's `_search` endpoint, and so
through `iFinder_search`, in the `query` string and in `filter` entries.

> **Not to be confused with `query_type`.** The public API's request body carries
> `"query_type": "QueryStringQuery"`. That is the API's own discriminator for the
> _shape_ of the query object, not the engine query type. The engine-level type
> (`intrafind_query_string`) is chosen server-side.

**Availability.** The search service enables the IntraFind parser by default
(`searchservice.use-intrafind-queryparser: true`), and a search profile can
override the engine query type. So the operators are normally on, but a
deployment can have them off. There is no capability endpoint to ask: try one
operator and compare hit counts against the same query without it. A profile
running the plain parser treats `THES/&boot` as the literal term `THES/&boot`
and typically returns nothing.

---

## Operator summary

| Operator            | Form                                | Purpose                                             |
| ------------------- | ----------------------------------- | --------------------------------------------------- |
| `MODE/`             | `MODE/<opts>&<term>`                | Linguistic matching depth (exact … stems), language |
| `THES/`             | `THES/<opts>&<term>`                | Thesaurus expansion                                 |
| `ENTITY/`           | `ENTITY/<TYPE>`                     | Match a recognised entity of a type, not a word     |
| `NEAR/`             | `NEAR/<spec>(…)`                    | Proximity: same sentence, paragraph, or N tokens    |
| `UNIT/`, `ABSUNIT/` | `UNIT/<cmp>(<expr>)`                | Measurement values with unit conversion             |
| `DATE/`             | `DATE/<cmp>(<expr>)`                | Dates written in running text                       |
| `NUMBER/`           | `NUMBER/<value>`, `NUMBER/[a TO b]` | Numbers written in running text                     |
| `OR/`               | `OR/<msm>(…)`                       | OR group with minimum-should-match control          |
| `DISMAX/`           | `DISMAX/<tie>(…)`                   | Disjunction-max group                               |

Boolean operators accept German aliases: `AND` = `&&` = `UND`, `OR` = `||` =
`ODER`, `NOT` = `!` = `NICHT`. `+` and `-` work as in Lucene.

A field prefix goes in front of everything: `content:NEAR/S(vertrag kündigung)`,
`title:THES/&boot`, `content:ENTITY/PERS`.

`_exists_:<field>` matches documents where the field is present.

---

## `MODE/` — how hard the linguistics work

Selects how far the analyzer goes when matching a term. Each level includes the
ones before it.

| Option    | Matches                                                |
| --------- | ------------------------------------------------------ |
| `e`       | exact — surface form only                              |
| `d`       | + diacritics folded (`Grüße` ↔ `Grusse`)               |
| `b`       | + base forms / lemmas (`ging` ↔ `gehen`)               |
| `c`       | + decompounding (`Bundesliga` ↔ `Liga`)                |
| `s`       | + stems — loosest                                      |
| `p`       | phonetics, combined with any of the above (`bp`, `pb`) |
| `l=de,en` | restrict to these languages                            |

```
MODE/e&Müller           exact — only "Müller", not "Mueller"
MODE/b&ging             also matches "gehen", "gegangen"
MODE/c&Bundesligaspiel  also matches documents saying just "Liga"
MODE/bp&Meier           base forms plus phonetics — "Maier", "Mayr", "Meyer"
MODE/b;l=de&Schloss     base forms, German analysis only
```

Two parts at most, separated by `;`, and one of them may be `l=`. Applies to the
clause it prefixes, and stays in effect for the rest of that clause group —
`MODE/e&Müller Schmidt` makes both terms exact.

Use `MODE/e` when a loose match is polluting results (a name, a product code, a
legal term), and `MODE/c` or `MODE/s` when a German compound is hiding matches.

## `THES/` — thesaurus expansion

Expands a term with synonyms, broader and narrower concepts from the thesaurus
collections configured on the deployment.

```
THES/&boot                     expand with defaults
THES/c=products&boot           only the "products" collection
THES/s=de;e=en&Stiefel         search German labels, expand to English ones
THES/b=1&Schraube              also one level of broader concepts
THES/n=2;y=0.5&Fahrzeug        two levels narrower, decaying each level by 0.5
THES/a=10&Vertrag              cap expansion at 10 terms
```

| Option | Meaning                                           |
| ------ | ------------------------------------------------- |
| `c=`   | Collection ids, optionally with boosts            |
| `s=`   | Language of the labels to look the term up in     |
| `e=`   | Language of the labels to expand into             |
| `b=`   | Levels of broader concepts to include (integer)   |
| `n=`   | Levels of narrower concepts to include (integer)  |
| `x=`   | Score decay per broader level (float)             |
| `y=`   | Score decay per narrower level (float)            |
| `z=`   | Expansion threshold (integer)                     |
| `l=`   | Limit lookup to preferred labels (`true`/`false`) |
| `a=`   | Maximum number of expansions (integer)            |

Options are separated by `;`. The `&` ends the prefix and the term follows.

`MODE/` and `THES/` combine in either order:
`MODE/l=de,en&THES/&boot`.

Thesaurus content is per deployment. Expansion silently does nothing when no
collection is configured, so a `THES/` query that changes no hit count means
there is no thesaurus, not that the term has no synonyms.

## `ENTITY/` — match a kind of thing

Matches a token the analyzer tagged as an entity, regardless of its text. The
type becomes the index term `E_<TYPE>`.

```
ENTITY/PERS                              any person name
ENTITY/LOC                               any place
ENTITY/ORG                               any organisation
ENTITY/EMAIL                             any email address
ENTITY/PHONE                             a validated phone number
ENTITY/PHONECANDIDATE                    something shaped like a phone number
NEAR/S(ENTITY/LOC AND intrafind)         a place in the same sentence as "intrafind"
NEAR/2(Telefonnummer ENTITY/PHONECANDIDATE)
```

Which types exist depends on the deployment's linguistic configuration and
gazetteers. An entity query against a field whose analyzer does not emit entity
tokens matches nothing rather than erroring — so a `content:ENTITY/PERS` that
returns zero may mean the field is not analyzed that way.

This is separate from the `enrichment.*` fields the NER enricher writes
(`enrichment.personNames`, `enrichment.emails`, `enrichment.entityTypes`). Those
are ordinary fields you filter on; `ENTITY/` matches at analysis time inside the
text. Prefer the enrichment fields when you want to _retrieve_ the names, and
`ENTITY/` when you want documents where a name occurs in a particular position.

## `NEAR/` — proximity

```
NEAR/S(vertrag kündigung)      both in the same sentence
NEAR/P(vertrag kündigung)      both in the same paragraph
NEAR/5(vertrag kündigung)      within 5 tokens
NEAR/M(...)                    multiword, slop 3
NEAR/US(...)                   unordered, same sentence
NEAR/OS(...)                   ordered, same sentence
NEAR/2R2(a b c d)              within 2, reduced to the 2 most important terms
NEAR/2M2(a b c d)              within 2, at least 2 clauses must match
NEAR/2R2T0.0(...)              … with tie-break 0.0
NEAR/2R2PR(...)                … and mark for passage retrieval
```

Spec grammar: optional `U` (unordered) or `O` (ordered), then `S` sentence, `P`
paragraph, `N` none, `M` multiword, or an integer slop; then optionally
`R<int>` (reduce to most important), `M<int>` (minimum should match),
`T<float>` (tie break), `PR` (passage retrieval).

Inside `NEAR/(…)` you cannot use a field prefix on the individual terms — put it
in front of the whole group (`content:NEAR/S(a b)`). `*:*` is accepted inside as
a synonym for `*`.

`NEAR/S` is the single most useful operator for precision: two terms in the same
sentence is a far stronger signal than two terms in the same document.

## `UNIT/`, `ABSUNIT/`, `DATE/`, `NUMBER/` — values in running text

These match quantities written in the document body, converting units, rather
than reading a numeric index field.

```
UNIT/(5 kg)          about 5 kg, converted — matches "5000 g"
UNIT/>=(5 kg)        at least 5 kg
UNIT/<(3 m)          under 3 m
ABSUNIT/(5 kg)       absolute — no conversion
DATE/(2026-01-01)    that date, however it is written in the text
DATE/>=(2026-01-01)  that date or later
NUMBER/42            the number 42 in the text
NUMBER/[10 TO 100]   a number in that range
```

Comparators: `=`, `<`, `<=`, `>`, `>=`, `*`. They are for values _inside the
text_. For a document's own metadata (`file.size`, `modificationDate`,
`contentLength`) use an ordinary range filter — it is indexed and far cheaper.

## `OR/` and `DISMAX/` — scoring control

```
OR/2(a b c d)          OR group, at least 2 clauses must match
OR/75%(a b c d)        at least 75% must match
OR/2;rd(a b c)         … and drop duplicate clauses
OR/2;rm3(a b c d e)    … reduce to 3 main clauses
OR/2;req(a b c)        minimum-should-match required
DISMAX/0.3(a b c)      disjunction-max with tie-break 0.3
```

The `OR/` argument is a standard minimum-should-match spec (`2`, `75%`, `2<-1
5<80%`), optionally with `;`-separated flags: `rd` remove duplicates, `rm<int>`
reduce main clauses, `ro<int>` reduce original clauses, `req` required.

Reach for these when a long query returns nothing because everything is ANDed,
or too much because everything is ORed.

---

## Worked examples

```js
// A person named in the same sentence as a topic
iFinder_search({ query: 'content:NEAR/S(ENTITY/PERS AND Kündigungsfrist)' });

// Exact product code, no linguistic loosening
iFinder_search({ query: 'MODE/e&"XR-4400/B"' });

// Compound-aware German search
iFinder_search({ query: 'MODE/c&Bundesligaspiel' });

// Synonyms, German in and English out, capped
iFinder_search({ query: 'THES/s=de;e=en;a=10&Stiefel' });

// Both, combined, with a normal filter alongside
iFinder_search({
  query: 'MODE/b&THES/&Vertragsstrafe',
  filter: ['language.keyword:de', 'modificationDate:[2026-01-01 TO *]']
});

// Weights over 5 kg mentioned in the text
iFinder_search({ query: 'UNIT/>=(5 kg)' });

// Loosen a long query that ANDs itself to zero
iFinder_search({ query: 'OR/2(kündigung frist vertrag arbeitsrecht)' });
```

---

## Cautions

- **Escape a literal slash.** `THES/`, `NEAR/`, `ENTITY/` and friends are
  recognised by the trailing `/`, so a term that genuinely contains one needs
  `\/` or quoting.
- **Case matters for the operators.** `near/S(...)` is not `NEAR/S(...)`.
- **The `&` is part of the prefix.** `MODE/b&term`, not `MODE/b term`.
- **A wrong entity type is silent.** `ENTITY/PERSON` is not `ENTITY/PERS`; an
  unknown type matches nothing rather than erroring.
- **Filters take the same syntax**, and the same caveat applies: an operator
  that a profile's parser does not understand becomes a literal term and the
  filter quietly matches nothing.
- **Verify before relying on it.** Run the query with and without the operator
  and compare `totalFound`. An operator that is not active, a thesaurus that is
  not configured, and a field that cannot analyze entities all look the same
  from outside: zero hits.
