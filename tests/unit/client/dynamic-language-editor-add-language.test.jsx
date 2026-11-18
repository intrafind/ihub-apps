// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Add Language" adds keys in the format every localized field accepts on the
 * server (`^[a-z]{2}(-[A-Z]{2})?$`): a region code keeps its upper case, so
 * `pt-BR` is not saved as `pt-br` and rejected. A code the server would reject
 * cannot be added (#3811).
 */
import '@testing-library/jest-dom';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  translateText: jest.fn()
}));
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key, fallback, options) =>
      typeof fallback === 'string' ? fallback.replace('{{lang}}', options?.lang ?? '') : key,
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const {
  default: DynamicLanguageEditor,
  canonicalLanguageCode,
  isValidLanguageCode
} = require('../../../client/src/shared/components/DynamicLanguageEditor');

let latest;
function Field({ initial }) {
  const [value, setValue] = useState(initial);
  latest = value;
  return <DynamicLanguageEditor label="Message" name="msg" value={value} onChange={setValue} />;
}

const openAddLanguage = () => fireEvent.click(screen.getByRole('button', { name: 'Add Language' }));
const codeInput = () => screen.getByRole('textbox', { name: 'Language code (e.g., en, de, es)' });
const addButton = () => screen.getByRole('button', { name: 'Add' });
const typeCode = code => fireEvent.change(codeInput(), { target: { value: code } });

describe('canonicalLanguageCode', () => {
  test.each([
    ['de', 'de'],
    ['DE', 'de'],
    [' pt-br ', 'pt-BR'],
    ['PT_br', 'pt-BR'],
    ['en-US', 'en-US']
  ])('%p → %p', (raw, expected) => {
    expect(canonicalLanguageCode(raw)).toBe(expected);
    expect(isValidLanguageCode(canonicalLanguageCode(raw))).toBe(true);
  });

  test.each(['deu', 'pt-BRA', 'zh-Hant-TW', 'e'])('%p stays invalid', raw => {
    expect(isValidLanguageCode(canonicalLanguageCode(raw))).toBe(false);
  });
});

describe('Add Language', () => {
  beforeEach(() => {
    latest = undefined;
  });

  test('adds a code with a region in the server format', () => {
    render(<Field initial={{ en: 'Hello' }} />);
    openAddLanguage();
    typeCode('pt-br');
    fireEvent.click(addButton());

    expect(latest).toEqual({ en: 'Hello', 'pt-BR': '' });
  });

  test('refuses a code the server would reject, and says why', () => {
    render(<Field initial={{ en: 'Hello' }} />);
    openAddLanguage();
    typeCode('deu');

    expect(addButton()).toBeDisabled();
    expect(codeInput()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/two-letter language code/)).toBeInTheDocument();
  });

  test('does not add a language twice, whatever its case', () => {
    render(<Field initial={{ en: 'Hello', 'pt-BR': 'Olá' }} />);
    openAddLanguage();
    typeCode('PT-br');

    expect(addButton()).toBeDisabled();
  });

  test('offers only codes the server accepts in the list', () => {
    render(<Field initial={{ en: 'Hello' }} />);
    openAddLanguage();
    const options = within(screen.getByRole('combobox', { name: 'Select...' }))
      .getAllByRole('option')
      .map(option => option.value)
      .filter(Boolean);

    expect(options.length).toBeGreaterThan(0);
    expect(options.every(isValidLanguageCode)).toBe(true);
    expect(options).not.toContain('en');
  });
});
