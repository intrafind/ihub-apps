// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeftIcon, ArrowRightIcon, Bars3BottomLeftIcon } from '@heroicons/react/24/outline';
import { ChevronRightIcon } from '@heroicons/react/20/solid';
import './AdminDocsPage.css';
import { makeAdminApiCall } from '../../../api/adminApi';
import { renderInlineMarkdown, renderMarkdown } from '../../../config/marked.config';
import { useCodeBlockInteractions } from '../../../hooks/useCodeBlockInteractions';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import DocsDrawer from '../components/docs/DocsDrawer';
import DocsOutline from '../components/docs/DocsOutline';
import DocsSearch from '../components/docs/DocsSearch';
import {
  buildReleaseTree,
  defaultExpandedGroups,
  visibleReleases
} from '../utils/changelogReleaseTree';
import {
  decodeFragment,
  handleDocsLinkClick,
  releaseSourcePath,
  rewriteDocsHtml
} from '../utils/docsLinks';
import { highlightDocsCode } from '../utils/docsHighlight';

/**
 * Admin → What's New.
 *
 * `GET /admin/changelog` lists every release that has release notes (newest first, unreleased
 * changes ahead of them, with entry counts, and the `installed` / `isNew` flags the server
 * derives from the version this installation was upgraded from); `GET /admin/changelog/:version`
 * returns one release's entries per section, bodies as Markdown. One release is shown at a time,
 * and the page looks and behaves like Admin → Documentation: a sticky header with the breadcrumb
 * and the documentation search, the releases on the left (a drawer on small screens), the release
 * in the documentation's reading column — breaking changes, new & improved entries and fixes, in
 * that order, because breaking changes are what an admin has to act on — with newer/older at the
 * bottom, and "In this release" on wide screens. The URL names the release (`?version=5.6.4`), so
 * a link, a bookmark, a reload or Back lands on the same release.
 *
 * The switcher is a tree — `5.x` → `5.5.x` → the releases — because an installation that has been
 * running for a while has more releases than a flat list can show. Only the groups that hold the
 * selected release, the installed one or something the last upgrade brought in start open, and a
 * group longer than ten releases shows the newest ten until asked for the rest.
 */

/** Reading order. The keys match the sections the server returns. */
const SECTIONS = [
  {
    key: 'breakingChanges',
    file: 'breaking-changes.md',
    i18nKey: 'admin.changelog.breakingChanges',
    label: 'Breaking changes'
  },
  {
    key: 'features',
    file: 'features.md',
    i18nKey: 'admin.changelog.features',
    label: 'New & improved'
  },
  { key: 'fixes', file: 'fixes.md', i18nKey: 'admin.changelog.fixes', label: 'Fixes' }
];

/** A DOM id from arbitrary parts: version numbers contain dots, titles anything. */
const domId = (...parts) => parts.join('-').replace(/[^A-Za-z0-9_-]+/g, '-');

/**
 * In-page navigation without touching the router: scroll the target into view inside the admin
 * layout's own scroll container and move focus to it so keyboard and screen-reader users land
 * where the link points.
 */
function scrollToElement(event, id) {
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (typeof target.focus === 'function') {
    target.focus({ preventScroll: true });
  }
}

/** Letters and digits only: how a link fragment and an entry id are compared. */
const compact = text =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/**
 * The entry a link fragment such as `#configtoolsjson-is-removed` points to. Release notes link to
 * entries with mdBook's heading anchors, which drop punctuation where entry ids turn it into a
 * hyphen, so both are compared without anything but letters and digits.
 */
function findEntryForFragment(release, fragment) {
  const wanted = compact(decodeFragment(fragment));
  if (!wanted) return null;
  for (const section of SECTIONS) {
    const match = (release.sections?.[section.key] ?? []).find(
      entry => compact(entry.id) === wanted
    );
    if (match) return match;
  }
  return null;
}

/** Headings inside an entry body sit one level below the entry's own `<h3>`. */
const demoteHeadings = html =>
  html.replace(
    /<(\/?)h([1-5])(?=[\s>])/g,
    (match, slash, level) => `<${slash}h${Number(level) + 1}`
  );

const SCROLLER_ID = 'admin-main-content';

