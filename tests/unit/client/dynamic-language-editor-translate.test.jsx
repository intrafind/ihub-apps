// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Translate" answers after a request: the answer goes into the target
 * language of what the field holds then, so text edited in another language
 * while the request ran is kept, and a language removed meanwhile stays
 * removed (#3811).
 */
import '@testing-library/jest-dom';
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

const mockTranslate = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  translateText: (...args) => mockTranslate(...args)
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

const DynamicLanguageEditor =
  require('../../../client/src/shared/components/DynamicLanguageEditor').default;

let latest;
function Field({ initial }) {
  const [value, setValue] = useState(initial);
  latest = value;
  return <DynamicLanguageEditor label="Message" name="msg" value={value} onChange={setValue} />;
}

/** A translation request that answers when told to. */
const deferTranslation = () => {
  let answer;
  mockTranslate.mockImplementation(
    () =>
      new Promise(resolve => {
        answer = translation => resolve({ translation });
      })
  );
  return text => act(async () => answer(text));
};

const translateButtons = () => screen.getAllByTitle('Translate');

beforeEach(() => mockTranslate.mockReset());

test('keeps text edited in another language while the translation ran', async () => {
  const answer = deferTranslation();
  render(<Field initial={{ en: 'Hello', de: '' }} />);

  fireEvent.click(translateButtons()[1]); // translate into `de`
  fireEvent.change(document.getElementById('msg.en'), { target: { value: 'Hello there' } });
  await answer('Hallo');

  expect(latest).toEqual({ en: 'Hello there', de: 'Hallo' });
});

test('does not bring back a language removed while the translation ran', async () => {
  const answer = deferTranslation();
  render(<Field initial={{ en: 'Hello', de: '' }} />);

  fireEvent.click(translateButtons()[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Remove language DE' }));
  await answer('Hallo');

  expect(latest).toEqual({ en: 'Hello' });
});

test('fills in the translation when nothing changed meanwhile', async () => {
  const answer = deferTranslation();
  render(<Field initial={{ en: 'Hello', de: '' }} />);

  fireEvent.click(translateButtons()[1]);
  await answer('Hallo');

  expect(latest).toEqual({ en: 'Hello', de: 'Hallo' });
  expect(mockTranslate).toHaveBeenCalledWith({ text: 'Hello', from: 'en', to: 'de' });
});
