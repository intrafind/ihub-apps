// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The website corpus sizer: how much text does a website really have, in
 * tokens, and does it fit into one context window?
 *
 * Five steps, each a call, because a crawl of thousands of pages cannot run
 * inside one tool call: `discoverSite` reads the sitemaps and starts a corpus,
 * `outlinePages` shows the structure of a few pages so the caller can name the
 * site's boilerplate, `crawlPages` fetches the next batch and keeps the main
 * text of each page (call it until it says it is done; it resumes where it
 * stopped), `readPageText` shows what was kept for one page, and
 * `corpusReport` computes the numbers and lays them out.
 *
 * Every network access is the guarded fetch of `./fetch.js`, the site's
 * robots.txt is honored, only pages on the corpus' own site are fetched, and a
 * corpus belongs to the user who started it. Counts of tokens come from the
 * injected `countTokens` (the shared estimator), and the report says which
 * method counted.
 *
 * @module services/websiteCorpus/WebsiteCorpusService
 */
import { parseRobotsTxt, robotsAllows } from '../projects/siteCrawler.js';
import { extractPage, outlinePage, validateSelector } from './extract.js';
import {
  checkHostReachable,
  configureCorpusThrottle,
  fetchRobotsText,
  fetchSitemapText,
  fetchSitePage
} from './fetch.js';
import { UNRESOLVED_HOST } from '../../utils/ssrfGuard.js';
import { DomainError, DomainStore, normalizeHost, splitHost } from './DomainStore.js';
import { renderReport } from './report.js';
import { buildDashboard } from './dashboard.js';
import { collectSiteUrls } from './sitemap.js';
import { DEFAULT_NEWS_SECTIONS, analyseCorpus, findNearDuplicates } from './stats.js';
import { hostKey, nonDefaultPort, normalizePrefix, sectionCounts, siteKeyOf } from './urls.js';

/** Defaults and limits. An installation may lower or raise `maxPages` within the cap. */
export const DEFAULT_MAX_PAGES = 3000;
export const MAX_PAGES_CAP = 10_000;
export const DEFAULT_BATCH_SIZE = 60;
export const MAX_BATCH_SIZE = 100;
/** A crawl call stops starting pages after this long, so its answer reaches the model in time. */
export const BATCH_DEADLINE_MS = 22_000;
/** The most characters of one page kept (a page longer than this is cut and counted). */
export const MAX_PAGE_CHARS = 400_000;
const MAX_STORED_FAILURES = 50;
const MAX_NAME_CHARS = 80;
const SPOT_CHECK_DEFAULT_CHARS = 1500;
const SPOT_CHECK_MAX_CHARS = 8000;

/** An error the connector turns into a message the model can act on. */
export class WebsiteCorpusError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'WebsiteCorpusError';
    this.code = code;
  }
}

/** The user of a call; a corpus needs an account to belong to. */
function requireUser(user) {
  if (!user?.id || user.id === 'anonymous') {
    throw new WebsiteCorpusError(
      'SIGN_IN_REQUIRED',
      'The website corpus sizer keeps its crawl for the signed-in user; sign in to use it.'
    );
  }
  return user.id;
}

function parseSiteUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new WebsiteCorpusError(
      'INVALID_URL',
      'siteUrl must be an http(s) address such as https://www.example.com'
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebsiteCorpusError('INVALID_URL', 'siteUrl must be an http(s) address');
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  return url;
}

const clampInt = (value, fallback, min, max) => {
  const number = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
  return Math.min(max, Math.max(min, number));
};

/** How the figures were counted, in the words of the report. */
export function tokenizerNote(info) {
  return info.method === 'o200k_base'
    ? 'counted with the o200k_base tokenizer, exact for OpenAI models and typically within 10 to 20 percent for other model families; German text can need more'
    : 'counted as one token per 4 characters, because this server has no tokenizer library installed; this is a rough approximation that can be off in either direction, so treat the figures as approximate';
}

/**
 * The service. Collaborators are injected so tests run without a network or a
 * storage provider.
 */
