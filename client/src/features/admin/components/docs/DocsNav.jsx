// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronRightIcon } from '@heroicons/react/20/solid';
import { docsNodesContain, docsRoute } from '../../utils/docsToc';

/**
 * The documentation contents: one collapsible group per SUMMARY part, pages as text links with
 * the current one marked on the guide line. It looks deliberately different from the admin
 * sidebar next to it, so it reads as the docs' own navigation rather than a second admin menu.
 */

function NavItems({ nodes, current, depth = 0 }) {
  return (
    <ul
      className={
        depth === 0 ? 'space-y-px' : 'mt-px ml-3 space-y-px border-l border-gray-200 dark:border-gray-800'
      }
    >
      {nodes.map((node, index) => {
        const key = `${node.path || node.title}-${index}`;
        const active = node.path === current;
        return (
          <li key={key}>
            {node.path ? (
              <Link
                to={docsRoute(node.path)}
                aria-current={active ? 'page' : undefined}
                data-docs-nav-active={active ? 'true' : undefined}
                className={`-ml-px block border-l-2 py-1 pl-3 pr-2 text-[13px] leading-5 transition-colors ${
                  active
                    ? 'border-indigo-600 font-medium text-indigo-700 dark:border-indigo-400 dark:text-indigo-300'
                    : 'border-transparent text-gray-600 hover:border-gray-300 hover:text-gray-900 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-100'
                }`}
              >
                {node.title}
              </Link>
            ) : (
              <span className="block py-1 pl-3 pr-2 text-[13px] font-medium leading-5 text-gray-900 dark:text-gray-100">
                {node.title}
              </span>
            )}
            {node.children?.length > 0 && (
              <NavItems nodes={node.children} current={current} depth={depth + 1} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function NavSection({ section, current, open, onToggle }) {
  const listId = `docs-nav-${section.id.replace(/[^a-z0-9-]/gi, '-')}`;
  if (!section.title) {
    return <NavItems nodes={section.items} current={current} />;
  }
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={listId}
        className="group flex w-full items-center justify-between rounded-sm py-1.5 pr-1 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
      >
        {section.title}
        <ChevronRightIcon
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      <div id={listId} hidden={!open} className="mt-1">
        <NavItems nodes={section.items} current={current} />
      </div>
    </div>
  );
}

/** The nearest scrolling ancestor of the contents (the sidebar column or the drawer). */
function navScroller(element) {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    if (node.id === 'admin-main-content') return null;
    const { overflowY } = window.getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

/**
 * @param {{ sections: Array, current: string, scrollActiveIntoView?: boolean }} props
 */
export default function DocsNav({ sections, current, scrollActiveIntoView = true }) {
  const { t } = useTranslation();
  const containerRef = useRef(null);
  const [openIds, setOpenIds] = useState(() => new Set());

  // The section of the current page is always open; the admin's own toggles stay as they are.
  const currentSectionId = sections.find(section =>
    docsNodesContain(section.items, current)
  )?.id;
  useEffect(() => {
    if (!currentSectionId) return;
    setOpenIds(previous =>
      previous.has(currentSectionId) ? previous : new Set(previous).add(currentSectionId)
    );
  }, [currentSectionId]);

  // Keep the current page visible in a long list: once per page, when its link is first shown (its
  // section may open a render later), and never again on the admin's own toggles. Only the
  // contents' own scroller moves; `scrollIntoView` would also move the article.
  const scrolledToRef = useRef(null);
  useEffect(() => {
    if (!scrollActiveIntoView || scrolledToRef.current === current) return;
    const active = containerRef.current?.querySelector('[data-docs-nav-active]');
    if (!active || active.getClientRects().length === 0) return;
    scrolledToRef.current = current;
    const scroller = navScroller(containerRef.current);
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    const link = active.getBoundingClientRect();
    if (link.top < box.top) scroller.scrollTop -= box.top - link.top;
    else if (link.bottom > box.bottom) scroller.scrollTop += link.bottom - box.bottom;
  }, [current, openIds, scrollActiveIntoView]);

  const toggle = id =>
    setOpenIds(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allOpen = sections.every(section => !section.title || openIds.has(section.id));

  return (
    <nav aria-label={t('admin.docs.contents', 'Documentation contents')} ref={containerRef}>
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          onClick={() =>
            setOpenIds(
              allOpen
                ? new Set(currentSectionId ? [currentSectionId] : [])
                : new Set(sections.map(section => section.id))
            )
          }
          className="text-xs text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
        >
          {allOpen
            ? t('admin.docs.collapseAll', 'Collapse all')
            : t('admin.docs.expandAll', 'Expand all')}
        </button>
      </div>
      <div className="space-y-4">
        {sections.map(section => (
          <NavSection
            key={section.id}
            section={section}
            current={current}
            open={openIds.has(section.id)}
            onToggle={() => toggle(section.id)}
          />
        ))}
      </div>
    </nav>
  );
}
