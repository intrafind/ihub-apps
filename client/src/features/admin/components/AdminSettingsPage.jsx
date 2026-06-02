import { useEffect, useRef, useState } from 'react';
import AdminBreadcrumb from './AdminBreadcrumb';

/**
 * Two-pane layout for admin settings pages with a sticky save bar.
 *
 * Left pane: vertical section nav (anchored scroll). Right pane: section
 * content. A sticky save bar pinned to the bottom of the viewport surfaces a
 * dirty indicator and primary Save / Discard actions.
 *
 * @param {Object} props
 * @param {Array<{ label: string, href?: string }>} [props.crumbs]
 * @param {string} props.title
 * @param {string} [props.description]
 * @param {Array<{ id: string, label: string, icon?: string, children: React.ReactNode }>} props.sections
 * @param {boolean} [props.dirty=false] Whether form has unsaved changes
 * @param {boolean} [props.saving=false] Whether save is in-flight
 * @param {() => void} [props.onSave]
 * @param {() => void} [props.onDiscard]
 * @param {string} [props.saveLabel='Save changes']
 * @param {string} [props.discardLabel='Discard']
 * @param {string} [props.dirtyLabel='You have unsaved changes']
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
  saveLabel = 'Save changes',
  discardLabel = 'Discard',
  dirtyLabel = 'You have unsaved changes',
  banner
}) {
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
          <aside className="hidden lg:block w-56 shrink-0">
            <nav className="sticky top-4 space-y-1" aria-label="Settings sections">
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
                    {s.label}
                  </button>
                );
              })}
            </nav>
          </aside>

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

      {(dirty || saving) && onSave && (
        <div
          className="sticky bottom-0 left-0 right-0 z-30 bg-white/95 dark:bg-gray-900/95 backdrop-blur border-t border-gray-200 dark:border-gray-700 shadow-lg"
          role="region"
          aria-label="Save bar"
        >
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between gap-4">
            <p className="text-sm text-gray-700 dark:text-gray-300 flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              {dirtyLabel}
            </p>
            <div className="flex items-center gap-2">
              {onDiscard && (
                <button
                  type="button"
                  onClick={onDiscard}
                  disabled={saving}
                  className="px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors disabled:opacity-50"
                >
                  {discardLabel}
                </button>
              )}
              <button
                type="button"
                onClick={onSave}
                disabled={saving}
                className="px-4 py-1.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-md shadow-sm transition-colors active:scale-95"
              >
                {saving ? 'Saving…' : saveLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdminSettingsPage;
