// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useLayoutEffect, useRef } from 'react';

/**
 * The chat's composer, floating over the bottom of the transcript.
 *
 * The container has no background: the messages scroll visibly behind it, like
 * the document behind the workspace's composer dock. Only the composer box
 * itself is opaque. The container's height is published as
 * `--chat-composer-clearance` on the parent element (which must be `relative`
 * and as tall as the transcript), so the message list can pad its end and the
 * last message can still be scrolled clear of the composer.
 *
 * Clicks pass through the empty space around the composer to the transcript.
 *
 * @param {Object} props
 * @param {import('react').ReactNode} props.children - The composer.
 */
export default function FloatingComposer({ children }) {
  const ref = useRef(null);

  useLayoutEffect(() => {
    const element = ref.current;
    const parent = element?.parentElement;
    if (!element || !parent) return undefined;
    const report = () => {
      // A layout hidden by a breakpoint measures 0, which is right for it too.
      const height = Math.ceil(element.getBoundingClientRect().height);
      parent.style.setProperty('--chat-composer-clearance', `${height}px`);
    };
    report();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => {
      observer.disconnect();
      parent.style.removeProperty('--chat-composer-clearance');
    };
  }, []);

  return (
    <div ref={ref} className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pt-2">
      <div className="pointer-events-auto mx-auto w-full max-w-3xl">{children}</div>
    </div>
  );
}