export class WebsiteCorpusService {
  /**
   * @param {Object} deps
   * @param {import('./CorpusStore.js').CorpusStore} deps.store
   * @param {(text: string) => number} deps.countTokens
   * @param {() => {method: string}} deps.tokenizerInfo
   * @param {typeof fetchSitePage} [deps.fetchPage]
   * @param {typeof fetchRobotsText} [deps.fetchRobots]
   * @param {typeof fetchSitemapText} [deps.fetchSitemap]
   * @param {import('./DomainStore.js').DomainStore} [deps.domains] - Approved and requested internal hosts
   * @param {typeof checkHostReachable} [deps.hostCheck]
   * @param {() => number} [deps.now]
   */
  constructor({
    store,
    countTokens,
    tokenizerInfo,
    fetchPage = fetchSitePage,
    fetchRobots = fetchRobotsText,
    fetchSitemap = fetchSitemapText,
    domains = new DomainStore(),
    hostCheck = checkHostReachable,
    now = Date.now
  }) {
    Object.assign(this, {
      store,
      countTokens,
      tokenizerInfo,
      fetchPage,
      fetchRobots,
      fetchSitemap,
      domains,
      hostCheck,
      now
    });
  }

  /**
   * Which hosts may be company-internal addresses for this call: all of them
   * when the installation allows internal addresses, otherwise the hosts an
   * admin approved. Loopback, link-local and cloud metadata addresses are
   * never reachable either way.
   *
   * @param {{allowPrivateAddresses?: boolean}} context
   * @returns {Promise<{allowPrivate: (hostname: string, port: string) => boolean}>}
   */
  async policyFor({ allowPrivateAddresses = false } = {}) {
    const approved = await this.domains.approvedHosts(this.now()).catch(() => []);
    return {
      // The crawl treats `www.x` and `x` as one site, so an approval of either covers both.
      allowPrivate: (hostname, port) =>
        allowPrivateAddresses === true ||
        [hostname, hostKey(hostname), `www.${hostKey(hostname)}`].some(name =>
          DomainStore.covers(approved, name, port)
        )
    };
  }

  /**
   * The refusal for a host the server may not fetch, with what the user can do
   * about it: ask for it to be allowed, when an approval would help.
   */
  async refusalFor(site, verdict) {
    const bare = site.hostname.replace(/^\[|\]$/g, '');
    const port = nonDefaultPort(site.port);
    // As an approval names it: the host, and its port when that is not 80 or 443.
    const host = port && !bare.includes(':') ? `${bare}:${port}` : bare;
    if (verdict.code === UNRESOLVED_HOST) {
      return new WebsiteCorpusError(
        'HOST_NOT_RESOLVED',
        `The host name ${host} does not resolve from this server. Check the spelling; an internal name needs the server's DNS to know it.`
      );
    }
    const everAllowed = await this.hostCheck(site, { allowPrivate: () => true });
    if (!everAllowed.ok) {
      return new WebsiteCorpusError(
        'HOST_NEVER_ALLOWED',
        `${host} is not reachable from this server (${verdict.reason}). Loopback, link-local and cloud metadata addresses are never allowed, and no approval changes that.`
      );
    }
    const known = await this.domains.find(host).catch(() => null);
    const state =
      known?.status === 'requested'
        ? 'A request for it is already waiting for an admin to decide.'
        : known?.status === 'declined'
          ? `An admin declined a request for it${known.note ? `: ${known.note}` : '.'}`
          : 'The user can ask for it to be allowed: call website_corpus_request_domain with the host and a short reason. An admin then approves it, and the discovery can be run again.';
    return new WebsiteCorpusError(
      'HOST_NOT_ALLOWED',
      `${host} is a company-internal address, which this server may not fetch (${verdict.reason}). ${state}`
    );
  }

