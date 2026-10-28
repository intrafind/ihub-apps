// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * AdminTabs keyboard support: arrow keys move to the next tab and focus it
 * once a tab bar shows it as active — also when that tab bar is a new
 * instance, as with tabs that are separate (lazy) routes — and keys with a
 * modifier are left to the browser.
 */
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import AdminTabs from '../../../client/src/features/admin/components/AdminTabs';

const TABS = [
  { id: 'one', label: 'One' },
  { id: 'two', label: 'Two' },
  { id: 'three', label: 'Three' }
];

/** Each tab change mounts a new tab bar, like a page per tab. */
function RoutedTabs() {
  const [active, setActive] = useState('one');
  return <AdminTabs key={active} tabs={TABS} activeId={active} onChange={setActive} />;
}

describe('AdminTabs keyboard', () => {
  test('ArrowRight activates and focuses the next tab, even in a new tab bar', () => {
    render(<RoutedTabs />);
    const one = screen.getByRole('tab', { name: 'One' });
    one.focus();
    act(() => {
      fireEvent.keyDown(one, { key: 'ArrowRight' });
    });
    const two = screen.getByRole('tab', { name: 'Two' });
    expect(two).toHaveAttribute('aria-selected', 'true');
    expect(two).toHaveFocus();
  });

  test('keys with a modifier are left to the browser', () => {
    render(<RoutedTabs />);
    const one = screen.getByRole('tab', { name: 'One' });
    one.focus();
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
      const notPrevented = fireEvent.keyDown(one, { key: 'ArrowRight', [modifier]: true });
      expect(notPrevented).toBe(true);
    }
    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');
  });
});
