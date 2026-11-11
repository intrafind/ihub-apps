// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chips under the chat input stay icon-only until hovered, and fold into a
 * "+N" chip when there are too many — so they cannot overlay each other.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChipOverflow, { HOVER_LABEL } from '../../../client/src/shared/components/ChipOverflow';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue, options) =>
      typeof defaultValue === 'string'
        ? defaultValue.replace(/{{(\w+)}}/g, (_, name) => options?.[name])
        : key
  })
}));

const items = count =>
  Array.from({ length: count }, (_, index) => ({
    key: `chip-${index}`,
    label: `Chip ${index}`,
    node: <span key={`chip-${index}`}>{`chip-${index}`}</span>
  }));

describe('ChipOverflow', () => {
  test('shows every chip while they fit', () => {
    render(<ChipOverflow items={items(3)} max={3} />);
    expect(screen.getAllByText(/^chip-/)).toHaveLength(3);
    expect(screen.queryByTestId('chip-overflow')).toBeNull();
  });

  test('folds the rest into a "+N" chip that names them', () => {
    render(<ChipOverflow items={items(6)} max={3} />);
    expect(screen.getAllByText(/^chip-/)).toHaveLength(2);
    const more = screen.getByTestId('chip-overflow');
    expect(more).toHaveTextContent('+4');
    expect(more).toHaveAttribute('title', 'Chip 2, Chip 3, Chip 4, Chip 5');
    expect(more).toHaveAccessibleName('4 more: Chip 2, Chip 3, Chip 4, Chip 5');
  });

  test('never hides a single chip behind a "+1" that is no smaller', () => {
    render(<ChipOverflow items={items(4)} max={3} />);
    expect(screen.getAllByText(/^chip-/)).toHaveLength(2);
    expect(screen.getByTestId('chip-overflow')).toHaveTextContent('+2');
  });

  test('a hover label is clipped, not removed: it stays in the accessible name', () => {
    render(
      <button type="button" className="group">
        <span className={HOVER_LABEL}>Web search</span>
      </button>
    );
    expect(screen.getByRole('button', { name: 'Web search' })).toBeInTheDocument();
    expect(HOVER_LABEL).toContain('max-w-0');
    expect(HOVER_LABEL).toContain('group-hover:max-w-');
    expect(HOVER_LABEL).toContain('group-focus-within:max-w-');
  });
});
