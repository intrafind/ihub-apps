// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The change card of the chat builder (plan 04, sections 2.4, 2.8 and 3.1):
 * every removed and added line in full, unchanged runs folded, the stakes
 * line, warnings as sentences, suggestions to tick, Apply disabled when the
 * form changed since, and Undo with its two states. Real English texts.
 */

import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (...args) => mockI18n.t(...args), i18n: mockI18n })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const ChangeCard =
  require('../../../client/src/features/admin/components/app-conversation/ChangeCard').default;

const TEXT = en.admin.apps.conversation;
const BEFORE = { system: { en: 'Answer in a friendly tone.' }, name: { en: 'Helper' } };

function entry(changes = {}) {
  return {
    id: 2,
    role: 'builder',
    kind: 'change',
    text: 'Here is the change.',
    patch: { system: { en: 'Address the reader formally.' } },
    changed: ['system'],
    warnings: [],
    suggestions: {},
    baseSnapshot: BEFORE,
    status: 'proposed',
    ...changes
  };
}

function renderCard(props = {}) {
  const handlers = { onApply: jest.fn(), onDismiss: jest.fn(), onUndo: jest.fn() };
  render(
    <ChangeCard
      entry={entry()}
      target="admin"
      form={BEFORE}
      language="en"
      interactive
      stale={false}
      undoAvailable
      stakes={[{ key: 'admin.apps.conversation.stakes.notPublished' }]}
      {...handlers}
      {...props}
    />
  );
  return handlers;
}

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
    interpolation: { escapeValue: false }
  });
});

describe('the diff', () => {
  test('names the part in plain words and marks lines with <del>/<ins> and hidden words', () => {
    renderCard();
    expect(screen.getByRole('heading', { name: TEXT.field.system })).toBeInTheDocument();
    const removed = document.querySelector('del');
    const added = document.querySelector('ins');
    expect(removed).toHaveTextContent(`${TEXT.change.removed} − Answer in a friendly tone.`);
    expect(added).toHaveTextContent(`${TEXT.change.added} + Address the reader formally.`);
    expect(within(removed).getByText(TEXT.change.removed)).toHaveClass('sr-only');
  });

  test('a change of 8,000 characters shows every removed and added line in full', () => {
    const before = Array.from({ length: 100 }, (_, i) => `Old rule ${i}: ${'x'.repeat(70)}`);
    const after = Array.from({ length: 100 }, (_, i) => `New rule ${i}: ${'y'.repeat(70)}`);
    renderCard({
      entry: entry({
        baseSnapshot: { system: { en: before.join('\n') } },
        patch: { system: { en: after.join('\n') } }
      })
    });
    const removed = [...document.querySelectorAll('del')].map(node => node.textContent);
    const added = [...document.querySelectorAll('ins')].map(node => node.textContent);
    expect(after.join('\n').length).toBeGreaterThan(8000);
    expect(removed).toEqual(before.map(line => `${TEXT.change.removed} − ${line}`));
    expect(added).toEqual(after.map(line => `${TEXT.change.added} + ${line}`));
  });

  test('folds a long unchanged run and shows it on request', () => {
    const same = Array.from({ length: 10 }, (_, i) => `Rule ${i}`);
    renderCard({
      entry: entry({
        baseSnapshot: { system: { en: [...same, 'Old end'].join('\n') } },
        patch: { system: { en: [...same, 'New end'].join('\n') } }
      })
    });
    expect(screen.queryByText('Rule 0')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show 8 unchanged lines' }));
    expect(screen.getByText('Rule 0')).toBeInTheDocument();
  });

  test('shows input fields and example questions as lines, and colour and icon as "Look"', () => {
    renderCard({
      entry: entry({
        patch: {
          variables: [{ name: 'dept', label: { en: 'Department' }, required: true }],
          color: '#000000'
        }
      })
    });
    expect(screen.getByRole('heading', { name: TEXT.field.variables })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: TEXT.field.look })).toBeInTheDocument();
    expect(document.querySelector('ins')).toHaveTextContent('Department (required)');
  });
});

describe('around the diff', () => {
  test('says who gets the change, and the warnings as sentences', () => {
    renderCard({
      entry: entry({
        warnings: [
          { code: 'OTHER_LANGUAGES_UNCHANGED', field: 'system' },
          { code: 'FIELD_DROPPED', field: 'variables.0' },
          { code: 'FIELD_DROPPED', field: 'variables.1' },
          { code: 'UNKNOWN' }
        ]
      })
    });
    expect(screen.getByTestId('change-stakes')).toHaveTextContent(TEXT.stakes.notPublished);
    expect(screen.getByText(TEXT.warning.otherLanguages)).toBeInTheDocument();
    // Two dropped fields say it once; an unknown code gets the generic sentence.
    expect(screen.getAllByText(TEXT.warning.dropped)).toHaveLength(1);
    expect(screen.getByText(TEXT.warning.other)).toBeInTheDocument();
  });

  test('suggestions start unticked and go with Apply', () => {
    const { onApply } = renderCard({
      entry: entry({
        suggestions: { websearch: true, integrations: [{ id: 'jira', label: 'Jira' }] }
      })
    });
    const search = screen.getByRole('checkbox', { name: TEXT.change.webSearch });
    expect(search).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'use Jira' }));
    fireEvent.click(screen.getByRole('button', { name: TEXT.change.apply }));
    expect(onApply).toHaveBeenCalledWith({ webSearch: false, integrationIds: ['jira'] });
  });

  test('Apply is disabled with a reason when the form changed since', () => {
    renderCard({ stale: true });
    const apply = screen.getByRole('button', { name: TEXT.change.apply });
    expect(apply).toBeDisabled();
    expect(apply).toHaveAccessibleDescription(TEXT.change.stale);
  });

  test('an older card has no buttons', () => {
    renderCard({ interactive: false });
    expect(screen.queryByRole('button', { name: TEXT.change.apply })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: TEXT.change.dismiss })).not.toBeInTheDocument();
  });

  test('a conflict on Apply says so', () => {
    renderCard({ entry: entry({ problem: 'conflict' }) });
    expect(screen.getByRole('alert')).toHaveTextContent(TEXT.change.conflict);
  });
});

describe('after Apply', () => {
  test('the "Applied" line offers Undo', () => {
    const { onUndo } = renderCard({ entry: entry({ status: 'applied' }), testOpen: true });
    expect(screen.getByTestId('change-applied')).toHaveTextContent(TEXT.change.appliedTest);
    expect(screen.queryByRole('button', { name: TEXT.change.apply })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: TEXT.change.undo }));
    expect(onUndo).toHaveBeenCalled();
  });

  test('Undo is disabled with a reason when a changed part was edited since', () => {
    renderCard({ entry: entry({ status: 'applied' }), undoAvailable: false });
    const undo = screen.getByRole('button', { name: TEXT.change.undo });
    expect(undo).toBeDisabled();
    expect(undo).toHaveAccessibleDescription(TEXT.change.undoChanged);
  });

  test('an older applied change keeps its line without Undo', () => {
    renderCard({ entry: entry({ status: 'kept' }) });
    expect(screen.getByTestId('change-applied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: TEXT.change.undo })).not.toBeInTheDocument();
  });
});
