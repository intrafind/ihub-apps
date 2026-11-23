// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The sticky save bar must not cover the field that has the keyboard focus
 * (WCAG 2.2, 2.4.11). While it is shown, it reserves its measured height as
 * `scroll-padding-bottom` on everything that scrolls it; a browser then
 * scrolls a focused control to above the bar.
 */

import '@testing-library/jest-dom';
import { act, render } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}));

const AdminSaveBar = require('../../../client/src/features/admin/components/AdminSaveBar').default;

const padding = node => node.style.getPropertyValue('scroll-padding-bottom');
const bar = () => document.querySelector('[role="region"]');

let barHeight;
let observers;
let rectSpy;

beforeEach(() => {
  barHeight = 63;
  observers = [];
  rectSpy = jest
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function measure() {
      return { height: this.getAttribute('role') === 'region' ? barHeight : 0 };
    });
  global.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.disconnect = jest.fn();
      observers.push(this);
    }
    observe() {}
  };
});

afterEach(() => {
  rectSpy.mockRestore();
  delete global.ResizeObserver;
  document.documentElement.style.removeProperty('scroll-padding-bottom');
});

function Page({ dirty, saving = false }) {
  return (
    <div data-testid="outer" style={{ overflowY: 'hidden' }}>
      <div data-testid="column" style={{ overflowY: 'auto' }}>
        <div data-testid="plain">
          <input aria-label="A field" />
          <AdminSaveBar dirty={dirty} saving={saving} onSave={() => {}} onDiscard={() => {}} />
        </div>
      </div>
    </div>
  );
}

describe('AdminSaveBar reserves its height where the page scrolls', () => {
  it('on the scroll column and on the document, and nowhere else', () => {
    const { getByTestId } = render(<Page dirty />);
    expect(padding(getByTestId('column'))).toBe('71px');
    expect(padding(document.documentElement)).toBe('71px');
    expect(padding(getByTestId('plain'))).toBe('');
    expect(padding(getByTestId('outer'))).toBe('');
  });

  it('reserves nothing while there is no bar, and gives the space back when it goes', () => {
    document.documentElement.style.setProperty('scroll-padding-bottom', '4px');
    const { getByTestId, rerender } = render(<Page dirty={false} />);
    expect(bar()).toBeNull();
    expect(padding(getByTestId('column'))).toBe('');
    expect(padding(document.documentElement)).toBe('4px');

    rerender(<Page dirty />);
    expect(padding(getByTestId('column'))).toBe('71px');
    expect(padding(document.documentElement)).toBe('71px');

    // A running save keeps the bar, and the space.
    rerender(<Page dirty={false} saving />);
    expect(padding(getByTestId('column'))).toBe('71px');

    rerender(<Page dirty={false} />);
    expect(padding(getByTestId('column'))).toBe('');
    // What the page had before is back.
    expect(padding(document.documentElement)).toBe('4px');
    expect(observers.at(-1).disconnect).toHaveBeenCalled();
  });

  it('follows the bar when it wraps to more rows on a narrow window', () => {
    const { getByTestId, unmount } = render(<Page dirty />);
    barHeight = 119;
    act(() => observers.at(-1).callback());
    expect(padding(getByTestId('column'))).toBe('127px');
    expect(padding(document.documentElement)).toBe('127px');

    barHeight = 63;
    act(() => window.dispatchEvent(new Event('resize')));
    expect(padding(getByTestId('column'))).toBe('71px');

    unmount();
    expect(padding(document.documentElement)).toBe('');
  });
});
