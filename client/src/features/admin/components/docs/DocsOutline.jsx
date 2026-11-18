// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { docsRoute } from '../../utils/docsToc';

/** How far below the top of the scroller a heading counts as the one being read. */
const READING_LINE_PX = 96;

/**
 * "On this page": the h2/h3 headings of the article, with the one being read marked. Headings are
 * read from the rendered article, so the outline always matches what is on screen.
 *
 * Without `path` the links stay on the current route and `onSelect(event, id)` scrolls to the
 * heading (What's New, whose headings are not documentation routes).
 *
 * @param {{ articleRef: { current: HTMLElement|null }, scrollerId: string, path?: string,
 *   html: string, label?: string, onSelect?: (event: Event, id: string) => void }} props
 */
export default function DocsOutline({ articleRef, scrollerId, path, html, label, onSelect }) {
  const { t } = useTranslation();
  const [headings, setHeadings] = useState([]);
  const [activeId, setActiveId] = useState('');

  useEffect(() => {
    const article = articleRef.current;
    if (!article) {
      setHeadings([]);
      return;
    }
    setHeadings(
      [...article.querySelectorAll('h2[id], h3[id]')].map(heading => {
        const clone = heading.cloneNode(true);
        clone.querySelectorAll('.docs-heading-anchor').forEach(anchor => anchor.remove());
        return { id: heading.id, level: heading.tagName === 'H2' ? 2 : 3, text: clone.textContent };
      })
    );
  }, [articleRef, html]);

  useEffect(() => {
    const scroller = document.getElementById(scrollerId);
    if (!scroller || headings.length === 0) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = scroller.getBoundingClientRect().top + READING_LINE_PX;
      let current = headings[0].id;
      for (const { id } of headings) {
        const element = document.getElementById(id);
        if (element && element.getBoundingClientRect().top <= top) current = id;
        else if (element) break;
      }
      setActiveId(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [headings, scrollerId]);

  if (headings.length < 2) return null;

  const title = label || t('admin.docs.onThisPage', 'On this page');
  return (
    <nav aria-label={title}>
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {title}
      </p>
      <ul className="space-y-px border-l border-gray-200 text-[13px] leading-5 dark:border-gray-800">
        {headings.map(heading => {
          const active = heading.id === activeId;
          const className = `-ml-px block border-l-2 py-1 pr-2 ${heading.level === 3 ? 'pl-6' : 'pl-3'} ${
            active
              ? 'border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300'
              : 'border-transparent text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
          }`;
          return (
            <li key={heading.id}>
              {path ? (
                <Link
                  to={docsRoute(path, encodeURIComponent(heading.id))}
                  aria-current={active ? 'location' : undefined}
                  className={className}
                >
                  {heading.text}
                </Link>
              ) : (
                <a
                  href={`#${encodeURIComponent(heading.id)}`}
                  onClick={event => onSelect?.(event, heading.id)}
                  aria-current={active ? 'location' : undefined}
                  className={className}
                >
                  {heading.text}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
