// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId } from 'react';
import Icon from '../../../../shared/components/Icon';

/**
 * One group of the editor of a personal app ("Basics", "Instructions and
 * inputs", "What the app may use"): a header that is a button with
 * `aria-expanded`, and the group's fields under it.
 *
 * The fields stay in the page while the group is closed (hidden), so what
 * the author typed in them is kept.
 *
 * @param {object} props
 * @param {string} props.title
 * @param {boolean} props.open
 * @param {() => void} props.onToggle
 * @param {{ current: HTMLElement|null }} [props.buttonRef] - The header, for a link that
 *   leads to this group.
 * @param {boolean} [props.disabled=false] - The fields cannot be changed (a read-only app).
 *   The header stays a working button.
 * @param {React.ReactNode} props.children
 * @returns {JSX.Element}
 */
function UserAppEditorGroup({ title, open, onToggle, buttonRef, disabled = false, children }) {
  const panelId = useId();
  return (
    <section className="mt-6">
      <h2>
        <button
          ref={buttonRef}
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex w-full items-center gap-2 rounded-sm py-1 text-left text-lg font-semibold text-gray-900 dark:text-gray-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent"
        >
          <Icon
            name={open ? 'chevron-down' : 'chevron-right'}
            className="h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          {title}
        </button>
      </h2>
      <fieldset id={panelId} hidden={!open} disabled={disabled} className="mt-3 min-w-0 space-y-4">
        {children}
      </fieldset>
    </section>
  );
}

export default UserAppEditorGroup;
