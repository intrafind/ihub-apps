// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';
import PendingWorkStrip from '../../../client/src/features/chat/components/PendingWorkStrip';

/**
 * What waits in a chat (#3191): the strip is a pure function of the server's
 * `pending[]` (docs/chat-persistence.md, "Messages for the running answer"):
 * labels from `labelKey`, buttons from `actions`, never anything worked out
 * from an id. Four items can be reached and removed by keyboard.
 */

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
    parseMissingKeyHandler: key => `MISSING:${key}`,
    saveMissing: false
  });
});

afterEach(async () => {
  await mockI18n.changeLanguage('en');
});

/** An item as `chatPendingView` (server/services/chat/chatSteering.js) sends it. */
const item = (n, overrides = {}) => ({
  id: `steer-${n}`,
  runId: 'run-1',
  kind: 'steer',
  labelKey: 'chat.pending.steer',
  text: `Message number ${n}`,
  actions: ['remove'],
  ...overrides
});

describe('PendingWorkStrip', () => {
  test('renders nothing without items', () => {
    const { container } = render(<PendingWorkStrip items={[]} />);
    expect(container).toBeEmptyDOMElement();
    render(<PendingWorkStrip items={undefined} />);
    expect(screen.queryByTestId('pending-work-strip')).toBeNull();
  });

  test('is a named list; each item is a text button and a separate, named action button', () => {
    const onAction = jest.fn();
    render(
      <PendingWorkStrip
        items={[
          item(1),
          item(2, {
            kind: 'send_after',
            labelKey: 'chat.pending.sendAfter',
            text: 'Then summarise'
          })
        ]}
        onAction={onAction}
      />
    );
    const list = screen.getByRole('list', { name: 'Pending in this chat' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Will be read at the next step: Message number 1');
    expect(rows[1]).toHaveTextContent('Will be sent as the next message: Then summarise');
    const remove = within(rows[1]).getByRole('button', { name: 'Remove message: Then summarise' });
    expect(remove.className).toMatch(/\bh-6\b/);
    expect(remove.className).toMatch(/\bw-6\b/);
    act(() => remove.click());
    expect(onAction).toHaveBeenCalledWith('remove', expect.objectContaining({ id: 'steer-2' }));
  });

  test('takes the label from labelKey and the buttons from actions, never from the id or kind', () => {
    render(
      <PendingWorkStrip
        items={[
          // An id that reads like one kind, a kind of another, the label of a third.
          item(1, { id: 'send-after-1', kind: 'steer', labelKey: 'chat.pending.sendAfter' }),
          item(2, { actions: [] }),
          item(3, { actions: ['remove', 'teleport'] })
        ]}
        maxRows={3}
      />
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Will be sent as the next message: Message number 1');
    // A reader who is not the owner gets no actions from the server, so no button.
    expect(within(rows[1]).getAllByRole('button')).toHaveLength(1);
    // An action this client cannot name is not offered.
    expect(within(rows[2]).getAllByRole('button')).toHaveLength(2);
  });

  test('a label key this client does not know shows the text alone, one it has is looked up', () => {
    const { unmount } = render(
      <PendingWorkStrip items={[item(1, { labelKey: 'chat.pending.somethingNew' })]} />
    );
    expect(screen.getByRole('listitem')).toHaveTextContent(/^Message number 1$/);
    unmount();
    render(<PendingWorkStrip items={[item(1, { labelKey: 'common.close' })]} />);
    expect(screen.getByRole('listitem')).toHaveTextContent(/^Close: Message number 1$/);
  });

  test('the text button shows the whole text and folds it again', async () => {
    const user = userEvent.setup();
    const long = 'A long message '.repeat(20).trim();
    render(<PendingWorkStrip items={[item(1, { text: long })]} />);
    const textButton = screen.getByRole('button', { name: /Will be read at the next step/ });
    expect(textButton).toHaveAttribute('aria-expanded', 'false');
    expect(textButton.querySelector('.truncate')).not.toBeNull();
    await user.click(textButton);
    expect(textButton).toHaveAttribute('aria-expanded', 'true');
    expect(textButton.querySelector('.truncate')).toBeNull();
    expect(textButton.querySelector('.break-words')).not.toBeNull();
  });

  test('the remove button is named with a short form of the text', () => {
    render(<PendingWorkStrip items={[item(1, { text: 'x'.repeat(200) })]} />);
    const remove = screen.getByRole('button', { name: /^Remove message: x+…$/ });
    expect(remove.getAttribute('aria-label').length).toBeLessThan(90);
  });

  test('with four items the fourth is reached and removed by keyboard, and the focus stays in the strip', async () => {
    const user = userEvent.setup();
    function Host() {
      const [items, setItems] = useState([item(1), item(2), item(3), item(4)]);
      return (
        <>
          <button type="button">before</button>
          <PendingWorkStrip
            items={items}
            onAction={(action, target) =>
              // The server answers the removal; the next read of the chat no longer lists it.
              setItems(current => current.filter(entry => entry.id !== target.id))
            }
          />
        </>
      );
    }
    render(<Host />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    const disclosure = screen.getByRole('button', { name: '4 pending · Show all' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(disclosure).toHaveAttribute('aria-controls', screen.getByRole('list').id);

    // Tab through: before, text 1, remove 1, text 2, remove 2, disclosure.
    screen.getByRole('button', { name: 'before' }).focus();
    for (let i = 0; i < 5; i += 1) await user.tab();
    expect(disclosure).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(disclosure).toHaveTextContent('Show less');
    expect(screen.getAllByRole('listitem')).toHaveLength(4);

    // Back into the list: Shift+Tab lands on the fourth remove button.
    await user.tab({ shift: true });
    const fourth = screen.getByRole('button', { name: 'Remove message: Message number 4' });
    expect(fourth).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.queryByText('Message number 4')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    // The focus did not fall back to the page: it is on the row that is now last.
    expect(screen.getByRole('button', { name: 'Remove message: Message number 3' })).toHaveFocus();
  });

  test('collapsed (for an embed) starts with the disclosure alone', async () => {
    const user = userEvent.setup();
    render(<PendingWorkStrip items={[item(1)]} collapsed />);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    const disclosure = screen.getByRole('button', { name: '1 pending · Show all' });
    await user.click(disclosure);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  test('German, from the real locale file', async () => {
    await mockI18n.changeLanguage('de');
    render(
      <PendingWorkStrip
        items={[
          item(1),
          item(2, { labelKey: 'chat.pending.sendAfter', kind: 'send_after' }),
          item(3)
        ]}
      />
    );
    expect(screen.getByRole('list', { name: 'In diesem Chat ausstehend' })).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Wird beim nächsten Schritt gelesen: Message number 1');
    expect(rows[1]).toHaveTextContent('Wird als nächste Nachricht gesendet: Message number 2');
    expect(
      screen.getByRole('button', { name: 'Nachricht entfernen: Message number 1' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '3 ausstehend · Alle anzeigen' })
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/MISSING:/);
  });

  test('the chips never use the word that names the run state "queued"', () => {
    for (const locale of [en, de]) {
      for (const text of Object.values(locale.chat.pending)) {
        expect(text).not.toMatch(/\bqueued\b|\bWarteschlange\b/i);
      }
    }
  });

  test('nothing in a row can push it wider than the strip (320 px)', () => {
    render(<PendingWorkStrip items={[item(1, { text: 'unbreakable'.repeat(40) })]} />);
    const row = screen.getByRole('listitem');
    expect(row.className).toMatch(/\bmin-w-0\b/);
    const textButton = within(row).getAllByRole('button')[0];
    expect(textButton.className).toMatch(/\bmin-w-0\b/);
    expect(textButton.className).toMatch(/\bflex-1\b/);
    expect(textButton.querySelector('.truncate')).not.toBeNull();
  });
});
