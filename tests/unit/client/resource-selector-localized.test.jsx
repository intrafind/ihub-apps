// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin resource picker (group, OAuth client and short-link editors) with
 * apps that have a name in one language only. The create page stores one
 * language, the base language of the UI, so `name` can be `{ de: '…' }`. The
 * picker shows that name, searches by it and does not throw; a name in several
 * languages is shown in the language of the UI.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockI18n = { language: 'en' };

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: key => key, i18n: mockI18n })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const ResourceSelector =
  require('../../../client/src/features/admin/components/ResourceSelector').default;

const GERMAN_ONLY = { id: 'uebersetzer', name: { de: 'Übersetzer' } };
const BOTH = { id: 'summarizer', name: { en: 'Summarizer', de: 'Zusammenfasser' } };
const PLAIN = { id: 'gpt', name: 'Plain model' };

/**
 * Renders the picker in the given UI language and opens its list.
 *
 * @param {object} options
 * @param {string} options.language - What `i18n.language` returns.
 * @param {Array<object>} options.resources
 * @param {string[]} [options.selected]
 * @returns {{ search: HTMLElement, onSelectionChange: jest.Mock, container: HTMLElement }}
 */
function renderSelector({ language, resources, selected = [] }) {
  mockI18n.language = language;
  const onSelectionChange = jest.fn();
  const { container } = render(
    <ResourceSelector
      label="Apps"
      resources={resources}
      selectedResources={selected}
      onSelectionChange={onSelectionChange}
    />
  );
  const search = screen.getByRole('textbox', { name: 'Apps' });
  fireEvent.focus(search);
  return { search, onSelectionChange, container };
}

/** The names the open list offers, in order. */
function offeredNames() {
  return screen
    .getAllByRole('button')
    .map(button => button.textContent)
    .filter(Boolean);
}

describe('an app with a German name only', () => {
  test('is offered by its name in an English UI', () => {
    renderSelector({ language: 'en', resources: [GERMAN_ONLY, BOTH, PLAIN] });

    expect(offeredNames()).toEqual(['Übersetzer', 'Summarizer', 'Plain model']);
  });

  test('is found by its name, and the search ignores case', () => {
    const { search, onSelectionChange } = renderSelector({
      language: 'en',
      resources: [GERMAN_ONLY, BOTH, PLAIN]
    });

    fireEvent.change(search, { target: { value: 'ÜBERS' } });
    expect(offeredNames()).toEqual(['Übersetzer']);

    fireEvent.click(screen.getByRole('button', { name: 'Übersetzer' }));
    expect(onSelectionChange).toHaveBeenCalledWith(['uebersetzer']);
  });

  test('is shown by its name once it is selected', () => {
    const { container } = renderSelector({
      language: 'en',
      resources: [GERMAN_ONLY, BOTH],
      selected: ['uebersetzer']
    });

    const chip = within(container).getByText('Übersetzer');
    expect(chip).toBeInTheDocument();
    // The selected app is no longer offered.
    expect(offeredNames()).toEqual(['Summarizer']);
  });

  test('is not found by a text that only another app has', () => {
    const { search } = renderSelector({ language: 'en', resources: [GERMAN_ONLY, BOTH] });

    fireEvent.change(search, { target: { value: 'summ' } });
    expect(offeredNames()).toEqual(['Summarizer']);
  });
});

describe('an app with an English and a German name', () => {
  test('shows the English name in an English UI', () => {
    renderSelector({ language: 'en', resources: [BOTH] });

    expect(offeredNames()).toEqual(['Summarizer']);
  });

  test('shows the German name in a German UI and searches by it', () => {
    const { search } = renderSelector({ language: 'de', resources: [BOTH, GERMAN_ONLY] });

    expect(offeredNames()).toEqual(['Zusammenfasser', 'Übersetzer']);

    fireEvent.change(search, { target: { value: 'zusammen' } });
    expect(offeredNames()).toEqual(['Zusammenfasser']);

    // The English name is not what a German UI shows, so it is not searched.
    fireEvent.change(search, { target: { value: 'summarizer' } });
    expect(screen.queryByRole('button', { name: 'Zusammenfasser' })).not.toBeInTheDocument();
  });

  test('reads the base language of a regional UI language', () => {
    renderSelector({ language: 'de-DE', resources: [BOTH], selected: [] });

    expect(offeredNames()).toEqual(['Zusammenfasser']);
  });

  test('shows the selected app in the UI language', () => {
    const { container } = renderSelector({
      language: 'de',
      resources: [BOTH],
      selected: ['summarizer']
    });

    expect(within(container).getByText('Zusammenfasser')).toBeInTheDocument();
    expect(within(container).queryByText('Summarizer')).not.toBeInTheDocument();
  });
});

describe('names the picker cannot resolve', () => {
  test('an app without a name is shown and found by its ID', () => {
    const { search } = renderSelector({
      language: 'en',
      resources: [{ id: 'no-name' }, { id: 'empty-name', name: {} }, { id: 'blank', name: '  ' }]
    });

    expect(offeredNames()).toEqual(['no-name', 'empty-name', 'blank']);

    fireEvent.change(search, { target: { value: 'empty' } });
    expect(offeredNames()).toEqual(['empty-name']);
  });

  test('a plain text name is shown as it is, in any UI language', () => {
    renderSelector({ language: 'de', resources: [PLAIN] });

    expect(offeredNames()).toEqual(['Plain model']);
  });
});