const BADGE_TONES = {
  indigo: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200',
  green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
};

function Badge({ tone, children }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-[11px] font-medium leading-4 ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** The link that selects a release: the query string is the selection. */
const releaseLink = version => ({ search: `?version=${encodeURIComponent(version)}` });

function ErrorBox({ message, onRetry, retryLabel }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
    >
      <span>{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="text-sm font-medium underline hover:no-underline"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}

/** A release in the switcher, drawn like a page in the documentation contents. */
function ReleaseLink({ release, selected, shortLabel, t }) {
  const active = release.version === selected;
  return (
    <Link
      to={releaseLink(release.version)}
      aria-current={active ? 'page' : undefined}
      className={`-ml-px flex flex-wrap items-center gap-x-2 gap-y-1 border-l-2 py-1 pl-3 pr-2 text-[13px] leading-5 transition-colors ${
        active
          ? 'border-indigo-600 font-medium text-indigo-700 dark:border-indigo-400 dark:text-indigo-300'
          : 'border-transparent text-gray-600 hover:border-gray-300 hover:text-gray-900 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-100'
      }`}
    >
      <span className="shrink-0">{shortLabel(release)}</span>
      {release.installed && (
        <Badge tone="green">{t('admin.changelog.installed', 'Installed')}</Badge>
      )}
      {release.isNew && <Badge tone="indigo">{t('admin.changelog.new', 'New')}</Badge>}
    </Link>
  );
}

function GroupCount({ count, newCount, t }) {
  return (
    <>
      <span className="font-normal tabular-nums text-gray-500 dark:text-gray-400">{count}</span>
      {newCount > 0 && (
        <Badge tone="indigo">
          {t('admin.changelog.newCount', '{{count}} new', { count: newCount })}
        </Badge>
      )}
    </>
  );
}

function MinorGroup({ minor, selected, expanded, onToggleGroup, shortLabel, t }) {
  const [showAll, setShowAll] = useState(false);
  const open = expanded.has(minor.key);
  const listId = domId('release-group', minor.key);
  const { releases, hidden } = visibleReleases(minor, { showAll, selected });

  return (
    <li>
      <button
        type="button"
        onClick={() => onToggleGroup(minor.key)}
        aria-expanded={open}
        aria-controls={listId}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 py-1 pl-3 pr-2 text-left text-[13px] font-medium leading-5 text-gray-900 hover:text-indigo-700 dark:text-gray-100 dark:hover:text-indigo-300"
      >
        <span>{t('admin.changelog.series', '{{series}}.x', { series: minor.key })}</span>
        <GroupCount count={minor.count} newCount={minor.newCount} t={t} />
        <ChevronRightIcon
          aria-hidden="true"
          className={`ml-auto h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <ul
          id={listId}
          className="mt-px ml-3 space-y-px border-l border-gray-200 dark:border-gray-800"
        >
          {releases.map(release => (
            <li key={release.version}>
              <ReleaseLink release={release} selected={selected} shortLabel={shortLabel} t={t} />
            </li>
          ))}
          {hidden > 0 && (
            <li>
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="block py-1 pl-3 pr-2 text-left text-[13px] leading-5 text-indigo-600 hover:underline dark:text-indigo-400"
              >
                {t('admin.changelog.showOlder', 'Show {{count}} older', { count: hidden })}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/**
 * The releases, drawn like the documentation contents: a major series is a section with a small
 * uppercase toggle, a minor series a group on the guide line, a release a page.
 */
function ReleaseSwitcher({ tree, selected, expanded, onToggleGroup, shortLabel, t }) {
  return (
    <nav aria-label={t('admin.changelog.versions', 'Releases')}>
      {tree.unreleased.length > 0 && (
        <ul className="mb-4 space-y-px">
          {tree.unreleased.map(release => (
            <li key={release.version}>
              <ReleaseLink release={release} selected={selected} shortLabel={shortLabel} t={t} />
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-4">
        {tree.majors.map(major => {
          const open = expanded.has(major.key);
          const listId = domId('release-group', major.key);
          return (
            <div key={major.key}>
              <button
                type="button"
                onClick={() => onToggleGroup(major.key)}
                aria-expanded={open}
                aria-controls={listId}
                className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-sm py-1.5 pr-1 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
              >
                <span className="normal-case">
                  {t('admin.changelog.series', '{{series}}.x', { series: major.major })}
                </span>
                <GroupCount count={major.count} newCount={major.newCount} t={t} />
                <ChevronRightIcon
                  aria-hidden="true"
                  className={`ml-auto h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}
                />
              </button>
              {open && (
                <ul id={listId} className="mt-1 space-y-px">
                  {major.minors.map(minor => (
                    <MinorGroup
                      key={minor.key}
                      minor={minor}
                      selected={selected}
                      expanded={expanded}
                      onToggleGroup={onToggleGroup}
                      shortLabel={shortLabel}
                      t={t}
                    />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * What the last upgrade brought in. Only shown when this installation remembers a previous
 * version and at least one release since then has notes — on a fresh installation, or when the
 * jump crossed no documented release, there is nothing to point at. Drawn as the documentation's
 * "Important" callout.
 */
function UpgradeNotice({ previousVersion, currentVersion, newCount, t }) {
  if (!previousVersion || !currentVersion || newCount === 0) return null;
  return (
    <section aria-labelledby="changelog-upgrade-notice" className="docs-prose mb-8">
      <div className="docs-callout docs-callout-important">
        <p id="changelog-upgrade-notice" className="docs-callout-title">
          {t('admin.changelog.upgradedFrom', 'Upgraded from {{previousVersion}} to {{version}}', {
            previousVersion,
            version: currentVersion
          })}
        </p>
        <p>
          {t(
            'admin.changelog.upgradedReleases',
            '{{count}} releases are new to this installation — every one of them is marked New.',
            { count: newCount }
          )}
        </p>
      </div>
    </section>
  );
}

/**
 * "In this release": the overview at the top of every release, on every screen width. A row of
 * quick links jumps straight to breaking changes, new & improved or fixes; below it every entry,
 * grouped by section, so a long release can be scanned and any entry reached in one click. Every
 * section ends with a link back here.
 */
function TableOfContents({ id, release, sectionLabel, t }) {
  const groups = SECTIONS.filter(section => release.sections[section.key].length > 0);
  return (
    <nav
      id={id}
      tabIndex={-1}
      aria-label={t('admin.changelog.contents', 'In this release')}
      className="mb-10 scroll-mt-20 rounded-lg border border-gray-200 p-4 focus:outline-hidden dark:border-gray-800"
    >
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {t('admin.changelog.contents', 'In this release')}
      </p>
      <ul className="mb-4 flex flex-wrap gap-2">
        {groups.map(section => {
          const sectionDomId = domId('release', release.version, section.key);
          const breaking = section.key === 'breakingChanges';
          return (
            <li key={section.key}>
              <a
                href={`#${sectionDomId}`}
                onClick={event => scrollToElement(event, sectionDomId)}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                  breaking
                    ? 'border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300 dark:hover:bg-amber-900/40'
                    : 'border border-gray-200 bg-gray-50 text-gray-800 hover:border-indigo-300 hover:text-indigo-700 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-200 dark:hover:border-indigo-700 dark:hover:text-indigo-300'
                }`}
              >
                {sectionLabel(section)}{' '}
                <span
                  className={`tabular-nums font-normal ${
                    breaking
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-gray-600 dark:text-gray-400'
                  }`}
                >
                  {release.sections[section.key].length}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      <div className="space-y-4">
        {groups.map(section => {
          const entries = release.sections[section.key];
          const sectionDomId = domId('release', release.version, section.key);
          return (
            <div key={section.key}>
              <a
                href={`#${sectionDomId}`}
                onClick={event => scrollToElement(event, sectionDomId)}
                className="text-sm font-semibold text-gray-900 hover:text-indigo-700 dark:text-gray-100 dark:hover:text-indigo-300"
              >
                {sectionLabel(section)}{' '}
                <span className="font-normal text-gray-500 dark:text-gray-400">
                  {entries.length}
                </span>
              </a>
              <ul
                className={`mt-1 space-y-1 ${entries.length > 6 ? 'sm:columns-2 sm:gap-x-8' : ''}`}
              >
                {entries.map(entry => (
                  <li key={entry.id} className="break-inside-avoid">
                    <a
                      href={`#${entry.domId}`}
                      onClick={event => scrollToElement(event, entry.domId)}
                      className="text-sm text-gray-600 hover:text-indigo-700 dark:text-gray-400 dark:hover:text-indigo-300"
                      // Titles are Markdown (inline code is common); rendered and sanitized
                      // with the shared marked config.
                      dangerouslySetInnerHTML={{ __html: entry.titleHtml }}
                    />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}

function ReleaseEntry({ entry }) {
  return (
    <article aria-labelledby={entry.domId}>
      <h3
        id={entry.domId}
        tabIndex={-1}
        className="focus:outline-hidden"
        dangerouslySetInnerHTML={{ __html: entry.titleHtml }}
      />
      {entry.bodyHtml && (
        // Sanitized by renderMarkdown (DOMPurify) before it gets here.
        <div dangerouslySetInnerHTML={{ __html: entry.bodyHtml }} />
      )}
    </article>
  );
}

function ReleaseSection({ section, entries, release, first, tocId, sectionLabel, t }) {
  const breaking = section.key === 'breakingChanges';
  const sectionDomId = domId('release', release.version, section.key);

  return (
    <section aria-labelledby={sectionDomId}>
      <h2
        id={sectionDomId}
        tabIndex={-1}
        className={`focus:outline-hidden ${first ? 'mt-0!' : ''}`}
      >
        {sectionLabel(section)}{' '}
        <span className="font-normal text-gray-500 dark:text-gray-400">{entries.length}</span>
      </h2>
      {breaking && (
        <div className="docs-callout docs-callout-warning">
          <p className="docs-callout-title">
            {t(
              'admin.changelog.breakingChangesHint',
              'Action is needed before or after upgrading.'
            )}
          </p>
        </div>
      )}
      {entries.map(entry => (
        <ReleaseEntry key={entry.id} entry={entry} />
      ))}
      <p className="mt-6 text-right text-sm">
        <a
          href={`#${tocId}`}
          onClick={event => scrollToElement(event, tocId)}
          className="text-gray-500 no-underline hover:text-indigo-700 dark:text-gray-400 dark:hover:text-indigo-300"
        >
          ↑ {t('admin.changelog.backToContents', 'Back to contents')}
        </a>
      </p>
    </section>
  );
}

/** Newer or older release at the bottom, drawn like the documentation's previous/next. */
function PagerLink({ release, direction, label, t }) {
  const older = direction === 'older';
  return (
    <Link
      to={releaseLink(release.version)}
      className={`group flex flex-1 flex-col rounded-lg border border-gray-200 px-4 py-3 transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-gray-800 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/30 ${
        older ? 'items-end text-right' : 'items-start'
      }`}
    >
      <span className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
        {!older && <ArrowLeftIcon className="h-3.5 w-3.5" aria-hidden="true" />}
        {older
          ? t('admin.changelog.olderRelease', 'Older release')
          : t('admin.changelog.newerRelease', 'Newer release')}
        {older && <ArrowRightIcon className="h-3.5 w-3.5" aria-hidden="true" />}
      </span>
      <span className="mt-0.5 text-sm font-medium text-gray-900 group-hover:text-indigo-700 dark:text-gray-100 dark:group-hover:text-indigo-300">
        {label}
      </span>
    </Link>
  );
}

function AdminChangelogPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const requestedVersion = searchParams.get('version');
  // Read by the one-time index load below, which must not re-run when the query changes.
  const requestedVersionRef = useRef(requestedVersion);
  requestedVersionRef.current = requestedVersion;
  useCodeBlockInteractions();

  const [index, setIndex] = useState(null);
  const [indexError, setIndexError] = useState('');
  const [selected, setSelected] = useState(null);
  const [releases, setReleases] = useState({});
  const [releaseErrors, setReleaseErrors] = useState({});
  const [retryToken, setRetryToken] = useState(0);
  const [expandedGroups, setExpandedGroups] = useState(null);

  // The list of releases, once.
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await makeAdminApiCall('/admin/changelog', { method: 'GET' });
        const data = response.data || {};
        const versions = Array.isArray(data.versions) ? data.versions : [];
        if (!active) return;
        setIndex({
          currentVersion: data.currentVersion || null,
          previousVersion: data.previousVersion || null,
          versions
        });
        // `?version=` comes from a link in another release's notes or in the documentation.
        const requested = requestedVersionRef.current;
        const initial = versions.find(item => item.version === requested) ?? versions[0];
        setSelected(initial?.version ?? null);
      } catch (err) {
        if (active) {
          setIndexError(err.message || t('admin.changelog.loadError', 'Failed to load changelog'));
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [t]);

  // A link to another release while this page is open changes only the query string.
  useEffect(() => {
    if (!requestedVersion || !index) return;
    if (index.versions.some(item => item.version === requestedVersion)) {
      setSelected(requestedVersion);
    }
    // location.key: following a link to the release already in the query string re-selects it.
  }, [requestedVersion, index, location.key]);

  // The selected release's entries, fetched on first selection and kept.
  useEffect(() => {
    if (!selected || releases[selected]) return undefined;
    let active = true;
    const load = async () => {
      try {
        const response = await makeAdminApiCall(
          `/admin/changelog/${encodeURIComponent(selected)}`,
          { method: 'GET' }
        );
        if (!active) return;
        setReleases(prev => ({ ...prev, [selected]: response.data }));
      } catch (err) {
        if (active) {
          setReleaseErrors(prev => ({
            ...prev,
            [selected]:
              err.message ||
              t(
                'admin.changelog.loadReleaseError',
                'Failed to load the release notes for this release'
              )
          }));
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [selected, releases, retryToken, t]);

  const selectedMeta = index?.versions.find(release => release.version === selected) ?? null;
  const release = selected ? releases[selected] : null;

  const tree = useMemo(() => buildReleaseTree(index?.versions ?? []), [index]);
  const newCount = (index?.versions ?? []).filter(item => item.isNew).length;

  // Which groups start open is derived, not stored — until the admin touches the tree, at which
  // point their set takes over for the rest of the visit. Recomputing it on every click would
  // keep re-opening what they closed.
  const defaultExpanded = useMemo(
    () => defaultExpandedGroups(tree, { selected: index?.versions?.[0]?.version ?? null }),
    [tree, index]
  );
  const expanded = expandedGroups ?? defaultExpanded;

  const toggleGroup = key =>
    setExpandedGroups(prev => {
      const next = new Set(prev ?? defaultExpanded);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // Render Markdown once per release, not on every state change.
  const prepared = useMemo(() => {
    if (!release) return null;
    const sections = {};
    for (const section of SECTIONS) {
      sections[section.key] = (release.sections?.[section.key] ?? []).map(entry => ({
        ...entry,
        domId: domId('release', release.version, section.key, entry.id),
        titleHtml: renderInlineMarkdown(entry.title, { t }),
        // Release notes are hard-wrapped by hand; a newline inside a paragraph is wrapping,
        // not a line break.
        bodyHtml: entry.body
          ? renderMarkdown(entry.body, {
              t,
              breaks: false,
              transformHtml: html =>
                rewriteDocsHtml(
                  demoteHeadings(html),
                  releaseSourcePath(release.version, section.file),
                  {
                    docsComponents: true,
                    tableLabel: t('admin.docs.tableLabel', 'Table')
                  }
                )
            })
          : ''
      }));
    }
    return { ...release, sections };
  }, [release, t]);

  // A link with a fragment (`?version=5.6.4#some-entry`) scrolls to that entry once it renders.
  useEffect(() => {
    if (!prepared || !location.hash) return;
    const entry = findEntryForFragment(prepared, location.hash.slice(1));
    const target = entry && document.getElementById(entry.domId);
    if (!target) return;
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start' });
    }
    if (typeof target.focus === 'function') target.focus({ preventScroll: true });
  }, [prepared, location.hash]);

  const shortLabel = item =>
    item.unreleased ? t('admin.changelog.unreleasedShort', 'Unreleased') : item.version;
  const fullLabel = item =>
    item.unreleased
      ? t('admin.changelog.unreleased', 'Unreleased changes')
      : t('admin.changelog.version', 'Version {{version}}', { version: item.version });
  const sectionLabel = section => t(section.i18nKey, section.label);

  const title = t('admin.changelog.title', "What's New");
  const articleRef = useRef(null);
  const titleRef = useRef(null);
  const firstSelectionRef = useRef(true);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Another release replaces the whole page, as another documentation page does: start at the
  // top, close the drawer and, after the first one, move focus to the release's title.
  useLayoutEffect(() => {
    if (!selected) return;
    setDrawerOpen(false);
    if (!location.hash) {
      const scroller = document.getElementById(SCROLLER_ID);
      if (scroller) scroller.scrollTop = 0;
    }
    if (firstSelectionRef.current) firstSelectionRef.current = false;
    else titleRef.current?.focus({ preventScroll: true });
    // location.hash is read, not watched: the fragment effect handles a jump within a release.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [selected]);

  useEffect(() => {
    if (prepared && articleRef.current) highlightDocsCode(articleRef.current).catch(() => {});
  }, [prepared]);

  const documentTitle = selectedMeta ? `${fullLabel(selectedMeta)} · ${title}` : title;
  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);

  const releaseError = selected ? releaseErrors[selected] : '';
  const tocId = selected ? domId('release', selected, 'contents') : 'release-contents';
  const position = index ? index.versions.findIndex(item => item.version === selected) : -1;
  const newer = position > 0 ? index.versions[position - 1] : null;
  const older = position >= 0 ? (index.versions[position + 1] ?? null) : null;
  const description = !selectedMeta
    ? ''
    : selectedMeta.unreleased
      ? t(
          'admin.changelog.unreleasedHint',
          'Changes in this build that are not part of a tagged release yet.'
        )
      : SECTIONS.filter(section => selectedMeta.counts?.[section.key] > 0)
          .map(section => `${selectedMeta.counts[section.key]} ${sectionLabel(section)}`)
          .join(' · ');

  let content;
  if (indexError) {
    content = <ErrorBox message={indexError} />;
  } else if (!index) {
    content = <LoadingSpinner message={t('admin.changelog.loading', 'Loading changelog...')} />;
  } else if (index.versions.length === 0) {
    content = (
      <>
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl dark:text-white">
          {title}
        </h1>
        <p className="mt-3 text-lg leading-relaxed text-gray-600 dark:text-gray-400">
          {t('admin.changelog.empty', 'No changelog entries yet.')}
        </p>
      </>
    );
  } else {
    content = (
      <>
        <header className="mb-8">
          <p className="mb-2 text-sm font-medium text-indigo-600 dark:text-indigo-400">{title}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1
              ref={titleRef}
              tabIndex={-1}
              className="text-3xl font-bold tracking-tight text-gray-900 focus:outline-hidden sm:text-4xl dark:text-white"
            >
              {selectedMeta ? fullLabel(selectedMeta) : title}
            </h1>
            {selectedMeta?.installed && (
              <Badge tone="green">{t('admin.changelog.installed', 'Installed')}</Badge>
            )}
            {selectedMeta?.isNew && <Badge tone="indigo">{t('admin.changelog.new', 'New')}</Badge>}
          </div>
          {description && (
            <p className="mt-3 text-lg leading-relaxed text-gray-600 dark:text-gray-400">
              {description}
            </p>
          )}
        </header>

        <UpgradeNotice
          previousVersion={index.previousVersion}
          currentVersion={index.currentVersion}
          newCount={newCount}
          t={t}
        />

        {releaseError ? (
          <ErrorBox
            message={releaseError}
            retryLabel={t('admin.changelog.retry', 'Try again')}
            onRetry={() => {
              setReleaseErrors(prev => ({ ...prev, [selected]: '' }));
              setRetryToken(token => token + 1);
            }}
          />
        ) : !prepared ? (
          <LoadingSpinner
            message={t('admin.changelog.loadingRelease', 'Loading release notes...')}
          />
        ) : (
          <>
            <TableOfContents id={tocId} release={prepared} sectionLabel={sectionLabel} t={t} />
            {/* Documentation links inside entry bodies navigate within the admin UI. */}
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
            <article
              ref={articleRef}
              className="docs-prose prose prose-gray max-w-none dark:prose-invert prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-gray-900 dark:prose-headings:text-white prose-h2:text-2xl prose-h3:text-lg prose-p:leading-7"
              onClick={event => handleDocsLinkClick(event, navigate)}
            >
              {SECTIONS.filter(section => prepared.sections[section.key].length > 0).map(
                (section, sectionIndex) => (
                  <ReleaseSection
                    key={section.key}
                    section={section}
                    entries={prepared.sections[section.key]}
                    release={prepared}
                    first={sectionIndex === 0}
                    tocId={tocId}
                    sectionLabel={sectionLabel}
                    t={t}
                  />
                )
              )}
            </article>
          </>
        )}

        {(newer || older) && (
          <nav
            aria-label={t('admin.changelog.pagination', 'Newer and older release')}
            className="mt-16 flex flex-col gap-3 border-t border-gray-200 pt-6 sm:flex-row dark:border-gray-800"
          >
            {newer ? (
              <PagerLink release={newer} direction="newer" label={fullLabel(newer)} t={t} />
            ) : (
              <span className="flex-1" />
            )}
            {older ? (
              <PagerLink release={older} direction="older" label={fullLabel(older)} t={t} />
            ) : (
              <span className="flex-1" />
            )}
          </nav>
        )}
      </>
    );
  }

  const switcher = (
    <ReleaseSwitcher
      tree={tree}
      selected={selected}
      expanded={expanded}
      onToggleGroup={toggleGroup}
      shortLabel={shortLabel}
      t={t}
    />
  );

  return (
    <div className="min-h-full bg-white dark:bg-gray-900">
      {/* Header: sticks to the top of the admin scroller, as on the documentation pages. */}
      <div className="sticky top-0 z-20 border-b border-gray-200 bg-white/90 backdrop-blur-sm dark:border-gray-800 dark:bg-gray-900/90">
        <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="-ml-1.5 inline-flex items-center gap-1.5 rounded-md p-1.5 text-sm text-gray-600 hover:bg-gray-100 lg:hidden dark:text-gray-300 dark:hover:bg-gray-800"
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
          >
            <Bars3BottomLeftIcon className="h-5 w-5" aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">
              {t('admin.changelog.versions', 'Releases')}
            </span>
          </button>
          <nav
            aria-label={t('admin.docs.breadcrumb', 'Breadcrumb')}
            className="hidden min-w-0 flex-1 sm:block"
          >
            <ol className="flex min-w-0 items-center gap-1 text-sm text-gray-500 dark:text-gray-400">
              <li className="shrink-0 font-medium text-gray-900 dark:text-gray-100">{title}</li>
              {selectedMeta && (
                <li className="flex min-w-0 items-center gap-1">
                  <ChevronRightIcon className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
                  <span className="truncate">{fullLabel(selectedMeta)}</span>
                </li>
              )}
            </ol>
          </nav>
          <div className="ml-auto w-full max-w-xs sm:w-72">
            <DocsSearch />
          </div>
        </div>
      </div>

      <div className="lg:grid lg:grid-cols-[17rem_minmax(0,1fr)] xl:grid-cols-[17rem_minmax(0,1fr)_14rem]">
        {/* Releases: full height of the scroller below the header, its own scroll. */}
        <aside className="hidden border-r border-gray-200 lg:block dark:border-gray-800">
          <div className="sticky top-14 h-[calc(100dvh-3.5rem)] overflow-y-auto overscroll-contain px-4 py-6">
            {index ? switcher : null}
          </div>
        </aside>

        <div className="min-w-0 px-4 py-8 sm:px-8 lg:px-12">
          <div className="mx-auto max-w-[46rem]">{content}</div>
        </div>

        <aside className="hidden xl:block">
          <div className="sticky top-14 max-h-[calc(100dvh-3.5rem)] overflow-y-auto px-4 py-8">
            {prepared && (
              <DocsOutline
                articleRef={articleRef}
                scrollerId={SCROLLER_ID}
                html={prepared}
                label={t('admin.changelog.contents', 'In this release')}
                onSelect={scrollToElement}
              />
            )}
          </div>
        </aside>
      </div>

      <DocsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        label={t('admin.changelog.versions', 'Releases')}
        title={t('admin.changelog.versions', 'Releases')}
      >
        {index ? switcher : null}
      </DocsDrawer>
    </div>
  );
}

export default AdminChangelogPage;
