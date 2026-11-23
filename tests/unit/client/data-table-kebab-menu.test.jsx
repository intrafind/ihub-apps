// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The row menu of the admin tables (`DataTableKebabMenu`, opened from
 * `DataTableRowActions`): it opens below its button and, for a row at the
 * bottom of the window, above it, so every entry can be reached; and its
 * button carries its name in the language of the page.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
  };
});

const mockTexts = { 'common.moreActions': 'Weitere Aktionen' };
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => mockTexts[key] ?? fallback ?? key })
}));

import DataTableKebabMenu from '../../../client/src/features/admin/components/data-table/DataTableKebabMenu';
import DataTableRowActions from '../../../client/src/features/admin/components/data-table/DataTableRowActions';

const ITEMS = [
  { id: 'one', label: 'One', onClick: jest.fn() },
  { id: 'two', label: 'Two', onClick: jest.fn() }
];

const MENU_HEIGHT = 120;
const WINDOW_HEIGHT = 800;

/** jsdom lays nothing out: give the menu a height and the button a place. */
function place(triggerTop) {
  jest.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function height() {
    return this.getAttribute('role') === 'menu' ? MENU_HEIGHT : 0;
  });
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    top: triggerTop,
    bottom: triggerTop + 28,
    left: 900,
    right: 928,
    width: 28,
    height: 28
  }));
}

beforeEach(() => {
  Object.defineProperty(window, 'innerHeight', { value: WINDOW_HEIGHT, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
});
afterEach(() => jest.restoreAllMocks());

const open = () => fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
const menuTop = () => parseFloat(screen.getByRole('menu').style.top);

describe('where the row menu opens', () => {
  test('below its button when there is room', () => {
    place(100);
    render(<DataTableKebabMenu items={ITEMS} row={{}} />);
    open();
    expect(menuTop()).toBe(100 + 28 + 4);
  });

  test('above its button for a row at the bottom of the window', () => {
    place(760);
    render(<DataTableKebabMenu items={ITEMS} row={{}} />);
    open();
    // The whole menu is inside the window.
    expect(menuTop()).toBe(760 - 4 - MENU_HEIGHT);
    expect(menuTop() + MENU_HEIGHT).toBeLessThanOrEqual(WINDOW_HEIGHT);
  });
});

describe('the name of the menu button', () => {
  test('is a text of the page language', () => {
    const actions = ['a', 'b', 'c', 'd'].map(id => ({ id, label: id, onClick: jest.fn() }));
    render(
      <table>
        <tbody>
          <tr>
            <DataTableRowActions actions={actions} row={{}} />
          </tr>
        </tbody>
      </table>
    );
    expect(screen.getByRole('button', { name: 'Weitere Aktionen' })).toBeInTheDocument();
  });
});