  /**
   * A user's request that the Website Corpus may reach an internal host. An
   * admin decides; nothing is allowed by asking.
   *
   * @param {Object} args
   * @param {string} args.host - A host name, or a URL on it
   * @param {string} [args.reason] - Why the site should be sized
   * @param {Object} context
   * @returns {Promise<Object>}
   */
  async requestDomain({ host, reason }, context) {
    const { user } = context;
    requireUser(user);
    let name;
    try {
      name = normalizeHost(host);
    } catch (error) {
      if (error instanceof DomainError) throw new WebsiteCorpusError(error.code, error.message);
      throw error;
    }
    const { name: hostName, port } = splitHost(name);
    let site;
    try {
      site = new URL(
        `https://${hostName.includes(':') ? `[${hostName}]` : hostName}${port ? `:${port}` : ''}`
      );
    } catch {
      throw new WebsiteCorpusError('INVALID_HOST', `"${name}" is not a valid host name`);
    }
    const verdict = await this.hostCheck(site, await this.policyFor(context));
    if (verdict.ok) {
      return {
        status: 'not_needed',
        host: name,
        message: `${name} can be fetched already, so no request is needed. Start with the discovery step.`
      };
    }
    const refusal = await this.refusalFor(site, verdict);
    if (refusal.code !== 'HOST_NOT_ALLOWED') throw refusal;

    const { entry, created } = await this.domains.request({ host: name, user, reason });
    const message = {
      requested: created
        ? `The request for ${name} was sent. An admin has to approve it before it can be crawled; the user can start again once they have.`
        : `${name} was requested already and is waiting for an admin.`,
      approved: `${name} is approved. It may take up to half a minute to take effect; then run the discovery again.`,
      declined: `An admin declined a request for ${name}${entry.note ? `: ${entry.note}` : '.'}`
    }[entry.status];
    return {
      status: entry.status,
      host: name,
      requestedAt: entry.createdAt,
      ...(entry.note ? { note: entry.note } : {}),
      message
    };
  }

  /**
   * Read the sitemaps of a site and start a corpus.
   *
   * @param {Object} args
   * @param {string} args.siteUrl
   * @param {string} [args.name]
   * @param {string} [args.prefix] - Only paths under it, e.g. `/de/`
   * @param {string[]} [args.sitemapUrls]
   * @param {Object} context
   * @param {Object} context.user
   * @param {number} [context.maxPages]
   * @returns {Promise<Object>}
   */
  async discoverSite(
    { siteUrl, name, prefix, sitemapUrls = [] },
    { user, maxPages = DEFAULT_MAX_PAGES, allowPrivateAddresses = false }
  ) {
    const ownerId = requireUser(user);
    const site = parseSiteUrl(siteUrl);
    const scope = normalizePrefix(prefix);
    const limit = clampInt(maxPages, DEFAULT_MAX_PAGES, 1, MAX_PAGES_CAP);
    const policy = await this.policyFor({ allowPrivateAddresses });
    const verdict = await this.hostCheck(site, policy);
    if (!verdict.ok) throw await this.refusalFor(site, verdict);

    const robotsText = await this.fetchRobots(site.origin, { policy });
    const rules = parseRobotsTxt(robotsText);
    const found = await collectSiteUrls({
      siteUrl: site.href,
      prefix: scope,
      sitemapUrls,
      robotsText,
      fetchText: url => this.fetchSitemap(url, { policy }),
      maxUrls: limit + 1
    });

    const summary = {
      site: site.origin,
      scope: scope || '(whole site)',
      sitemapsRead: found.sitemapsRead,
      sitemapsFailed: found.failed,
      skipped: found.skipped,
      robotsTxtFound: robotsText !== null
    };
    if (found.urls.length === 0) {
      return {
        ...summary,
        pages: 0,
        message:
          'No page URLs were found. The site may have no sitemap, or the scope prefix matches none of its URLs. ' +
          'Ask the user: name the sitemap address (sitemapUrls), check the prefix, or accept that this site cannot be sized from a sitemap.'
      };
    }
    if (found.urls.length > limit) {
      throw new WebsiteCorpusError(
        'TOO_MANY_PAGES',
        `The sitemaps list more than ${limit} pages in this scope, which is this installation's limit. ` +
          'Narrow the scope with a prefix (for example /de/), or ask an admin to raise the limit.'
      );
    }

    const blockedByRobots = found.urls.filter(url => !robotsAllows(url, rules)).length;
    // Room is made only now: a discovery that ends without a corpus (a scope that is too wide,
    // no pages found) must not cost the user one they still use.
    await this.store.prune(ownerId, this.now());
    const corpus = await this.store.create(
      ownerId,
      {
        name: String(name || site.hostname).slice(0, MAX_NAME_CHARS),
        siteUrl: site.origin,
        host: siteKeyOf(site),
        prefix: scope,
        dropSelector: '',
        rules,
        total: found.urls.length,
        cursor: 0,
        crawled: 0,
        failed: 0,
        blockedByRobots: 0,
        notHtml: 0,
        truncatedPages: 0,
        failures: [],
        lastCrawledAt: null
      },
      found.urls
    );
    return {
      ...summary,
      corpusId: corpus.id,
      pages: found.urls.length,
      blockedByRobots,
      sections: sectionCounts(found.urls, scope).slice(0, 30),
      sampleUrls: found.urls.slice(0, 5),
      next:
        'Show the user the sections and compare them with the site. Then call the outline step on a few pages to find the ' +
        "site's boilerplate, and the crawl step until it reports done."
    };
  }

