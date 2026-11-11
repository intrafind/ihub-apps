// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Built-in connector of the Website Corpus integration
 * (`com.intrafind/website-corpus`, installation `website-corpus`): the five
 * actions that measure how much text a website has, in tokens, and whether it
 * fits into one context window. The work is in
 * `services/websiteCorpus/WebsiteCorpusService.js`; this module declares the
 * actions and hands the model's arguments over.
 *
 * | Action          | Tool id                   | What it does |
 * | --------------- | ------------------------- | ------------ |
 * | `discover_site` | `website_corpus_discover` | Reads the sitemaps, starts a corpus, lists the sections |
 * | `outline_pages` | `website_corpus_outline`  | Shows the structure of a few pages, to find boilerplate |
 * | `crawl_pages`   | `website_corpus_crawl`    | Fetches the next batch of pages (call until done) |
 * | `read_page_text`| `website_corpus_page_text`| The kept text of one page, for a spot-check |
 * | `corpus_report` | `website_corpus_report`   | The numbers and the report |
 * | `request_domain`| `website_corpus_request_domain` | Asks an admin to allow an internal host the crawl was refused for |
 *
 * Tokens are counted with the shared estimator (`shared/tokenEstimator.js`);
 * the report says whether that was the o200k_base tokenizer or the
 * four-characters-per-token fallback.
 */
import { estimateTokens, tokenizerInfo } from '../../../../../../../shared/tokenEstimator.js';
import { getCorpusStore, CorpusError } from '../../../../../websiteCorpus/CorpusStore.js';
import { LockTimeoutError } from '../../../../../../storage/errors.js';
import { DomainError, getDomainStore } from '../../../../../websiteCorpus/DomainStore.js';
import {
  DEFAULT_MAX_PAGES,
  WebsiteCorpusError,
  WebsiteCorpusService
} from '../../../../../websiteCorpus/WebsiteCorpusService.js';

const PARAMETER_REQUEST_DOMAIN = {
  type: 'object',
  properties: {
    host: {
      type: 'string',
      description:
        'The host name of the internal website the discovery refused, for example intranet.example.corp (a full address is reduced to its host).'
    },
    reason: {
      type: 'string',
      maxLength: 500,
      description: 'Why the site should be sized, in a sentence or two, for the admin who decides.'
    }
  },
  required: ['host']
};

const corpusId = {
  type: 'string',
  description: 'The corpusId returned by website_corpus_discover.'
};

const PARAMETERS = {
  request_domain: PARAMETER_REQUEST_DOMAIN,
  discover_site: {
    type: 'object',
    properties: {
      siteUrl: {
        type: 'string',
        description: 'Address of the website, for example https://www.example.com'
      },
      name: {
        type: 'string',
        description: 'A short name for the report title, for example the company name.'
      },
      prefix: {
        type: 'string',
        description:
          'Only count pages whose path starts with this, for example /de/ for the German pages. Leave out for the whole site.'
      },
      sitemapUrls: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Sitemap addresses to read instead of the ones named in robots.txt. Only when the site has no sitemap entry in robots.txt.'
      }
    },
    required: ['siteUrl']
  },
  outline_pages: {
    type: 'object',
    properties: {
      corpusId,
      count: {
        type: 'integer',
        minimum: 1,
        maximum: 3,
        description: 'How many pages (default 3).'
      },
      urlContains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only pages whose address contains one of these, for example "/blog/".'
      }
    },
    required: ['corpusId']
  },
  crawl_pages: {
    type: 'object',
    properties: {
      corpusId,
      dropSelector: {
        type: 'string',
        description:
          'CSS selectors, comma-separated, of blocks inside <main> that are not content (breadcrumbs, cookie banners, teaser sliders), for example ".breadcrumb, .cookie-banner". Set it on the first call; an empty string means nothing is dropped.'
      },
      batchSize: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description:
          'Pages to fetch in this call (default 60). A call stops starting pages after about 22 seconds and reports how many remain, so a large batch is safe.'
      },
      restart: {
        type: 'boolean',
        description:
          'Start the crawl over from the first page. Needed to change dropSelector once pages were crawled.'
      }
    },
    required: ['corpusId']
  },
  read_page_text: {
    type: 'object',
    properties: {
      corpusId,
      url: {
        type: 'string',
        description: 'The page address, or part of it. Default: the first page.'
      },
      maxChars: {
        type: 'integer',
        minimum: 200,
        maximum: 8000,
        description: 'How many characters to show (default 1500).'
      }
    },
    required: ['corpusId']
  },
  corpus_report: {
    type: 'object',
    properties: {
      corpusId,
      name: {
        type: 'string',
        description: 'Site name for the report title (default: the one given at discovery).'
      },
      newsSections: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Section names treated as blog or news for the "core pages" rows, replacing the default list (blog, news, newsroom, aktuelles, presse, press, magazin, magazine, neuigkeiten). An empty list leaves those rows out.'
      },
      dashboard: {
        type: 'boolean',
        description:
          'Also return the result as a "dashboard" spec for the dashboard skill (create_web_artifact with preset "dashboard"). Ask for it only when the dashboard skill is available.'
      },
      language: {
        type: 'string',
        enum: ['en', 'de'],
        description:
          'Language of the dashboard texts (default en). Use the language the user writes in.'
      }
    },
    required: ['corpusId']
  }
};

