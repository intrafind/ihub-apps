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
   singleton: one installation, `website-corpus`. Its settings are **Most pages per corpus**
   (default 3,000, at most 10,000), **Parallel requests per crawl** and **Pause between requests (ms)**
   (how fast the sites are fetched, see [What it will and will not fetch](#what-it-will-and-will-not-fetch)), and **Allow company-internal websites** (off by default, see
   [Internal websites](#internal-websites)).
2. **Grant it.** Add `website-corpus` to `permissions.integrations` of the groups that may use it
   (see [Integrations → Who may use an integration](integrations.md#who-may-use-an-integration)).
   Using it needs a signed-in user; anonymous users are refused.
3. **Bind it to an app.** In the app's JSON, or under **Admin → Apps → Integrations**:

   ```json
   "integrations": { "website-corpus": {} }
   ```

   An app that also has the `website-corpus-sizer` skill enabled (`skillSettings.enabled: true`)
   gets the whole guided process. Add the `dashboard` system skill to the app's `skills` as well
   and the process ends with a dashboard of the result in the chat's workspace pane (see
   [The `dashboard` skill](pdf-generation.md#the-dashboard-skill)); without it the answer holds
   the Markdown report only.

The installation test (**Test**) checks that the storage provider can keep crawled pages and says
which tokenizer counts (see [How tokens are counted](#how-tokens-are-counted)).

## The tools

Five tools only read (`sideEffect: read`): the three that fetch from the website (discover, outline
and crawl) send requests out of the server (`dataFlow: external`), the other two work on what was
already stored (`internal`). The
sixth, `website_corpus_request_domain`, creates a request for an admin (`sideEffect: write`,
`dataFlow: internal`), so users confirm it before it is sent.

| Tool                       | Action          | What it does                                                                                                                          |
| -------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `website_corpus_discover`  | `discover_site` | Reads robots.txt and the sitemaps, keeps the pages on the site under an optional path prefix (`/de/`), starts a corpus and lists the sections |
| `website_corpus_outline`   | `outline_pages` | Shows the structure of up to three pages and marks what looks like boilerplate (breadcrumbs, cookie banners, teaser sliders)          |
| `website_corpus_crawl`     | `crawl_pages`   | Fetches the next batch of pages (60 by default, at most 100; a call stops starting pages after about 22 seconds and reports how many remain) and keeps their main text; call it until it reports `done`                |
| `website_corpus_page_text` | `read_page_text`| The kept text of one page, for a spot-check against the live page                                                                     |
| `website_corpus_report`    | `corpus_report` | Computes the numbers and returns the report as Markdown                                                                               |
| `website_corpus_request_domain` | `request_domain` | Asks an admin to allow a company-internal host that the discovery was refused for; see [Internal websites](#internal-websites)    |

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

Tokens come from the shared token estimator (`shared/tokenEstimator.js`), the one the agent loop,
context compaction, the skill budgets and the project size figures use. With the `gpt-tokenizer`
package available to it, it counts with `o200k_base`: exact for OpenAI models, typically within 10
to 20 percent for other families. **Without it, the estimator falls back to one token per four
characters**, a rough approximation that can be off in either direction. The report always says
which method counted, and **Test** on the integration shows it. Whether the server ships the
package is decided separately from this integration (see the server's release notes); if the
numbers matter, check the method named in the report.

## What it will and will not fetch

- Every request goes through the page reader's guarded fetch: private and internal addresses are
  refused on every redirect hop, DNS is pinned, the proxy is applied, and certificate checks are
  skipped only for hosts on `ssl.domainWhitelist`. A host listed platform-wide in
  `ssrf.allowedHosts` or `ssl.domainWhitelist` can be sized too; for the rest see
  [Internal websites](#internal-websites).
- Only pages on the site's own host and port are fetched (http and https of one host count as one
  site; a port other than 80 and 443 is another site). A sitemap or a page that lists another host
  or port is ignored, and a redirect that leads there is not followed: nothing is sent to it.
- The site's `robots.txt` is honored (`User-agent: *` rules). Pages it forbids are counted as
  blocked and never fetched.
- Requests to sites are throttled across all workers. The installation settings **Parallel requests
  per crawl** (default 4, 1 to 16) and **Pause between requests (ms)** (default 400, 0 to 5000) set
  how many pages are fetched at once and how long a finished request waits before the next one may
  start. The limit is shared by all crawls on the server, not per user. A change applies to the next
  batch, without a restart. Raise it only for sites you own or may load that heavily.
- Only HTML is kept. PDFs and other files in a sitemap are counted as "not HTML".
- A sitemap that lists more pages than **Most pages per corpus** is refused; the user narrows the
  scope with a path prefix.
- The crawler reads the HTML the server sends. A site that builds its pages in the browser yields
  near-empty pages (many thin pages); the report shows them, but the figures do not measure that site.
- A page is read up to 2 MB, and its text is cut at 400,000 characters; cut pages are counted.

Only crawl sites the user may crawl. The tools do not check that for them.

## Internal websites

The guard refuses private and internal addresses, so an intranet site cannot be sized until it is
allowed. There are two ways, and neither touches the platform-wide `ssrf.allowedHosts`, so `read_url`,
the workflows and every other tool keep the public-addresses-only rule:

**Ask and approve (the default).** When a discovery is refused, the answer says the host is a
company-internal address and offers `website_corpus_request_domain`. The user sends a request with
a short reason; an admin decides under **Admin → Integrations → Requests → Internal websites for the
Website Corpus** (the admin sidebar counts open requests next to Integrations):

- **Approve** lets the Website Corpus reach that host's web ports (80 and 443), for every user,
  within about 30 seconds on every worker. A site on another port is approved as `host:port`
  (`intranet.corp:8443`), which covers that port only. **Decline** keeps it refused and shows the note to the user who asks again. An
  approval can be withdrawn and a decline reversed at any time.
- One host is one request, however many users ask. A user can have 10 open requests.
- An admin can also **allow a host without a request**, with a wildcard such as `*.corp.example`
  (a wildcard matches the hosts below a domain, not the domain itself).
- Every decision is written to the audit log (`websiteCorpusDomain`).

**Allow all internal websites (a setting).** **Allow company-internal websites** on the installation
lets every crawl of every user of this integration reach the company network, with no request. Turn it
on only where all those users may see what the server can read inside the network: the crawl keeps
the text of every page it fetches, and the user can read it back. The setting is not limited to
the office network or to web ports: it includes the machine iHub runs on (by its non-loopback
address or service name), neighbouring containers, cluster control planes and any port of them.

**What is never allowed.** Whatever is approved or switched on, the server does not fetch loopback
(`127.0.0.0/8`, `::1`, `localhost`), link-local addresses (`169.254.0.0/16`, `fe80::/10`), reserved
ranges, or the cloud metadata services (`169.254.169.254` on AWS, Azure and GCP, `fd00:ec2::254`,
Alibaba's `100.100.100.200`, Azure's `168.63.129.16`, `192.0.0.0/24`). What an approval or the setting allows is the company network:
`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` and IPv6 `fc00::/7`. The address is
still resolved and pinned for the connection, and every redirect hop is checked again, so an
approved host cannot send the crawler on to another internal one. Only the site's own host and
port is fetched in any case. Behind a proxy, an internal host is fetched only when
`proxy.noProxy` lists it (the proxy would resolve the name itself, so the address check could not
hold); otherwise it is refused.

**API.** `GET /api/admin/website-corpus/domains` lists the requests (`{ items, nextCursor,
openCount }`, open ones first), `POST` on the same path allows a host (`201`), `POST …/{id}/_approve`
and `…/_decline` decide (`{ note? }`), `DELETE …/{id}` removes an entry. All need an admin.

## What is stored

A corpus belongs to the user who started it and nobody else can read it. It is kept in the
`website-corpora` namespace of the storage provider: one document with the settings and progress,
the URL list, and the extracted pages, one blob per crawl batch. It is removed after 14 days, and a
user keeps at most five; starting a sixth removes the oldest. The storage provider needs the
document and blob stores (the filesystem provider has both).

The requests and approvals for internal websites are kept in the `website-corpus-domains`
namespace, one document per host, until an admin removes them.

## Limits and settings

| Limit                              | Value                                            |
| ---------------------------------- | ------------------------------------------------ |
| Pages per corpus                   | 3,000 by default; **Most pages per corpus**, at most 10,000 |
| Pages per crawl call               | 60 by default, 100 at most; a call stops starting pages after 22 seconds |
| Parallel requests                  | 4 by default; **Parallel requests per crawl**, 1 to 16 |
| Pause between requests             | 400 ms by default; **Pause between requests (ms)**, 0 to 5000 |
| Corpora per user                   | 5                                                |
| Retention                          | 14 days                                          |
| Near-duplicate pairs listed        | 25 (the report gives the total; counting stops after 3,000 candidate pairs, and the report then says "at least") |
| Requests for websites                | 10 open per user, 20 requesters shown per host; at most 500 approved hosts are honoured |

## Code

`server/services/websiteCorpus/` (extraction, sitemap, statistics, report, storage, service),
the connector `server/services/integrations/protocols/native/connectors/websiteCorpus/`, and the
definition `server/defaults/integration-definitions/com.intrafind__website-corpus/`.