  /**
   * The structure of a few pages of a corpus, to find what to drop.
   *
   * @param {Object} args
   * @param {string} args.corpusId
   * @param {number} [args.count=3]
   * @param {string[]} [args.urlContains] - Only pages whose URL contains one of these
   * @param {Object} context
   * @returns {Promise<Object>}
   */
  async outlinePages({ corpusId, count = 3, urlContains = [] }, { user, allowPrivateAddresses }) {
    const corpus = await this.store.get(corpusId, requireUser(user));
    const policy = await this.policyFor({ allowPrivateAddresses });
    let urls = await this.store.urls(corpus.id);
    if (urlContains.length) urls = urls.filter(url => urlContains.some(part => url.includes(part)));
    const wanted = clampInt(count, 3, 1, 3);
    const step = Math.max(1, Math.floor(urls.length / wanted));
    const chosen = urls.filter((_url, index) => index % step === 0).slice(0, wanted);
    const pages = [];
    for (const url of chosen) {
      if (!robotsAllows(url, corpus.rules)) {
        pages.push({ url, error: 'Blocked by robots.txt' });
        continue;
      }
      try {
        const page = await this.fetchPage(url, { siteHost: corpus.host, policy });
        const outline = page.html ? outlinePage(page.html) : null;
        pages.push(
          outline
            ? { url, ...outline }
            : {
                url,
                error: page.offSite
                  ? 'Redirected to another site'
                  : `Not an HTML page (HTTP ${page.status})`
              }
        );
      } catch (error) {
        pages.push({ url, error: error.message });
      }
    }
    return {
      corpusId: corpus.id,
      pages,
      next:
        'Entries marked "<- drop?" are candidates. Keep anything that holds real content. Give the crawl step a dropSelector ' +
        'such as ".breadcrumb, .cookie-banner" (CSS selectors, comma-separated), or none if nothing needs to go.'
    };
  }

