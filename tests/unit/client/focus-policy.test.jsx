// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';
import {
  RECENT_INTERACTION_MS,
  focusIsFree,
  isEditable,
  isShown,
  mayTakeFocus,
  noteAutoFocus,
  noteInteraction,
  resetFocusPolicy
} from '../../../client/src/shared/utils/focusPolicy';
import { AnnouncerProvider } from '../../../client/src/shared/announce/AnnouncerProvider';
import ApprovalCard from '../../../client/src/features/chat/components/ApprovalCard';
import ClarificationCard from '../../../client/src/features/chat/components/ClarificationCard';

/**
 * A card that appears by itself (an approval, a question of the assistant) does
 * not take the keyboard focus while the person types (#3191): the focus and
 * the text stay in the composer, an Enter there never answers the card, and
 * the card's arrival is said through the page's live region instead.
 */

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span data-testid="icon" />
}));

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
    parseMissingKeyHandler: key => `MISSING:${key}`,
    saveMissing: false
  });
});

beforeEach(() => {
  resetFocusPolicy();
});

afterEach(async () => {
  await mockI18n.changeLanguage('en');
  resetFocusPolicy();
});

const APPROVAL = {
  interactionId: 'approve-1',
  status: 'pending',
  toolId: 'jira__comment',
  toolName: 'Add comment',
  sideEffect: 'write',
  dataFlow: 'external',
  args: { issueKey: 'ACME-12' }
};

const QUESTION = {
  questionId: 'q-1',
  question: 'Which year?',
  inputType: 'single_select',
  options: [
    { label: '2024', value: '2024' },
    { label: '2025', value: '2025' }
  ],
  allowSkip: true
};

/** The chat composer as far as the policy sees it: a form marked `data-composer`. */
function Composer({ onSend }) {
  const [value, setValue] = useState('');
  return (
    <form
      data-composer=""
      onSubmit={event => {
        event.preventDefault();
        onSend(value);
      }}
    >
      <textarea
        aria-label="Type your message"
        value={value}
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form.requestSubmit();
          }
        }}
      />
      <button type="submit">Send</button>
    </form>
  );
}

/** A chat page in miniature: a card slot above the composer, inside the announcer. */
function Page({ card, onSend = () => {} }) {
  return (
    <AnnouncerProvider>
      <div data-testid="card-slot">{card}</div>
      <Composer onSend={onSend} />
    </AnnouncerProvider>
  );
}

