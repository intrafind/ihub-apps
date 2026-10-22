// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useLocation } from 'react-router-dom';

/**
 * "Skip to content" link, visible only while it has keyboard focus.
 *
 * A bare `href="#id"` is not enough: `index.html` injects a `<base>` element for
 * sub-path deployments, which makes the browser resolve the fragment against the
 * app root (`/#id`) and navigate away from the current page. The click handler
 * therefore moves focus to the target itself; the `href` is the current URL plus
 * the fragment, so it also stays correct where the handler does not run (e.g.
 * "open in new tab").
 *
 * The target must be focusable (`tabIndex={-1}`), otherwise focus stays on the link.
 */
function SkipLink({ targetId, className = '', children }) {
  // Subscribing re-renders the link on navigation so `href` tracks the current URL.
  useLocation();

  const handleClick = event => {
    const target = document.getElementById(targetId);
    if (!target) return;
    event.preventDefault();
    target.focus();
    target.scrollIntoView?.({ block: 'start' });
  };

  const href = `${window.location.pathname}${window.location.search}#${targetId}`;

  return (
    <a href={href} onClick={handleClick} className={className}>
      {children}
    </a>
  );
}

export default SkipLink;