  /**
   * Fetch the next batch of pages of a corpus and keep their main text.
   *
   * @param {Object} args
   * @param {string} args.corpusId
   * @param {string} [args.dropSelector]
   * @param {number} [args.batchSize]
   * @param {boolean} [args.restart] - Start the crawl over (needed to change the selector after pages were kept)
   * @param {Object} context
   * @param {number} [context.crawlConcurrency] - Requests in flight at once (the installation's setting)
   * @param {number} [context.requestDelayMs] - Pause after a request before the next may start
   * @returns {Promise<Object>}
   */
  async crawlPages(
    { corpusId, dropSelector, batchSize, restart = false },
    { user, allowPrivateAddresses, crawlConcurrency, requestDelayMs }
  ) {
    const ownerId = requireUser(user);
    const policy = await this.policyFor({ allowPrivateAddresses });
    // The settings reach the throttle queue and size the worker pool: a worker without a free
    // slot would only wait in the queue, so the pool is exactly as wide as the queue lets run.
    const throttle = configureCorpusThrottle({ crawlConcurrency, requestDelayMs });
    // Ownership first, so an unknown corpus or another user's id is answered at once instead of
    // waiting behind a running crawl's lock (a batch holds it for up to 22 s, the wait is 5 s).
    // It is checked again below, on the corpus as it is under the lock.
    await this.store.get(corpusId, ownerId);
    return this.store.withCorpus(corpusId, async () => {
      let corpus = await this.store.get(corpusId, ownerId);
      let selector = corpus.dropSelector;
      if (dropSelector !== undefined) {
        const wanted = validateSelector(dropSelector);
        if (wanted !== corpus.dropSelector) {
          if (corpus.cursor > 0 && !restart) {
            throw new WebsiteCorpusError(
              'SELECTOR_CHANGED',
              `${corpus.cursor} pages were already crawled with the selector "${corpus.dropSelector}". ` +
                'Changing it means crawling again from the start: call with restart set to true if that is what the user wants.'
            );
          }
          selector = wanted;
        }
      }
      if (restart || selector !== corpus.dropSelector) {
        corpus = {
          ...corpus,
          dropSelector: selector,
          cursor: 0,
          crawled: 0,
          failed: 0,
          blockedByRobots: 0,
          notHtml: 0,
          truncatedPages: 0,
          failures: [],
          batches: 0
        };
        // The reset is stored first: a crash between the two steps leaves pages that the next
        // crawl overwrites, not a corpus whose counters disagree with its pages.
        corpus = await this.store.save(corpus);
        await this.store.removePages(corpus.id);
      }

      const urls = await this.store.urls(corpus.id);
      const size = clampInt(batchSize, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
      const slice = urls.slice(corpus.cursor, corpus.cursor + size);
      const deadline = this.now() + BATCH_DEADLINE_MS;
      const kept = [];
      const failures = [];
      const counters = { failed: 0, blockedByRobots: 0, notHtml: 0, truncatedPages: 0 };
      let started = 0;

      const worker = async () => {
        while (started < slice.length && this.now() < deadline) {
          const url = slice[started];
          started += 1;
          const result = await this.crawlOne(url, corpus, selector, policy);
          if (result.page) kept.push(result.page);
          if (result.counter) counters[result.counter] += 1;
          if (result.failure) failures.push(result.failure);
        }
      };
      // Pool of workers, as many as the throttle queue lets run at once.
      await Promise.all(Array.from({ length: throttle.concurrency }, worker));

      // The pool takes pages in order, so what started is a prefix of the slice;
      // keep the batch in sitemap order.
      const order = new Map(slice.map((url, index) => [url, index]));
      kept.sort((a, b) => order.get(a.requestedUrl) - order.get(b.requestedUrl));
      if (kept.length) {
        await this.store.putPages(
          corpus.id,
          corpus.batches,
          kept.map(({ requestedUrl: _requested, ...page }) => page)
        );
      }
      const next = await this.store.save({
        ...corpus,
        batches: corpus.batches + (kept.length ? 1 : 0),
        cursor: corpus.cursor + started,
        crawled: corpus.crawled + kept.length,
        failed: corpus.failed + counters.failed,
        blockedByRobots: corpus.blockedByRobots + counters.blockedByRobots,
        notHtml: corpus.notHtml + counters.notHtml,
        truncatedPages: corpus.truncatedPages + counters.truncatedPages,
        failures: [...corpus.failures, ...failures].slice(0, MAX_STORED_FAILURES),
        lastCrawledAt: new Date(this.now()).toISOString()
      });
      const done = next.cursor >= next.total;
      return {
        corpusId: next.id,
        done,
        total: next.total,
        attempted: next.cursor,
        remaining: next.total - next.cursor,
        crawled: next.crawled,
        failed: next.failed,
        blockedByRobots: next.blockedByRobots,
        notHtml: next.notHtml,
        dropSelector: next.dropSelector,
        newFailures: failures.slice(0, 5),
        next: done
          ? 'The crawl is complete. Spot-check a few pages with the page text step, then produce the report.'
          : `Call the crawl step again (${next.total - next.cursor} pages remain). Tell the user the progress.`
      };
    });
  }

  /** Fetch and extract one page; never throws. */
  async crawlOne(url, corpus, selector, policy) {
    if (!robotsAllows(url, corpus.rules)) return { counter: 'blockedByRobots' };
    try {
      const page = await this.fetchPage(url, { siteHost: corpus.host, policy });
      if (page.offSite) {
        return { counter: 'failed', failure: { url, reason: 'redirected to another site' } };
      }
      if (!page.html) {
        return page.status >= 400
          ? { counter: 'failed', failure: { url, reason: `HTTP ${page.status}` } }
          : { counter: 'notHtml' };
      }
      const extracted = extractPage(page.html, { dropSelector: selector });
      if (!extracted) return { counter: 'failed', failure: { url, reason: 'no <main> or <body>' } };
      const cut = extracted.text.length > MAX_PAGE_CHARS;
      const text = cut ? extracted.text.slice(0, MAX_PAGE_CHARS) : extracted.text;
      return {
        counter: cut || page.truncated ? 'truncatedPages' : null,
        page: {
          requestedUrl: url,
          url,
          title: extracted.title,
          date: extracted.date,
          text,
          chars: text.length,
          tokens: this.countTokens(text)
        }
      };
    } catch (error) {
      return {
        counter: 'failed',
        failure: { url, reason: String(error.message || error).slice(0, 200) }
      };
    }
  }

  /**
   * The text kept for one page, for a spot-check against the live site.
   *
   * @param {Object} args
   * @param {string} args.corpusId
   * @param {string} [args.url] - The page's URL, or part of it
   * @param {number} [args.maxChars]
   * @param {Object} context
   * @returns {Promise<Object>}
   */
  async readPageText({ corpusId, url, maxChars }, { user }) {
    const corpus = await this.store.get(corpusId, requireUser(user));
    const limit = clampInt(maxChars, SPOT_CHECK_DEFAULT_CHARS, 200, SPOT_CHECK_MAX_CHARS);
    const pages = await this.store.pages(corpus.id, corpus.batches);
    const page = url
      ? pages.find(item => item.url === url) || pages.find(item => item.url.includes(url))
      : pages[0];
    if (!page) {
      throw new WebsiteCorpusError('PAGE_NOT_FOUND', 'No crawled page matches that URL yet.');
    }
    return {
      url: page.url,
      title: page.title,
      chars: page.chars,
      tokens: page.tokens,
      shownChars: Math.min(limit, page.text.length),
      text: page.text.slice(0, limit)
    };
  }

  /**
   * The numbers and the report of a corpus.
   *
   * @param {Object} args
   * @param {string} args.corpusId
   * @param {string} [args.name]
   * @param {string[]} [args.newsSections] - Section names left out of the core pages; `[]` for none
   * @param {Object} context
   * @returns {Promise<Object>}
   */
  async corpusReport({ corpusId, name, newsSections, dashboard, language }, { user }) {
    const corpus = await this.store.get(corpusId, requireUser(user));
    const pages = await this.store.pages(corpus.id, corpus.batches);
    if (!pages.length) {
      throw new WebsiteCorpusError(
        'NOTHING_CRAWLED',
        'No pages have been crawled yet; run the crawl step first.'
      );
    }
    const analysis = await analyseCorpus(pages, {
      countTokens: this.countTokens,
      prefix: corpus.prefix,
      newsSections: Array.isArray(newsSections) ? newsSections : DEFAULT_NEWS_SECTIONS
    });
    const nearDuplicates = await findNearDuplicates(pages);
    const info = this.tokenizerInfo();
    const notCrawled = corpus.total - corpus.cursor;
    const input = {
      name: String(name || corpus.name),
      analysis,
      nearDuplicates,
      tokenizer: { method: info.method, note: tokenizerNote(info) },
      meta: {
        crawlDate: (corpus.lastCrawledAt || corpus.createdAt).slice(0, 10),
        siteUrl: corpus.siteUrl,
        prefix: corpus.prefix,
        dropSelector: corpus.dropSelector,
        coverage: {
          inSitemap: corpus.total,
          crawled: corpus.crawled,
          failed: corpus.failed,
          blockedByRobots: corpus.blockedByRobots,
          notHtml: corpus.notHtml,
          notCrawled
        }
      }
    };
    const markdown = renderReport(input);
    return {
      corpusId: corpus.id,
      complete: notCrawled === 0,
      tokenizer: info.method,
      pages: analysis.totals.pages,
      tokens: analysis.totals.tokens,
      tokensDedup: analysis.totals.tokensDedup,
      failedPages: corpus.failures.slice(0, 10),
      report: markdown,
      // The same numbers laid out for the `dashboard` skill, only when asked for.
      ...(dashboard === true ? { dashboard: buildDashboard({ ...input, language }) } : {}),
      next:
        'Show the report to the user unchanged (tables and chart), then add the verdict, the oddities and the next steps. ' +
        'Never recalculate a figure.' +
        (dashboard === true
          ? ' Then create the dashboard: activate the "dashboard" skill and call create_web_artifact with preset "dashboard" and the "dashboard" field of this result, unchanged, as the JSON text of "data".'
          : '')
    };
  }
}