describe('mayTakeFocus', () => {
  const mount = html => {
    document.body.innerHTML = html;
  };
  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('yes when nothing is focused and the composer is empty', () => {
    mount('<form data-composer><textarea></textarea></form><button>x</button>');
    expect(mayTakeFocus()).toBe(true);
    document.querySelector('button').focus();
    expect(mayTakeFocus()).toBe(true);
  });

  test('no while the focus is anywhere in the composer, also on its buttons', () => {
    mount('<form data-composer><textarea></textarea><button>Send</button></form>');
    document.querySelector('textarea').focus();
    expect(mayTakeFocus()).toBe(false);
    document.querySelector('button').focus();
    expect(mayTakeFocus()).toBe(false);
  });

  test('no while the composer holds text, wherever the focus is; a disabled composer does not count', () => {
    mount('<form data-composer><textarea></textarea></form><button>x</button>');
    const field = document.querySelector('textarea');
    field.value = 'half a sentence';
    document.querySelector('button').focus();
    expect(mayTakeFocus()).toBe(false);
    field.value = '   ';
    expect(mayTakeFocus()).toBe(true);
    field.value = 'half a sentence';
    field.disabled = true;
    expect(mayTakeFocus()).toBe(true);
  });

  test('no while the focus is in any other text field or editable element', () => {
    mount(
      '<input id="search" type="search"><input id="box" type="checkbox"><select id="s"><option>a</option></select><div id="ed" contenteditable="true" tabindex="0"></div>'
    );
    document.getElementById('search').focus();
    expect(mayTakeFocus()).toBe(false);
    document.getElementById('s').focus();
    expect(mayTakeFocus()).toBe(false);
    document.getElementById('ed').focus();
    expect(mayTakeFocus()).toBe(false);
    document.getElementById('box').focus();
    expect(mayTakeFocus()).toBe(true);
  });

  test('no for a moment after the person typed or pressed a pointer', () => {
    mount('<input id="a"><button id="b">x</button>');
    noteInteraction(1000);
    expect(mayTakeFocus({ at: 1000 + RECENT_INTERACTION_MS - 1 })).toBe(false);
    expect(mayTakeFocus({ at: 1000 + RECENT_INTERACTION_MS })).toBe(true);
  });

  test('a key in a text field and a pointer press anywhere count as an interaction; a key elsewhere does not', () => {
    mount('<input id="a"><button id="b">x</button>');
    fireEvent.keyDown(document.getElementById('b'), { key: 'a' });
    expect(mayTakeFocus()).toBe(true);
    fireEvent.keyDown(document.getElementById('a'), { key: 'a' });
    expect(mayTakeFocus()).toBe(false);
    resetFocusPolicy();
    fireEvent.pointerDown(document.getElementById('b'));
    expect(mayTakeFocus()).toBe(false);
  });

  test('isShown: a hidden copy is not shown; without checkVisibility everything counts as shown', () => {
    mount('<p id="p">x</p>');
    const p = document.getElementById('p');
    expect(isShown(p)).toBe(true);
    p.checkVisibility = () => false;
    expect(isShown(p)).toBe(false);
    expect(isShown(null)).toBe(false);
  });

  test('focusIsFree: only the page or the composer holds the focus', () => {
    mount(
      '<form data-composer><textarea></textarea></form><input id="other"><button id="b">x</button>'
    );
    expect(focusIsFree()).toBe(true);
    document.querySelector('textarea').focus();
    expect(focusIsFree()).toBe(true);
    document.getElementById('other').focus();
    expect(focusIsFree()).toBe(false);
    document.getElementById('b').focus();
    expect(focusIsFree()).toBe(false);
  });

  test('a disabled or inert element the browser still reports as focused holds no focus', () => {
    mount(
      '<form data-composer><textarea></textarea></form><input id="other"><div inert><button id="in">x</button></div>'
    );
    const composer = document.querySelector('textarea');
    composer.focus();
    expect(mayTakeFocus()).toBe(false);
    // The composer is disabled while an answer runs. jsdom, like a browser without the
    // focus fixup, leaves the disabled field as the active element.
    composer.disabled = true;
    expect(document.activeElement).toBe(composer);
    expect(mayTakeFocus()).toBe(true);
    expect(focusIsFree()).toBe(true);

    const other = document.getElementById('other');
    other.focus();
    expect(mayTakeFocus()).toBe(false);
    expect(focusIsFree()).toBe(false);
    other.disabled = true;
    expect(document.activeElement).toBe(other);
    expect(mayTakeFocus()).toBe(true);
    expect(focusIsFree()).toBe(true);

    const inert = document.getElementById('in');
    inert.focus();
    expect(document.activeElement).toBe(inert);
    expect(focusIsFree()).toBe(true);
  });

  test('a composer the page focused by itself (end of a turn) does not count as typing, until the person acts', () => {
    mount('<form data-composer><textarea></textarea></form><input id="search">');
    const composer = document.querySelector('textarea');
    composer.focus();
    noteAutoFocus(composer);
    expect(mayTakeFocus()).toBe(true);
    // A key in it: now the person types there.
    fireEvent.keyDown(composer, { key: 'a' });
    expect(mayTakeFocus({ at: Number.MAX_SAFE_INTEGER })).toBe(false);

    resetFocusPolicy();
    noteAutoFocus(composer);
    // A pointer press anywhere ends it as well.
    fireEvent.pointerDown(document.body);
    expect(mayTakeFocus({ at: Number.MAX_SAFE_INTEGER })).toBe(false);

    // Text in it still keeps the focus away, and so does a field the person went to.
    resetFocusPolicy();
    noteAutoFocus(composer);
    composer.value = 'draft';
    expect(mayTakeFocus()).toBe(false);
    composer.value = '';
    document.getElementById('search').focus();
    expect(mayTakeFocus()).toBe(false);
  });

  test('isEditable', () => {
    mount('<input id="t"><input id="r" type="radio"><textarea id="x"></textarea><p id="p"></p>');
    expect(isEditable(document.getElementById('t'))).toBe(true);
    expect(isEditable(document.getElementById('x'))).toBe(true);
    expect(isEditable(document.getElementById('r'))).toBe(false);
    expect(isEditable(document.getElementById('p'))).toBe(false);
    expect(isEditable(null)).toBe(false);
    // Nobody types into a disabled field, nor into one of a disabled fieldset.
    document.getElementById('t').disabled = true;
    expect(isEditable(document.getElementById('t'))).toBe(false);
    mount('<fieldset disabled><input id="f"></fieldset>');
    expect(isEditable(document.getElementById('f'))).toBe(false);
  });
});

