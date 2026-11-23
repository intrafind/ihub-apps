// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The icon list is 24rem wide only where that fits into what clips its
 * button. In a narrow column at the right edge of a dialog it used to stick
 * out, gave the dialog a sideways scroll range, and the focus on its search
 * field scrolled the dialog.
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}));
// Icon uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const IconPicker = require('../../../client/src/shared/components/IconPicker').default;
const { placeIconList } = require('../../../client/src/shared/utils/iconListPlacement');

const box = (left, right) => ({ left, right, width: right - left, top: 0, bottom: 40, height: 40 });

/** A scroll container from `container` px, with the picker's button at `button` px. */
function renderIn(container, button) {
  const view = render(
    <div data-testid="scroller" style={{ overflowX: 'auto' }}>
      <IconPicker id="icon" value="star" onChange={() => {}} />
    </div>
  );
  const scroller = view.getByTestId('scroller');
  scroller.getBoundingClientRect = () => box(...container);
  const trigger = document.getElementById('icon');
  trigger.getBoundingClientRect = () => box(...button);
  return { trigger, scroller };
}

describe('placeIconList', () => {
  beforeEach(() => {
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 1280
    });
  });

  it('opens wide to the right where 24rem fit', () => {
    const { trigger } = renderIn([256, 1024], [300, 500]);
    expect(placeIconList(trigger)).toBe('wide-start');
  });

  it('opens wide to the left for a narrow button at the right edge of a dialog', () => {
    // The prompt editor: the picker is the last, narrow column of the dialog's body.
    const { trigger } = renderIn([256, 1024], [840, 1004]);
    expect(placeIconList(trigger)).toBe('wide-end');
  });

  it('stays as wide as the button in a column narrower than 24rem', () => {
    // The app editor beside the test chat at 1024 px: a column of 324 px.
    const { trigger } = renderIn([284, 608], [300, 592]);
    expect(placeIconList(trigger)).toBe('fit');
  });

  it('stays as wide as a button that is wide enough itself', () => {
    const { trigger } = renderIn([0, 1280], [100, 700]);
    expect(placeIconList(trigger)).toBe('fit');
  });

  it('respects the page as well as the scroll container', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 400
    });
    const { trigger } = renderIn([0, 2000], [100, 300]);
    expect(placeIconList(trigger)).toBe('fit');
  });
});

describe('IconPicker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 1280
    });
  });
  afterEach(() => jest.useRealTimers());

  const list = trigger => document.getElementById(trigger.getAttribute('aria-controls'));

  it('never makes the list wider than its button without measuring room for it', () => {
    const { trigger } = renderIn([284, 608], [300, 592]);
    fireEvent.click(trigger);
    expect(list(trigger)).toHaveAttribute('data-placement', 'fit');
    expect(list(trigger).className).not.toMatch(/min-w-/);
  });

  it('aligns the wide list with the right edge of a button at the edge of its container', () => {
    const { trigger } = renderIn([256, 1024], [840, 1004]);
    fireEvent.click(trigger);
    expect(list(trigger)).toHaveClass('right-0', 'min-w-[24rem]');
    expect(list(trigger)).not.toHaveClass('left-0');
  });

  it('measures again each time the list opens', () => {
    const { trigger } = renderIn([256, 1024], [300, 500]);
    fireEvent.click(trigger);
    expect(list(trigger)).toHaveAttribute('data-placement', 'wide-start');
    fireEvent.click(trigger);
    // A panel opened beside the form: the column is narrow now.
    trigger.getBoundingClientRect = () => box(300, 592);
    trigger.parentElement.parentElement.getBoundingClientRect = () => box(284, 608);
    fireEvent.click(trigger);
    expect(list(trigger)).toHaveAttribute('data-placement', 'fit');
  });

  it('focuses the search field without scrolling', () => {
    const { trigger } = renderIn([256, 1024], [300, 500]);
    fireEvent.click(trigger);
    const search = list(trigger).querySelector('input');
    const focus = jest.spyOn(search, 'focus');
    act(() => jest.advanceTimersByTime(150));
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});
