// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AdminBreadcrumb from './AdminBreadcrumb';
import AdminSaveBar from './AdminSaveBar';
import UnsavedChangesDialog from './UnsavedChangesDialog';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';

/**
 * Two-pane layout for admin settings pages with a sticky save bar.
 *
 * Left pane: vertical section nav (anchored scroll). Right pane: section
 * content. While the page is dirty the shared `AdminSaveBar` is pinned to the
 * bottom of the viewport (when `onSave` is given), and the page guards against
 * leaving with unsaved changes: it calls `useUnsavedChanges` itself and renders
 * the "Leave without saving?" dialog, so a page built on this frame only has to
 * say whether it is dirty.
 *
 * Sections that save on their own can pass `dirty` per section: the section nav
 * then marks them with a dot (and a visually hidden "unsaved" label), and the
 * leave guard covers them too. A section component may also guard itself; the
 * guards share one prompt.
 *
 * @param {Object} props
 * @param {Array<{ label: string, href?: string }>} [props.crumbs]
 * @param {string} props.title
 * @param {string} [props.description]
 * @param {Array<{ id: string, label: string, icon?: string, dirty?: boolean, children: React.ReactNode }>} props.sections
 * @param {boolean} [props.dirty=false] Whether the page-level form has unsaved changes.
 *   Pass false while the page is loading or after its load failed.
 * @param {boolean} [props.saving=false] Whether save is in-flight
 * @param {() => void} [props.onSave] Page-level save; without it no save bar is shown.
 * @param {() => void} [props.onDiscard]
 * @param {React.ReactNode} [props.banner] Optional banner (e.g. validation error summary) above content
 */
function AdminSettingsPage({
  crumbs,
  title,
  description,
  sections = [],
  dirty = false,
  saving = false,
  onSave,
  onDiscard,
  banner
}) {
  const { t } = useTranslation();
  const anyDirty = Boolean(dirty) || sections.some(s => s.dirty);
  // The frame only knows "dirty or not", so compare a fixed baseline with it.
  const { blocker } = useUnsavedChanges(false, anyDirty);
  const [activeId, setActiveId] = useState(sections[0]?.id ?? null);
  const sectionRefs = useRef({});

  // Highlight the section currently in view as the user scrolls.
  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) {
          setActiveId(visible[0].target.id.replace(/^settings-section-/, ''));
        }
      },
      { rootMargin: '-25% 0px -55% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    Object.values(sectionRefs.current).forEach(el => {
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [sections]);

  const scrollTo = id => {
    const el = sectionRefs.current[id];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveId(id);
    }
  };

  return (
    <div className="relative">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-28">
        {crumbs && crumbs.length > 0 && <AdminBreadcrumb crumbs={crumbs} />}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{title}</h1>
          {description && (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{description}</p>
          )}
        </div>

        {banner && <div className="mb-6">{banner}</div>}

        <div className="flex gap-8">
          <div className="hidden lg:block w-56 shrink-0">
            <nav
              className="sticky top-4 space-y-1"
              aria-label={t('admin.settingsPage.sectionsNav', 'Settings sections')}
            >
              {sections.map(s => {
                const isActive = activeId === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => scrollTo(s.id)}
                    className={[
                      'block w-full text-left px-3 py-2 rounded-md text-sm transition-colors',
                      isActive
                        ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-medium'
                        : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
                    ].join(' ')}
                    aria-current={isActive ? 'true' : undefined}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span>{s.label}</span>
                      {s.dirty && (
                        <>
                          <span
                            className="inline-block h-2 w-2 rounded-full bg-amber-500"
                            aria-hidden="true"
                          />
                          <span className="sr-only">
                            {t('admin.settingsPage.sectionUnsaved', '(unsaved changes)')}
                          </span>
                        </>
                      )}
                    </span>
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="flex-1 min-w-0 space-y-8">
            {sections.map(s => (
              <section
                key={s.id}
                id={`settings-section-${s.id}`}
                ref={el => {
                  sectionRefs.current[s.id] = el;
                }}
                aria-labelledby={`settings-heading-${s.id}`}
                className="scroll-mt-4"
              >
                <h2
                  id={`settings-heading-${s.id}`}
                  className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3"
                >
                  {s.label}
                </h2>
                {s.children}
              </section>
            ))}
          </div>
        </div>
      </div>

      {onSave && (
        <AdminSaveBar dirty={dirty} saving={saving} onSave={onSave} onDiscard={onDiscard} />
      )}
      <UnsavedChangesDialog blocker={blocker} />
    </div>
  );
}

export default AdminSettingsPage;