describe('ApprovalCard and the focus policy', () => {
  test('while the person types, an approval that appears leaves focus and text in the composer, and Enter does not approve', async () => {
    jest.useFakeTimers();
    try {
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      const onDecide = jest.fn();
      const onSend = jest.fn();
      const { rerender } = render(<Page card={null} onSend={onSend} />);
      const composer = screen.getByRole('textbox', { name: 'Type your message' });
      await user.click(composer);
      await user.keyboard('Use the newer');

      // The run asks for approval in the middle of the sentence.
      rerender(
        <Page card={<ApprovalCard approval={APPROVAL} onDecide={onDecide} />} onSend={onSend} />
      );
      expect(screen.getByTestId('tool-approval-card')).toBeInTheDocument();
      expect(composer).toHaveFocus();
      expect(composer).toHaveValue('Use the newer');
      // Said instead of focused.
      expect(screen.getByRole('status')).toHaveTextContent('Approval needed: Add comment');

      await user.keyboard(' numbers{Enter}');
      expect(onDecide).not.toHaveBeenCalled();
      expect(onSend).toHaveBeenCalledWith('Use the newer numbers');
      expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  test('when the person is not typing, the approval takes the focus as before', () => {
    render(<Page card={<ApprovalCard approval={APPROVAL} onDecide={() => {}} />} />);
    expect(screen.getByTestId('tool-approval-card')).toHaveFocus();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  test('after a send the disabled composer still reported as focused does not keep the approval from the focus', () => {
    const { rerender } = render(<Page card={null} />);
    const composer = screen.getByRole('textbox', { name: 'Type your message' });
    composer.focus();
    // The turn runs: the composer is disabled but, without the focus fixup, still active.
    composer.disabled = true;
    expect(document.activeElement).toBe(composer);
    rerender(<Page card={<ApprovalCard approval={APPROVAL} onDecide={() => {}} />} />);
    expect(screen.getByTestId('tool-approval-card')).toHaveFocus();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  test('the card names what it asks when it takes the focus: its intro describes it', () => {
    render(<Page card={<ApprovalCard approval={APPROVAL} onDecide={() => {}} />} />);
    expect(screen.getByTestId('tool-approval-card')).toHaveAccessibleDescription(
      'The assistant wants to run this tool with the arguments below. Nothing is sent until you choose.'
    );
  });

  test('a card that cannot be answered here still says that an approval waits, and takes no focus', () => {
    render(<Page card={<ApprovalCard approval={APPROVAL} />} />);
    expect(screen.getByTestId('tool-approval-card')).not.toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Approval needed: Add comment');
  });

  test('draft text in the composer is enough to keep the focus away', () => {
    const { rerender } = render(<Page card={null} />);
    const composer = screen.getByRole('textbox', { name: 'Type your message' });
    fireEvent.change(composer, { target: { value: 'draft' } });
    composer.blur();
    resetFocusPolicy();
    rerender(<Page card={<ApprovalCard approval={APPROVAL} onDecide={() => {}} />} />);
    expect(screen.getByTestId('tool-approval-card')).not.toHaveFocus();
  });

  test('German announcement from the real locale file', async () => {
    await mockI18n.changeLanguage('de');
    const { rerender } = render(<Page card={null} />);
    screen.getByRole('textbox').focus();
    rerender(<Page card={<ApprovalCard approval={APPROVAL} onDecide={() => {}} />} />);
    expect(screen.getByRole('status')).toHaveTextContent('Freigabe erforderlich: Add comment');
  });
});

describe('a copy the page does not show', () => {
  test('neither takes the focus nor is announced', () => {
    const original = HTMLElement.prototype.checkVisibility;
    HTMLElement.prototype.checkVisibility = function checkVisibility() {
      return !this.closest('[data-copy="hidden"]');
    };
    try {
      render(
        <Page
          card={
            <div data-copy="hidden">
              <ApprovalCard approval={APPROVAL} onDecide={() => {}} />
            </div>
          }
        />
      );
      expect(screen.getByTestId('tool-approval-card')).not.toHaveFocus();
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
    } finally {
      if (original) HTMLElement.prototype.checkVisibility = original;
      else delete HTMLElement.prototype.checkVisibility;
    }
  });
});

describe('ClarificationCard and the focus policy', () => {
  test('is a group named by its question, not a modal dialog', () => {
    render(<Page card={<ClarificationCard clarification={QUESTION} onSubmit={jest.fn()} />} />);
    const group = screen.getByRole('group', { name: 'Which year?' });
    expect(group).not.toHaveAttribute('aria-modal');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('two questions on the page have their own names', () => {
    render(
      <Page
        card={
          <>
            <ClarificationCard clarification={QUESTION} onSubmit={jest.fn()} />
            <ClarificationCard
              clarification={{ ...QUESTION, questionId: 'q-2', question: 'Which region?' }}
              onSubmit={jest.fn()}
            />
          </>
        }
      />
    );
    expect(screen.getByRole('group', { name: 'Which year?' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Which region?' })).toBeInTheDocument();
  });

  test('Tab leaves the card after its last control (no Tab trap)', async () => {
    const user = userEvent.setup();
    render(<Page card={<ClarificationCard clarification={QUESTION} onSubmit={jest.fn()} />} />);
    const submit = screen.getByRole('button', { name: 'Submit answer' });
    // Submit is disabled until something is chosen; choose, then go to Submit.
    await user.click(screen.getByRole('option', { name: /2025/ }));
    submit.focus();
    expect(submit).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('textbox', { name: 'Type your message' })).toHaveFocus();
  });

  test('when the person is not typing, the first control takes the focus as before', () => {
    render(<Page card={<ClarificationCard clarification={QUESTION} onSubmit={jest.fn()} />} />);
    const group = screen.getByRole('group', { name: 'Which year?' });
    expect(group).toContainElement(document.activeElement);
  });

  test('while the person types, a question that appears leaves the focus and is said instead', async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    const { rerender } = render(<Page card={null} />);
    const composer = screen.getByRole('textbox', { name: 'Type your message' });
    await user.click(composer);
    await user.keyboard('Also');
    rerender(<Page card={<ClarificationCard clarification={QUESTION} onSubmit={onSubmit} />} />);
    expect(composer).toHaveFocus();
    expect(composer).toHaveValue('Also');
    expect(screen.getByRole('status')).toHaveTextContent('The assistant asks: Which year?');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('Ctrl+Enter inside the card still submits it', async () => {
    const onSubmit = jest.fn();
    render(<Page card={<ClarificationCard clarification={QUESTION} onSubmit={onSubmit} />} />);
    const choice = screen.getByRole('option', { name: /2024/ });
    await act(async () => {
      fireEvent.click(choice);
    });
    await act(async () => {
      fireEvent.keyDown(choice, { key: 'Enter', ctrlKey: true });
    });
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: 'q-1', value: '2024', answered: true })
    );
  });
});
