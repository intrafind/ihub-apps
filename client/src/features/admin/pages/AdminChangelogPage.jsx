import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRightIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { makeAdminApiCall } from '../../../api/adminApi';
import { renderInlineMarkdown, renderMarkdown } from '../../../config/marked.config';
import { useCodeBlockInteractions } from '../../../hooks/useCodeBlockInteractions';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import {
  buildReleaseTree,
  defaultExpandedGroups,
  visibleReleases
} from '../utils/changelogReleaseTree';

/**
 * Admin → What's New.
 *
 * `GET /admin/changelog` lists every release that has release notes (newest first, unreleased
 * changes ahead of them, with entry counts, and the `installed` / `isNew` flags the server
 * derives from the version this installation was upgraded from); `GET /admin/changelog/:version`
 * returns one release's entries per section, bodies as Markdown. One release is shown at a time:
 * a switcher on the left, and on the right the release with a table of contents followed by its
 * breaking changes, new & improved entries and fixes — in that order, because breaking changes
 * are what an admin has to act on.
 *
 * The switcher is a tree — `5.x` → `5.5.x` → the releases — because an installation that has been
 * running for a while has more releases than a flat list can show. Only the groups that hold the
 * selected release, the installed one or something the last upgrade brought in start open, and a
 * group longer than ten releases shows the newest ten until asked for the rest.
 */

/** Reading order. The keys match the sections the server returns. */
const SECTIONS = [
  { key: 'breakingChanges', i18nKey: 'admin.changelog.breakingChanges', label: 'Breaking changes' },
  { key: 'features', i18nKey: 'admin.changelog.features', label: 'New & improved' },
  { key: 'fixes', i18nKey: 'admin.changelog.fixes', label: 'Fixes' }
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

/** Headings inside an entry body sit one level below the entry's own `<h3>`. */
const demoteHeadings = html =>
  html.replace(
    /<(\/?)h([1-5])(?=[\s>])/g,
    (match, slash, level) => `<${slash}h${Number(level) + 1}`
  );

const BADGE_TONES = {
  indigo: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200',
  green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
};

function Badge({ tone, children }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center px-2 py-0.5 rounded-full text-xs font-medium ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

function PageFrame({ title, subtitle, children }) {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>}
      </header>
      {children}
    </div>
  );
}

function ErrorBox({ message, onRetry, retryLabel }) {
  return (
    <div
      role="alert"
      className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-700 dark:text-red-400 flex flex-wrap items-center justify-between gap-3"
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

function ReleaseButton({ release, selected, onSelect, shortLabel, t }) {
  const active = release.version === selected;
  return (
    <button
      type="button"
      onClick={() => onSelect(release.version)}
      aria-current={active ? 'page' : undefined}
      className={`w-full flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-3 py-1.5 text-sm text-left transition-colors ${
        active
          ? 'bg-indigo-50 text-indigo-700 font-semibold dark:bg-indigo-900/40 dark:text-indigo-200'
          : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
      }`}
    >
      <span className="shrink-0">{shortLabel(release)}</span>
      {release.installed && (
        <Badge tone="green">{t('admin.changelog.installed', 'Installed')}</Badge>
      )}
      {release.isNew && <Badge tone="indigo">{t('admin.changelog.new', 'New')}</Badge>}
    </button>
  );
}

/**
 * One level of the switcher tree. The chevron rotates instead of swapping icons so the control
 * keeps its place while a group opens.
 */
function GroupToggle({ open, label, count, newCount, controls, onToggle, className = '', t }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      className={`w-full flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md px-2 py-1.5 text-sm text-left text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800 ${className}`}
    >
      <ChevronRightIcon
        className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}
        aria-hidden="true"
      />
      <span className="truncate">{label}</span>
      <span className="text-xs text-gray-400 dark:text-gray-500">{count}</span>
      {newCount > 0 && (
        <Badge tone="indigo">
          {t('admin.changelog.newCount', '{{count}} new', { count: newCount })}
        </Badge>
      )}
    </button>
  );
}