/** The service on the active storage provider. */
function service() {
  return new WebsiteCorpusService({
    store: getCorpusStore(),
    domains: getDomainStore(),
    countTokens: estimateTokens,
    tokenizerInfo
  });
}

/**
 * Run a service call. The errors the model can act on (a bad address, an
 * unknown corpus, a limit) come back as an error result with a code; anything
 * else is a bug and is thrown.
 */
async function guarded(call) {
  try {
    return await call();
  } catch (error) {
    if (
      error instanceof WebsiteCorpusError ||
      error instanceof CorpusError ||
      error instanceof DomainError ||
      error?.code === 'INVALID_SELECTOR'
    ) {
      return { error: true, code: error.code, message: error.message };
    }
    if (error instanceof LockTimeoutError) {
      return {
        error: true,
        code: 'CORPUS_BUSY',
        message:
          'Another call is still working on this corpus. Wait a moment for it to finish, then call again.'
      };
    }
    throw error;
  }
}

/** `maxPages` of the installation, within the service's cap. */
const maxPagesOf = ctx => Number(ctx.values?.maxPages) || DEFAULT_MAX_PAGES;

/** Whether the installation lets crawls reach company-internal addresses. */
const allowPrivateOf = ctx => ctx.values?.allowPrivateAddresses === true;

/** The crawl speed of the installation; the service clamps and defaults what is missing. */
const crawlSpeedOf = ctx => ({
  crawlConcurrency: ctx.values?.crawlConcurrency,
  requestDelayMs: ctx.values?.requestDelayMs
});

function action(name, call) {
  return {
    parameters: PARAMETERS[name],
    run: (args, ctx) =>
      guarded(() =>
        call(service(), args || {}, {
          user: ctx.user,
          maxPages: maxPagesOf(ctx),
          allowPrivateAddresses: allowPrivateOf(ctx),
          ...crawlSpeedOf(ctx)
        })
      )
  };
}

/** The installation test: storage can keep a crawl, and which tokenizer counts. */
async function test() {
  const steps = [];
  const store = getCorpusStore();
  steps.push({
    id: 'storage',
    label: 'Storage',
    status: store.isAvailable() ? 'ok' : 'fail',
    message: store.isAvailable()
      ? 'The storage provider can keep crawled pages'
      : 'The storage provider has no document and blob store: crawled pages cannot be kept'
  });
  const info = tokenizerInfo();
  steps.push({
    id: 'tokenizer',
    label: 'Token counting',
    status: info.method === 'o200k_base' ? 'ok' : 'warn',
    message:
      info.method === 'o200k_base'
        ? 'Tokens are counted with the o200k_base tokenizer'
        : 'The server has no tokenizer library: tokens are counted as one per 4 characters, a rough approximation'
  });
  return steps;
}

const connector = {
  id: 'websiteCorpus',
  actions: {
    discover_site: action('discover_site', (svc, args, context) => svc.discoverSite(args, context)),
    outline_pages: action('outline_pages', (svc, args, context) => svc.outlinePages(args, context)),
    crawl_pages: action('crawl_pages', (svc, args, context) => svc.crawlPages(args, context)),
    read_page_text: action('read_page_text', (svc, args, context) =>
      svc.readPageText(args, context)
    ),
    corpus_report: action('corpus_report', (svc, args, context) => svc.corpusReport(args, context)),
    request_domain: action('request_domain', (svc, args, context) =>
      svc.requestDomain(args, context)
    )
  },
  test,
  status() {
    return { connected: true, toolCount: 6 };
  },
  invalidate() {},
  onChanged() {}
};

export default connector;
