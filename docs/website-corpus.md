# Website Corpus

The **Website Corpus** integration (`com.intrafind/website-corpus`) measures how much text a website
really has, in tokens, and whether all of it fits into one context window. That decides whether
"put the whole site into the prompt" is a realistic alternative to retrieval for that site.

A user asks the assistant to size a site; the assistant reads the site's sitemap, crawls the pages
in resumable batches, keeps the main text of each page, and reports tokens per section, duplicates
and how many 128k, 256k and 1M windows the corpus fills. The
[`website-corpus-sizer`](skills.md) skill in the [marketplace](marketplace.md) walks the model and
the user through the steps; the tools also work without it.

## Setting it up

1. **Install it.** **Admin → Integrations → Catalog → Website Corpus → Set up integration.** It is a
   singleton: one installation, `website-corpus`. Its only setting is **Most pages per corpus**
   (default 3,000, at most 10,000).
2. **Grant it.** Add `website-corpus` to `permissions.integrations` of the groups that may use it
   (see [Integrations → Who may use an integration](integrations.md#who-may-use-an-integration)).
   Using it needs a signed-in user; anonymous users are refused.
3. **Bind it to an app.** In the app's JSON, or under **Admin → Apps → Integrations**:

   ```json
   "integrations": { "website-corpus": {} }
   ```

   An app that also has the `website-corpus-sizer` skill enabled (`skillSettings.enabled: true`)
   gets the whole guided process.

The installation test (**Test**) checks that the storage provider can keep crawled pages and says
which tokenizer counts (see [How tokens are counted](#how-tokens-are-counted)).

## The tools

All five only read (`sideEffect: read`). The two that fetch from the website send requests out of
the server (`dataFlow: external`); the other three work on what was already stored (`internal`).

| Tool                       | Action          | What it does                                                                                                                          |
| -------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `website_corpus_discover`  | `discover_site` | Reads robots.txt and the sitemaps, keeps the pages on the site under an optional path prefix (`/de/`), starts a corpus and lists the sections |
| `website_corpus_outline`   | `outline_pages` | Shows the structure of up to three pages and marks what looks like boilerplate (breadcrumbs, cookie banners, teaser sliders)          |
| `website_corpus_crawl`     | `crawl_pages`   | Fetches the next batch of pages (30 by default, at most 60) and keeps their main text; call it until it reports `done`                |
| `website_corpus_page_text` | `read_page_text`| The kept text of one page, for a spot-check against the live page                                                                     |
| `website_corpus_report`    | `corpus_report` | Computes the numbers and returns the report as Markdown                                                                               |

**What is kept.** The text of `<main>` (`<body>` if there is none). Scripts, styles, forms, buttons,
iframes, `<nav>` and the selectors the user names (`dropSelector`, for example
`.breadcrumb, .cookie-banner`) are removed; headings and list items keep their markers; consecutive
identical lines are dropped. Changing the selector after pages were kept needs `restart`, because
the corpus then has to be crawled again.

**The report** holds the summary and tiles, a table of how many 128k (131,072), 256k (262,144) and
1M (1,048,576) windows the corpus fills (all pages, after removing repeated lines, and without
blog and news sections), tokens by section as a table and a Mermaid chart, the 20 largest pages,
exact and near-duplicate pages, how much of the sitemap was crawled, and the method.

**Removing repeated lines.** A line of 40 or more characters is counted only on the first page where
it appears, in sitemap order. Corpus totals do not depend on the order; the per-section numbers do.

## How tokens are counted

Tokens come from the shared token estimator (`shared/tokenEstimator.js`), the one the usage tracker
uses. With the `gpt-tokenizer` package installed it counts with `o200k_base`: exact for OpenAI
models, typically within 10 to 20 percent for other families. **Without it, the estimator falls back
to one token per four characters**, and the server does not ship that package (the browser client
does). The report always says which method counted. If the numbers matter, install `gpt-tokenizer`
next to the server and restart; this also makes the usage figures of the chat more accurate.

## What it will and will not fetch

- Every request goes through the page reader's guarded fetch: private and internal addresses are
  refused on every redirect hop, DNS is pinned, the proxy is applied, and certificate checks are
  skipped only for hosts on `ssl.domainWhitelist`. An internal site can be sized when it is listed in
  `ssrf.allowedHosts` or `ssl.domainWhitelist`.
- Only pages on the site's own host are fetched. A sitemap or a redirect that points elsewhere is
  not followed into the corpus.
- The site's `robots.txt` is honored (`User-agent: *` rules). Pages it forbids are counted as
  blocked and never fetched.
- Requests to sites are throttled across all workers: two at a time, 400 ms apart.
- Only HTML is kept. PDFs and other files in a sitemap are counted as "not HTML".
- A sitemap that lists more pages than **Most pages per corpus** is refused; the user narrows the
  scope with a path prefix.
- The crawler reads the HTML the server sends. A site that builds its pages in the browser yields
  near-empty pages (many thin pages); the report shows them, but the figures do not measure that site.
- A page is read up to 2 MB, and its text is cut at 400,000 characters; cut pages are counted.

Only crawl sites the user may crawl. The tools do not check that for them.

## What is stored

A corpus belongs to the user who started it and nobody else can read it. It is kept in the
`website-corpora` namespace of the storage provider: one document with the settings and progress,
the URL list, and the extracted pages, one blob per crawl batch. It is removed after 14 days, and a
user keeps at most five; starting a sixth removes the oldest. The storage provider needs the
document and blob stores (the filesystem provider has both).

## Limits and settings

| Limit                              | Value                                            |
| ---------------------------------- | ------------------------------------------------ |
| Pages per corpus                   | 3,000 by default; **Most pages per corpus**, at most 10,000 |
| Pages per crawl call               | 30 by default, 60 at most; a call stops starting pages after 22 seconds |
| Corpora per user                   | 5                                                |
| Retention                          | 14 days                                          |
| Near-duplicate pairs listed        | 25 (the report gives the total)                  |

## Code

`server/services/websiteCorpus/` (extraction, sitemap, statistics, report, storage, service),
the connector `server/services/integrations/protocols/native/connectors/websiteCorpus/`, and the
definition `server/defaults/integration-definitions/com.intrafind__website-corpus/`.
