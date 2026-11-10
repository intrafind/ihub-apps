// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The answer badge says when a searched project also put the sections that
 * match the question into the prompt (`knowledge/scope`: `excerpted`). The
 * server decides it; the badge only words it, in English and German.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';

const en = require('../../../shared/i18n/en.json');
const de = require('../../../shared/i18n/de.json');

let mockLanguage = 'en';
const lookup = (key, language) =>
  key.split('.').reduce((node, part) => node?.[part], language === 'de' ? de : en);
/** i18next's lookup as far as the badge needs it: plural keys and {{count}}. */
const mockT = (key, defaultOrOptions, maybeOptions) => {
  const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions;
  const count = options?.count;
  const plural = Number.isFinite(count) ? `${key}_${count === 1 ? 'one' : 'other'}` : null;
  const found = (plural && lookup(plural, mockLanguage)) ?? lookup(key, mockLanguage);
  const text = found ?? (typeof defaultOrOptions === 'string' ? defaultOrOptions : key);
  return String(text).replace('{{count}}', count);
};
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: mockLanguage } })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const AnswerSourceBadge =
  require('../../../client/src/features/chat/components/AnswerSourceBadge').default;

const renderBadge = projects =>
  render(
    <MemoryRouter>
      <AnswerSourceBadge answerSource={{ sources: [] }} knowledgeScope={{ projects }} />
    </MemoryRouter>
  );

describe('answer badge: a searched project with excerpts', () => {
  beforeEach(() => {
    mockLanguage = 'en';
  });

  it('says that relevant sections were loaded', () => {
    renderBadge([{ id: 'prj_manual', name: 'Manual', mode: 'searched', excerpted: true }]);
    expect(
      screen.getByRole('link', { name: 'Manual · searched, relevant sections loaded' })
    ).toHaveAttribute('href', '/projects/prj_manual');
  });

  it('says only "searched" without excerpts, as before', () => {
    renderBadge([{ id: 'prj_manual', name: 'Manual', mode: 'searched' }]);
    expect(screen.getByRole('link', { name: 'Manual · searched' })).toBeInTheDocument();
  });

  it('a project loaded in full is unchanged', () => {
    renderBadge([{ id: 'prj_manual', name: 'Manual', mode: 'loaded' }]);
    expect(screen.getByRole('link', { name: 'Manual · loaded in full' })).toBeInTheDocument();
  });

  it('names it per project in the tooltip when several projects were reached', () => {
    renderBadge([
      { id: 'prj_a', name: 'Manual', mode: 'searched', excerpted: true },
      { id: 'prj_b', name: 'Notes', mode: 'loaded' }
    ]);
    const badge = screen.getByTitle(/Manual: searched, relevant sections loaded/);
    expect(badge).toHaveTextContent('2 projects · 1 loaded in full · 1 searched');
    expect(badge.getAttribute('title')).toContain('Notes: loaded in full');
  });

  it('is worded in German too', () => {
    mockLanguage = 'de';
    renderBadge([{ id: 'prj_manual', name: 'Handbuch', mode: 'searched', excerpted: true }]);
    expect(
      screen.getByRole('link', { name: 'Handbuch · durchsucht, passende Abschnitte geladen' })
    ).toBeInTheDocument();
  });
});