function MinorGroup({ minor, selected, onSelect, expanded, onToggleGroup, shortLabel, t }) {
  const [showAll, setShowAll] = useState(false);
  const open = expanded.has(minor.key);
  const listId = domId('release-group', minor.key);
  const { releases, hidden } = visibleReleases(minor, { showAll, selected });

  return (
    <li>
      <GroupToggle
        open={open}
        label={t('admin.changelog.series', '{{series}}.x', { series: minor.key })}
        count={minor.count}
        newCount={minor.newCount}
        controls={listId}
        onToggle={() => onToggleGroup(minor.key)}
        t={t}
      />
      {open && (
        <ul id={listId} className="mt-0.5 space-y-0.5 pl-3">
          {releases.map(release => (
            <li key={release.version}>
              <ReleaseButton
                release={release}
                selected={selected}
                onSelect={onSelect}
                shortLabel={shortLabel}
                t={t}
              />
            </li>
          ))}
          {hidden > 0 && (
            <li>
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="w-full rounded-md px-3 py-1.5 text-left text-xs font-medium text-indigo-600 hover:bg-gray-100 hover:underline dark:text-indigo-400 dark:hover:bg-gray-800"
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

function ReleaseSwitcher({ tree, selected, onSelect, expanded, onToggleGroup, shortLabel, t }) {
  return (
    <nav
      aria-label={t('admin.changelog.versions', 'Releases')}
      className="lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto"
    >
      <ul className="space-y-0.5">
        {tree.unreleased.map(release => (
          <li key={release.version}>
            <ReleaseButton
              release={release}
              selected={selected}
              onSelect={onSelect}
              shortLabel={shortLabel}
              t={t}
            />
          </li>
        ))}
        {tree.majors.map(major => {
          const open = expanded.has(major.key);
          const listId = domId('release-group', major.key);
          return (
            <li key={major.key}>
              <GroupToggle
                open={open}
                label={t('admin.changelog.series', '{{series}}.x', { series: major.major })}
                count={major.count}
                newCount={major.newCount}
                controls={listId}
                onToggle={() => onToggleGroup(major.key)}
                className="font-medium"
                t={t}
              />
              {open && (
                <ul
                  id={listId}
                  className="mt-0.5 space-y-0.5 pl-2 ml-3 border-l border-gray-200 dark:border-gray-700"
                >
                  {major.minors.map(minor => (
                    <MinorGroup
                      key={minor.key}
                      minor={minor}
                      selected={selected}
                      onSelect={onSelect}
                      expanded={expanded}
                      onToggleGroup={onToggleGroup}
                      shortLabel={shortLabel}
                      t={t}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * What the last upgrade brought in. Only shown when this installation remembers a previous
 * version and at least one release since then has notes — on a fresh installation, or when the
 * jump crossed no documented release, there is nothing to point at.
 */
function UpgradeNotice({ previousVersion, currentVersion, newCount, t }) {
  if (!previousVersion || !currentVersion || newCount === 0) return null;
  return (
    <section
      aria-labelledby="changelog-upgrade-notice"
      className="mb-6 rounded-lg border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-900/20"
    >
      <p
        id="changelog-upgrade-notice"
        className="text-sm font-semibold text-indigo-900 dark:text-indigo-200"
      >
        {t('admin.changelog.upgradedFrom', 'Upgraded from {{previousVersion}} to {{version}}', {
          previousVersion,
          version: currentVersion
        })}
      </p>
      <p className="mt-1 text-sm text-indigo-800 dark:text-indigo-300">
        {t(
          'admin.changelog.upgradedReleases',
          '{{count}} releases are new to this installation — every one of them is marked New.',
          { count: newCount }
        )}
      </p>
    </section>
  );
}

function TableOfContents({ id, release, sectionLabel, t }) {
  const groups = SECTIONS.filter(section => release.sections[section.key].length > 0);
  return (
    <nav
      id={id}
      tabIndex={-1}
      aria-label={t('admin.changelog.contents', 'In this release')}
      className="scroll-mt-6 rounded-lg border border-gray-200 bg-gray-50 p-5 dark:border-gray-700 dark:bg-gray-800/60 focus:outline-hidden"
    >
      <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-3">
        {t('admin.changelog.contents', 'In this release')}
      </h3>
      <div className="space-y-4">
        {groups.map(section => {
          const entries = release.sections[section.key];
          const sectionDomId = domId('release', release.version, section.key);
          return (
            <div key={section.key}>
              <a
                href={`#${sectionDomId}`}
                onClick={event => scrollToElement(event, sectionDomId)}
                className="text-sm font-semibold text-gray-900 hover:underline dark:text-gray-100"
              >
                {sectionLabel(section)}{' '}
                <span className="font-normal text-gray-500 dark:text-gray-400">
                  ({entries.length})
                </span>
              </a>
              <ol
                className={`mt-1 space-y-1 text-sm ${entries.length > 6 ? 'sm:columns-2 sm:gap-x-8' : ''}`}
              >
                {entries.map(entry => (
                  <li key={entry.id} className="break-inside-avoid">
                    <a
                      href={`#${entry.domId}`}
                      onClick={event => scrollToElement(event, entry.domId)}
                      className="text-indigo-600 hover:underline dark:text-indigo-400"
                      // Titles are Markdown (inline code is common); rendered and sanitized
                      // with the shared marked config.
                      dangerouslySetInnerHTML={{ __html: entry.titleHtml }}
                    />
                  </li>
                ))}
              </ol>
            </div>
          );
        })}
      </div>
    </nav>
  );
}

function ReleaseEntry({ entry }) {
  return (
    <article id={entry.domId} tabIndex={-1} className="scroll-mt-6 py-5 focus:outline-hidden">
      <h3
        className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2"
        dangerouslySetInnerHTML={{ __html: entry.titleHtml }}
      />
      {entry.bodyHtml && (
        <div
          className="prose prose-sm sm:prose-base dark:prose-invert max-w-none prose-headings:text-gray-900 dark:prose-headings:text-white prose-a:text-indigo-600 dark:prose-a:text-indigo-400"
          // Sanitized by renderMarkdown (DOMPurify) before it gets here.
          dangerouslySetInnerHTML={{ __html: entry.bodyHtml }}
        />
      )}
    </article>
  );
}

function ReleaseSection({ section, entries, release, tocId, sectionLabel, t }) {
  const breaking = section.key === 'breakingChanges';
  const sectionDomId = domId('release', release.version, section.key);
  const headingId = `${sectionDomId}-heading`;

  return (
    <section
      id={sectionDomId}
      aria-labelledby={headingId}
      className={`scroll-mt-6 ${
        breaking
          ? 'rounded-lg border border-amber-300 bg-amber-50/70 p-5 dark:border-amber-700 dark:bg-amber-900/10'
          : ''
      }`}
    >
      <div className="flex items-start gap-2">
        {breaking && (
          <ExclamationTriangleIcon
            className="h-5 w-5 text-amber-500 dark:text-amber-400 shrink-0 mt-0.5"
            aria-hidden="true"
          />
        )}
        <div>
          <h2
            id={headingId}
            className={`text-sm font-semibold uppercase tracking-wide ${
              breaking ? 'text-amber-800 dark:text-amber-300' : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            {sectionLabel(section)} <span className="font-normal">({entries.length})</span>
          </h2>
          {breaking && (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {t(
                'admin.changelog.breakingChangesHint',
                'Action is needed before or after upgrading.'
              )}
            </p>
          )}
        </div>
      </div>

      <div className="divide-y divide-gray-100 dark:divide-gray-800">
        {entries.map(entry => (
          <ReleaseEntry key={entry.id} entry={entry} />
        ))}
      </div>

      <div className="mt-2 text-right">
        <a
          href={`#${tocId}`}
          onClick={event => scrollToElement(event, tocId)}
          className="text-xs text-gray-500 hover:text-indigo-600 hover:underline dark:text-gray-400 dark:hover:text-indigo-400"
        >
          ↑ {t('admin.changelog.backToContents', 'Back to contents')}
        </a>
      </div>
    </section>
  );
}

function AdminChangelogPage() {
  const { t } = useTranslation();
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
        setSelected(versions[0]?.version ?? null);
      } catch (err) {
        if (active) {
          setIndexError(err.message || t('admin.changelog.loadError', 'Failed to load changelog'));
        }
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [t]);

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
    load();
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
          ? renderMarkdown(entry.body, { t, breaks: false, transformHtml: demoteHeadings })
          : ''
      }));
    }
    return { ...release, sections };
  }, [release, t]);

  const shortLabel = item =>
    item.unreleased ? t('admin.changelog.unreleasedShort', 'Unreleased') : item.version;
  const fullLabel = item =>
    item.unreleased
      ? t('admin.changelog.unreleased', 'Unreleased changes')
      : t('admin.changelog.version', 'Version {{version}}', { version: item.version });
  const sectionLabel = section => t(section.i18nKey, section.label);

  const title = t('admin.changelog.title', "What's New");
  const subtitle = t(
    'admin.changelog.subtitle',
    'Release notes for every iHub Apps release, newest first.'
  );

  if (indexError) {
    return (
      <PageFrame title={title}>
        <ErrorBox message={indexError} />
      </PageFrame>
    );
  }

  if (!index) {
    return (
      <PageFrame title={title}>
        <LoadingSpinner message={t('admin.changelog.loading', 'Loading changelog...')} />
      </PageFrame>
    );
  }

  if (index.versions.length === 0) {
    return (
      <PageFrame title={title} subtitle={subtitle}>
        <p className="text-gray-500 dark:text-gray-400">
          {t('admin.changelog.empty', 'No changelog entries yet.')}
        </p>
      </PageFrame>
    );
  }

  const tocId = selected ? domId('release', selected, 'contents') : 'release-contents';
  const releaseError = selected ? releaseErrors[selected] : '';
  // Loading is the absence of both a result and an error for the selected release.
  const loadingRelease = !!selected && !prepared && !releaseError;

  return (
    <PageFrame title={title} subtitle={subtitle}>
      <UpgradeNotice
        previousVersion={index.previousVersion}
        currentVersion={index.currentVersion}
        newCount={newCount}
        t={t}
      />
      <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
        <ReleaseSwitcher
          tree={tree}
          selected={selected}
          onSelect={setSelected}
          expanded={expanded}
          onToggleGroup={toggleGroup}
          shortLabel={shortLabel}
          t={t}
        />

        <div className="mt-4 min-w-0 lg:mt-0">
          {selectedMeta && (
            <div className="mb-5">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                  {fullLabel(selectedMeta)}
                </h2>
                {selectedMeta.installed && (
                  <Badge tone="green">{t('admin.changelog.installed', 'Installed')}</Badge>
                )}
                {selectedMeta.isNew && (
                  <Badge tone="indigo">{t('admin.changelog.new', 'New')}</Badge>
                )}
              </div>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {selectedMeta.unreleased
                  ? t(
                      'admin.changelog.unreleasedHint',
                      'Changes in this build that are not part of a tagged release yet.'
                    )
                  : SECTIONS.filter(section => selectedMeta.counts?.[section.key] > 0)
                      .map(
                        section => `${selectedMeta.counts[section.key]} ${sectionLabel(section)}`
                      )
                      .join(' · ')}
              </p>
            </div>
          )}

          {releaseError ? (
            <ErrorBox
              message={releaseError}
              retryLabel={t('admin.changelog.retry', 'Try again')}
              onRetry={() => {
                setReleaseErrors(prev => ({ ...prev, [selected]: '' }));
                setRetryToken(token => token + 1);
              }}
            />
          ) : loadingRelease || !prepared ? (
            <LoadingSpinner
              message={t('admin.changelog.loadingRelease', 'Loading release notes...')}
            />
          ) : (
            <div className="space-y-8">
              <TableOfContents id={tocId} release={prepared} sectionLabel={sectionLabel} t={t} />
              {SECTIONS.filter(section => prepared.sections[section.key].length > 0).map(
                section => (
                  <ReleaseSection
                    key={section.key}
                    section={section}
                    entries={prepared.sections[section.key]}
                    release={prepared}
                    tocId={tocId}
                    sectionLabel={sectionLabel}
                    t={t}
                  />
                )
              )}
            </div>
          )}
        </div>
      </div>
    </PageFrame>
  );
}

export default AdminChangelogPage;
