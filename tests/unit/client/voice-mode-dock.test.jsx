/**
 * The voice mode dock's controls and accessibility (issue #2868, follow-ups
 * of the UX/WCAG review and the inline redesign): keyboard and pointer
 * push-to-talk, the settings popover, Stop the answer, the live transcript, the
 * read-along mark in the chat message, the error and notice lines, focus.
 *
 * The hook is a plain object of `jest.fn()`s: the dock only reads its state
 * and calls it. What the error texts say lives in voice-mode-dock-errors.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import fs from 'node:fs';
import path from 'node:path';
import VoiceModeDock from '../../../client/src/features/voice/components/VoiceModeDock';
import {
  VOICE_STATUS,
  initialVoiceModeState
} from '../../../client/src/features/voice/utils/voiceModeReducer';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key, defaultOrOptions) => (typeof defaultOrOptions === 'string' ? defaultOrOptions : key)
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

/** A hook return for the dock, in `status`, with every action a spy. */
function makeVoiceMode({
  status = VOICE_STATUS.LISTENING,
  listeningStyle = 'push-to-talk',
  state = {},
  ...overrides
} = {}) {
  return {
    state: {
      ...initialVoiceModeState({ listeningStyle, bargeIn: true }),
      status,
      ...state
    },
    prefs: { listeningStyle, bargeIn: true, captions: true },
    levelRef: { current: 0 },
    end: jest.fn(),
    retry: jest.fn(),
    interrupt: jest.fn(),
    setMuted: jest.fn(),
    pushToTalkStart: jest.fn(),
    pushToTalkEnd: jest.fn(),
    setListeningStyle: jest.fn(),
    setBargeIn: jest.fn(),
    setCaptions: jest.fn(),
    sendText: jest.fn(async () => true),
    ...overrides
  };
}

function renderDock(options) {
  const voiceMode = makeVoiceMode(options);
  const view = render(<VoiceModeDock voiceMode={voiceMode} />);
  return {
    voiceMode,
    ...view,
    /** Same dock, new hook state (the hook re-renders it like this). */
    update: next => {
      const updated = makeVoiceMode({ ...options, ...next });
      view.rerender(<VoiceModeDock voiceMode={updated} />);
      return updated;
    }
  };
}

const holdButton = () => screen.getByRole('button', { name: /^(Hold to talk|Release to send)$/ });
const dockRoot = () => screen.getByTestId('voice-mode-dock');
const muteButton = () => screen.getByRole('button', { name: 'Mute microphone' });
const unmuteButton = () => screen.getByRole('button', { name: 'Unmute microphone' });
const gear = () => screen.getByRole('button', { name: 'Voice settings' });

// jsdom has no PointerEvent: without one `fireEvent.pointerDown` builds a plain
// Event that has no `button` or `pointerId`.
beforeAll(() => {
  window.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  };
});
afterAll(() => {
  delete window.PointerEvent;
});

afterEach(() => {
  delete window.matchMedia;
  document.body.innerHTML = '';
});

describe('Esc and the settings popover', () => {
  test('Esc ends voice mode', () => {
    const { voiceMode } = renderDock();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(voiceMode.end).toHaveBeenCalledWith('user');
  });

  test('Esc closes the popover first and gives the focus back to the gear; a second Esc ends', () => {
    const { voiceMode } = renderDock();
    fireEvent.click(gear());
    expect(screen.getByRole('dialog', { name: 'Voice settings' })).toBeInTheDocument();
    // Focus is inside the popover when Esc is pressed.
    screen.getByRole('radio', { name: /Hands-free/ }).focus();

    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(voiceMode.end).not.toHaveBeenCalled();
    expect(gear()).toHaveFocus();

    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(voiceMode.end).toHaveBeenCalledWith('user');
  });

  test('the gear opens and closes the popover with the mouse', () => {
    renderDock();
    const press = () => {
      // A mouse click is mousedown, then click. The outside-closer listens to
      // the mousedown: it must not close the popover the click then reopens.
      fireEvent.mouseDown(gear());
      fireEvent.click(gear(), { detail: 1 });
    };
    expect(gear()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(gear()).toHaveAttribute('aria-expanded', 'false');
    expect(gear()).not.toHaveAttribute('aria-controls');

    press();
    const popover = screen.getByRole('dialog', { name: 'Voice settings' });
    expect(gear()).toHaveAttribute('aria-expanded', 'true');
    expect(gear()).toHaveAttribute('aria-controls', popover.id);

    press();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(gear()).toHaveAttribute('aria-expanded', 'false');
  });

  test('a press outside closes it, a press inside does not', () => {
    renderDock();
    fireEvent.click(gear());
    const popover = screen.getByRole('dialog');

    fireEvent.mouseDown(within(popover).getByText('Show live transcript'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId('voice-mode-status'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('keeps its boxes at full size and scrolls instead of being clipped', () => {
    renderDock();
    fireEvent.click(gear());
    const popover = screen.getByRole('dialog');
    expect(popover.className).toContain('max-h-[min(24rem,calc(100dvh-8rem))]');
    // It opens upwards from the dock, which sits at the bottom of the chat.
    expect(popover.className).toContain('bottom-full');
    expect(popover.className).toContain('overflow-y-auto');
    const inputs = popover.querySelectorAll('input');
    expect(inputs).toHaveLength(4);
    for (const input of inputs) expect(input.className).toContain('shrink-0');
  });

  test('Space does not push to talk while the popover is open', () => {
    const { voiceMode } = renderDock();
    fireEvent.click(gear());
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(voiceMode.pushToTalkStart).not.toHaveBeenCalled();
  });
});

describe('Space is push-to-talk', () => {
  test('Space starts the turn, repeats are ignored, releasing it ends the turn', () => {
    const { voiceMode } = renderDock();
    expect(fireEvent.keyDown(document.body, { key: ' ' })).toBe(false); // default prevented: no page scroll
    expect(voiceMode.pushToTalkStart).toHaveBeenCalledTimes(1);
    expect(holdButton()).toHaveTextContent('Release to send');

    fireEvent.keyDown(document.body, { key: ' ', repeat: true });
    expect(voiceMode.pushToTalkStart).toHaveBeenCalledTimes(1);

    fireEvent.keyUp(document.body, { key: ' ' });
    expect(voiceMode.pushToTalkEnd).toHaveBeenCalledTimes(1);
    expect(holdButton()).toHaveTextContent('Hold to talk');
  });

  test('a Space that did not start a hold does not end one', () => {
    const { voiceMode } = renderDock();
    fireEvent.keyUp(document.body, { key: ' ' });
    expect(voiceMode.pushToTalkEnd).not.toHaveBeenCalled();
  });

  test.each([
    ['an input', () => document.createElement('input')],
    ['a textarea', () => document.createElement('textarea')],
    ['a select', () => document.createElement('select')],
    ['a link', () => Object.assign(document.createElement('a'), { href: '#x' })],
    [
      'an editable element',
      () => Object.assign(document.createElement('div'), { contentEditable: 'true' })
    ]
  ])('Space is not push-to-talk in %s', (_name, make) => {
    const { voiceMode } = renderDock();
    const element = make();
    // jsdom does not implement contenteditable's property.
    if (element.contentEditable === 'true')
      Object.defineProperty(element, 'isContentEditable', { value: true });
    document.body.appendChild(element);
    element.focus();
    fireEvent.keyDown(element, { key: ' ' });
    expect(voiceMode.pushToTalkStart).not.toHaveBeenCalled();
  });

  test('Space on the Mute button presses the button, it does not talk', () => {
    const { voiceMode } = renderDock();
    const mute = muteButton();
    mute.focus();
    fireEvent.keyDown(mute, { key: ' ' });
    expect(voiceMode.pushToTalkStart).not.toHaveBeenCalled();
  });

  test('Space on the focused Hold button starts and ends the hold, and swallows the click', () => {
    const { voiceMode } = renderDock();
    const hold = holdButton();
    hold.focus();

    expect(fireEvent.keyDown(hold, { key: ' ' })).toBe(false);
    expect(voiceMode.pushToTalkStart).toHaveBeenCalledTimes(1);
    // The release is cancelled too, or the browser turns it into a click and
    // the latch below would start a second turn.
    expect(fireEvent.keyUp(hold, { key: ' ' })).toBe(false);
    expect(voiceMode.pushToTalkEnd).toHaveBeenCalledTimes(1);
  });

  test('Enter on the focused Hold button holds as well', () => {
    const { voiceMode } = renderDock();
    const hold = holdButton();
    hold.focus();
    expect(fireEvent.keyDown(hold, { key: 'Enter' })).toBe(false);
    expect(voiceMode.pushToTalkStart).toHaveBeenCalledTimes(1);
    expect(fireEvent.keyUp(hold, { key: 'Enter' })).toBe(false);
    expect(voiceMode.pushToTalkEnd).toHaveBeenCalledTimes(1);
  });

  test('Space does nothing in hands-free mode, and there is no Hold button', () => {
    const { voiceMode } = renderDock({ listeningStyle: 'hands-free' });
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(voiceMode.pushToTalkStart).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Hold to talk/ })).not.toBeInTheDocument();
  });

  test('Space does nothing while connecting or after an error', () => {
    const connecting = renderDock({ status: VOICE_STATUS.CONNECTING });
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(connecting.voiceMode.pushToTalkStart).not.toHaveBeenCalled();
    connecting.unmount();

    const failed = renderDock({
      status: VOICE_STATUS.ERROR,
      state: { error: { code: 'service', message: 'x' } }
    });
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(failed.voiceMode.pushToTalkStart).not.toHaveBeenCalled();
  });
});

describe('the microphone is never left open', () => {
  test('a window blur ends a hold whose keyup got lost', () => {
    const { voiceMode } = renderDock();
    fireEvent.keyDown(document.body, { key: ' ' });
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(voiceMode.pushToTalkEnd).toHaveBeenCalledTimes(1);
    expect(holdButton()).toHaveTextContent('Hold to talk');

    // The keyup that comes late (or never) must not end anything twice.
    fireEvent.keyUp(document.body, { key: ' ' });
    expect(voiceMode.pushToTalkEnd).toHaveBeenCalledTimes(1);
  });

  test('a blur without a hold ends nothing', () => {
    const { voiceMode } = renderDock();
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(voiceMode.pushToTalkEnd).not.toHaveBeenCalled();
  });

  test('a cancelled pointer ends the hold', () => {
    const { voiceMode } = renderDock();
    fireEvent.pointerDown(holdButton(), { button: 0, pointerId: 1 });
    fireEvent.pointerCancel(holdButton(), { pointerId: 1 });
    expect(voiceMode.pushToTalkEnd).toHaveBeenCalledTimes(1);
  });

  test('muting while the button is down ends the hold', () => {
    const { voiceMode, update } = renderDock();
    fireEvent.pointerDown(holdButton(), { button: 0, pointerId: 1 });
    expect(voiceMode.pushToTalkStart).toHaveBeenCalledTimes(1);

    const muted = update({ status: VOICE_STATUS.PAUSED, pushToTalkEnd: voiceMode.pushToTalkEnd });
    expect(muted.pushToTalkEnd).toHaveBeenCalledTimes(1);
  });
});

describe('a hold does not outlive the dock', () => {
  test('a hold still down when the dock goes away is released', () => {
    const { voiceMode, unmount } = renderDock();
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(voiceMode.pushToTalkStart).toHaveBeenCalledTimes(1);
    unmount();
    expect(voiceMode.pushToTalkEnd).toHaveBeenCalledTimes(1);
  });

  test('no hold, nothing to release', () => {
    const { voiceMode, unmount } = renderDock();
    unmount();
    expect(voiceMode.pushToTalkEnd).not.toHaveBeenCalled();
  });
});

describe('the Hold button with a pointer', () => {
  test('the primary button holds, releasing it sends', () => {
    const { voiceMode } = renderDock();
    fireEvent.pointerDown(holdButton(), { button: 0, pointerId: 1 });
    expect(voiceMode.pushToTalkStart).toHaveBeenCalledTimes(1);
    expect(holdButton()).toHaveTextContent('Release to send');

    fireEvent.pointerUp(holdButton(), { button: 0, pointerId: 1 });
    expect(voiceMode.pushToTalkEnd).toHaveBeenCalledTimes(1);

    // The click the browser sends after a real press is not a second turn.
    fireEvent.click(holdButton(), { detail: 1 });
    expect(voiceMode.pushToTalkStart).toHaveBeenCalledTimes(1);
    expect(voiceMode.pushToTalkEnd).toHaveBeenCalledTimes(1);
  });

  test('a right or middle press is ignored', () => {
    const { voiceMode } = renderDock();
    fireEvent.pointerDown(holdButton(), { button: 2, pointerId: 1 });
    fireEvent.pointerDown(holdButton(), { button: 1, pointerId: 1 });
    expect(voiceMode.pushToTalkStart).not.toHaveBeenCalled();
    expect(holdButton()).toHaveTextContent('Hold to talk');
  });

  test('the context menu does not open on a long press', () => {
    renderDock();
    expect(fireEvent.contextMenu(holdButton())).toBe(false);
  });

  test('the muted (disabled) button does not flip its label or start a turn', () => {
    const { voiceMode } = renderDock({ status: VOICE_STATUS.PAUSED });
    const hold = screen.getByRole('button', { name: 'Hold to talk' });
    expect(hold).toBeDisabled();
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    expect(voiceMode.pushToTalkStart).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Hold to talk' })).toBeInTheDocument();
  });

  test('a click without a press latches: click to talk, click again to send', () => {
    const { voiceMode } = renderDock();
    // detail 0: what a screen reader's "activate" sends.
    fireEvent.click(holdButton(), { detail: 0 });
    expect(voiceMode.pushToTalkStart).toHaveBeenCalledTimes(1);
    expect(holdButton()).toHaveTextContent('Release to send');
    expect(voiceMode.pushToTalkEnd).not.toHaveBeenCalled();

    fireEvent.click(holdButton(), { detail: 0 });
    expect(voiceMode.pushToTalkEnd).toHaveBeenCalledTimes(1);
    expect(holdButton()).toHaveTextContent('Hold to talk');
  });

  test('a press while the latch is on releases it', () => {
    const { voiceMode } = renderDock();
    fireEvent.click(holdButton(), { detail: 0 });
    fireEvent.pointerDown(holdButton(), { button: 0, pointerId: 1 });
    expect(voiceMode.pushToTalkEnd).toHaveBeenCalledTimes(1);
    expect(voiceMode.pushToTalkStart).toHaveBeenCalledTimes(1);
  });

  test('a window blur ends a latched hold too', () => {
    const { voiceMode } = renderDock();
    fireEvent.click(holdButton(), { detail: 0 });
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(voiceMode.pushToTalkEnd).toHaveBeenCalledTimes(1);
  });
});

describe('Mute', () => {
  test('toggles the microphone, and its name says which way', () => {
    const { voiceMode, update } = renderDock();
    fireEvent.click(muteButton());
    expect(voiceMode.setMuted).toHaveBeenCalledWith(true);

    const muted = update({ status: VOICE_STATUS.PAUSED });
    fireEvent.click(unmuteButton());
    expect(muted.setMuted).toHaveBeenCalledWith(false);
  });

  test('the name changes, so it is not also a pressed toggle (same for Hold)', () => {
    const { update } = renderDock();
    expect(muteButton()).not.toHaveAttribute('aria-pressed');
    expect(holdButton()).not.toHaveAttribute('aria-pressed');
    update({ status: VOICE_STATUS.PAUSED });
    expect(unmuteButton()).not.toHaveAttribute('aria-pressed');
    expect(screen.getByRole('button', { name: 'Hold to talk' })).not.toHaveAttribute(
      'aria-pressed'
    );
  });

  test('the muted button keeps a readable hover in dark mode', () => {
    renderDock({ status: VOICE_STATUS.PAUSED });
    const unmute = unmuteButton();
    expect(unmute.className).toContain('hover:bg-amber-200');
    expect(unmute.className).toContain('dark:hover:bg-amber-900/60');
  });

  test('is off while connecting and after an error', () => {
    renderDock({ status: VOICE_STATUS.CONNECTING });
    expect(muteButton()).toBeDisabled();
  });
});

describe('focus after a mouse click', () => {
  test.each([
    ['Mute', () => muteButton()],
    ['the gear', gear],
    ['Hold to talk', holdButton]
  ])('a mouse click on %s hands the focus to the dock, so Space is push-to-talk', (_n, find) => {
    renderDock();
    const button = find();
    button.focus();
    fireEvent.click(button, { detail: 1 });
    expect(dockRoot()).toHaveFocus();
  });

  test.each([
    ['Mute', () => muteButton()],
    ['the gear', gear],
    ['Hold to talk', holdButton]
  ])('a keyboard activation of %s keeps the focus where it is', (_n, find) => {
    renderDock();
    const button = find();
    button.focus();
    fireEvent.click(button, { detail: 0 });
    expect(button).toHaveFocus();
  });

  test('Space after a mouse click on Mute talks instead of pressing Mute again', () => {
    const { voiceMode } = renderDock();
    const mute = muteButton();
    mute.focus();
    fireEvent.click(mute, { detail: 1 });
    fireEvent.keyDown(document.activeElement, { key: ' ' });
    expect(voiceMode.pushToTalkStart).toHaveBeenCalledTimes(1);
  });

  test('opens with the focus on the dock and gives it back on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = renderDock();
    expect(dockRoot()).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
  });
});

describe('Stop the answer', () => {
  test.each([[VOICE_STATUS.SPEAKING], [VOICE_STATUS.THINKING]])(
    'is a button while %s, and calls interrupt without arguments',
    status => {
      const { voiceMode } = renderDock({ status });
      fireEvent.click(screen.getByRole('button', { name: 'Stop the answer and talk' }), {
        detail: 1
      });
      // The hook reads its first argument: the click event must not reach it.
      expect(voiceMode.interrupt).toHaveBeenCalledTimes(1);
      expect(voiceMode.interrupt).toHaveBeenCalledWith();
      expect(dockRoot()).toHaveFocus();
    }
  );

  test.each([
    [VOICE_STATUS.CONNECTING],
    [VOICE_STATUS.LISTENING],
    [VOICE_STATUS.USER_SPEAKING],
    [VOICE_STATUS.PAUSED]
  ])('is not there while %s', status => {
    renderDock({ status });
    expect(screen.queryByRole('button', { name: /Stop the answer/ })).toBeNull();
  });

  test('comes and goes as the status changes', () => {
    const { update } = renderDock({ status: VOICE_STATUS.LISTENING });
    expect(screen.queryByRole('button', { name: 'Stop the answer and talk' })).toBeNull();
    update({ status: VOICE_STATUS.SPEAKING });
    expect(screen.getByRole('button', { name: 'Stop the answer and talk' })).toBeInTheDocument();
    update({ status: VOICE_STATUS.LISTENING });
    expect(screen.queryByRole('button', { name: 'Stop the answer and talk' })).toBeNull();
  });
});

describe('the error', () => {
  const errored = (code = 'mic-denied') => ({
    status: VOICE_STATUS.ERROR,
    state: { error: { code, message: 'raw english detail' } }
  });

  test('is an alert of its own; the status line stays one role="status" node', () => {
    const { update } = renderDock();
    const status = screen.getByTestId('voice-mode-status');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveTextContent('Hold Space or the button to talk');

    update(errored());
    // The same node: a live region that is replaced is not announced reliably.
    expect(screen.getByTestId('voice-mode-status')).toBe(status);
    expect(status).toHaveAttribute('role', 'status');
    expect(status).not.toHaveAttribute('aria-live');
    expect(status).toBeEmptyDOMElement();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Microphone access was blocked/);
    expect(alert).not.toHaveTextContent('raw english detail');
    expect(alert).not.toHaveAttribute('aria-live');
  });

  test('there is no alert without an error', () => {
    renderDock();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('the retry button takes the focus when the error appears', () => {
    const { update } = renderDock();
    update(errored());
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry).toHaveFocus();
  });

  test('retrying calls the hook and keeps the focus in the dock', () => {
    const { update } = renderDock();
    const failed = update(errored());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(failed.retry).toHaveBeenCalledTimes(1);
    expect(dockRoot()).toHaveFocus();
  });

  test('no-speech says that nothing was said, not that something broke', () => {
    renderDock(errored('no-speech'));
    const text = screen.getByRole('alert').textContent;
    expect(text).toBe('Voice mode ended because nothing was said for a while.');
  });
});

describe('the notice', () => {
  test('a failed read-aloud is said in a status line of its own', () => {
    renderDock({ state: { notice: 'tts-failed' } });
    const notice = screen.getByTestId('voice-mode-notice');
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveTextContent('I could not speak this answer. It is in the chat.');
    expect(notice).not.toHaveClass('sr-only');
    // Not part of the status label or of an error.
    expect(screen.getByTestId('voice-mode-status')).not.toHaveTextContent(/could not speak/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('the line is there, empty and out of the way, until there is a notice', () => {
    const { update } = renderDock();
    const notice = screen.getByTestId('voice-mode-notice');
    expect(notice).toBeEmptyDOMElement();
    expect(notice).toHaveClass('sr-only');

    update({ state: { notice: 'tts-failed' } });
    // The same node, so a screen reader that watches it announces the change.
    expect(screen.getByTestId('voice-mode-notice')).toBe(notice);
    expect(notice).toHaveTextContent('I could not speak this answer');
  });
});

describe('the words on the screen', () => {
  test('push-to-talk names Space on a device with a keyboard', () => {
    renderDock();
    expect(screen.getByTestId('voice-mode-status')).toHaveTextContent(
      'Hold Space or the button to talk'
    );
  });

  test('push-to-talk does not name Space on a touch screen', () => {
    window.matchMedia = jest.fn(query => ({ matches: query === '(pointer: coarse)' }));
    renderDock();
    expect(screen.getByTestId('voice-mode-status')).toHaveTextContent('Hold the button to talk');
    expect(dockRoot()).not.toHaveTextContent('Space');
  });

  test('hands-free says it is listening on either device', () => {
    window.matchMedia = jest.fn(() => ({ matches: true }));
    renderDock({ listeningStyle: 'hands-free' });
    expect(screen.getByTestId('voice-mode-status')).toHaveTextContent('Listening…');
  });

  test('the shortcuts are named under the dock on a device with a keyboard', () => {
    renderDock();
    expect(dockRoot()).toHaveTextContent('Esc to end · Hold Space to talk');
  });

  test('a running tool is named in the status', () => {
    renderDock({
      status: VOICE_STATUS.THINKING,
      state: { toolStatus: { kind: 'search', label: 'Searching the web…' }, runActive: true }
    });
    expect(screen.getByTestId('voice-mode-status')).toHaveTextContent('Searching the web…');
  });
});

describe('End', () => {
  test('is one button, named with its shortcut, and ends voice mode', () => {
    const { voiceMode } = renderDock();
    const ends = screen.getAllByRole('button', { name: /End/ });
    expect(ends).toHaveLength(1);
    expect(ends[0]).toHaveAccessibleName('End voice mode (Esc)');
    fireEvent.click(ends[0]);
    expect(voiceMode.end).toHaveBeenCalledWith('user');
  });

  test('is not a red, destructive button: ending keeps the conversation', () => {
    renderDock();
    expect(screen.getByTestId('voice-mode-end').className).not.toMatch(/\bbg-red-/);
  });

  test("takes the state's colour", () => {
    const { update } = renderDock({ status: VOICE_STATUS.LISTENING });
    expect(screen.getByTestId('voice-mode-end').className).toContain('bg-indigo-50');
    update({ status: VOICE_STATUS.SPEAKING });
    expect(screen.getByTestId('voice-mode-end').className).toContain('bg-sky-50');
    expect(dockRoot()).toHaveAttribute('data-status', VOICE_STATUS.SPEAKING);
  });
});

describe('the chat stays usable', () => {
  test("an Esc in a dialog of the chat is the dialog's, not the end of voice mode", () => {
    const { voiceMode } = renderDock();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const close = document.createElement('button');
    dialog.appendChild(close);
    document.body.appendChild(dialog);
    close.focus();
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(voiceMode.end).not.toHaveBeenCalled();
  });

  test('an Esc another handler already took does not end voice mode', () => {
    const { voiceMode } = renderDock();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    event.preventDefault();
    act(() => {
      document.body.dispatchEvent(event);
    });
    expect(voiceMode.end).not.toHaveBeenCalled();
  });

  test('Space in a dialog of the chat does not talk', () => {
    const { voiceMode } = renderDock();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.tabIndex = -1;
    document.body.appendChild(dialog);
    dialog.focus();
    fireEvent.keyDown(dialog, { key: ' ' });
    expect(voiceMode.pushToTalkStart).not.toHaveBeenCalled();
  });
});

describe('typing while voice mode is on', () => {
  /** A dock with a draft the test controls, like AppChat's composer state. */
  function renderTyping({ value = '', ...options } = {}) {
    const voiceMode = makeVoiceMode({ listeningStyle: 'hands-free', ...options });
    const onChange = jest.fn();
    const view = render(<VoiceModeDock voiceMode={voiceMode} value={value} onChange={onChange} />);
    return {
      voiceMode,
      onChange,
      view,
      field: screen.queryByRole('textbox', { name: 'Type a message' })
    };
  }

  test('the dock is a text field; empty, it shows the state as its placeholder', () => {
    const { field } = renderTyping();
    expect(field).toHaveValue('');
    expect(screen.getByTestId('voice-mode-placeholder')).toHaveTextContent('Listening…');
    expect(screen.getByTestId('voice-mode-placeholder')).toHaveAttribute('aria-hidden', 'true');
  });

  test('what is typed goes to the draft, and hides the placeholder', () => {
    const { field, onChange } = renderTyping({ value: 'Hi' });
    expect(screen.queryByTestId('voice-mode-placeholder')).toBeNull();
    fireEvent.change(field, { target: { value: 'Hi there' } });
    expect(onChange).toHaveBeenCalledWith('Hi there');
  });

  test('Enter sends the message into the conversation and clears the field', async () => {
    const { field, voiceMode, onChange } = renderTyping({ value: '  What about Rome?  ' });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(voiceMode.sendText).toHaveBeenCalledWith('What about Rome?');
    expect(onChange).toHaveBeenCalledWith('');
  });

  test('Shift+Enter is a new line, not a send', () => {
    const { field, voiceMode } = renderTyping({ value: 'Line one' });
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(voiceMode.sendText).not.toHaveBeenCalled();
  });

  test('a message the chat turned away stays in the field', async () => {
    const { field, onChange } = renderTyping({
      value: 'Hello',
      sendText: jest.fn(async () => false)
    });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(onChange).not.toHaveBeenCalledWith('');
  });

  test('Send shows up with something typed, and sends it', async () => {
    const { voiceMode, view } = renderTyping();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    view.rerender(<VoiceModeDock voiceMode={voiceMode} value="Hello" onChange={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }), { detail: 1 });
    });
    expect(voiceMode.sendText).toHaveBeenCalledWith('Hello');
  });

  test('nothing is sent while connecting', () => {
    const { field, voiceMode } = renderTyping({ value: 'Hello', status: VOICE_STATUS.CONNECTING });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(voiceMode.sendText).not.toHaveBeenCalled();
  });

  test('Space in the field types, it does not talk', () => {
    const { field, voiceMode } = renderTyping({ listeningStyle: 'push-to-talk', value: 'a' });
    field.focus();
    fireEvent.keyDown(field, { key: ' ' });
    expect(voiceMode.pushToTalkStart).not.toHaveBeenCalled();
  });

  test('the field makes way for the error and its way out', () => {
    renderTyping({
      status: VOICE_STATUS.ERROR,
      state: { error: { code: 'service', message: 'x' } }
    });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('the live transcript', () => {
  const transcript = () => screen.queryByTestId('voice-mode-transcript');

  test('shows what the user says in place of the status, which stays the announced line', () => {
    renderDock({
      listeningStyle: 'hands-free',
      status: VOICE_STATUS.USER_SPEAKING,
      state: { userCaption: { text: 'What is the weather', final: false } }
    });
    expect(transcript()).toHaveTextContent('What is the weather');
    // Interim words are not read out one by one.
    expect(transcript()).toHaveAttribute('aria-hidden', 'true');
    const status = screen.getByTestId('voice-mode-status');
    expect(status).toHaveTextContent('Listening…');
    expect(status).toHaveClass('sr-only');
  });

  test('shows the newest words of a long sentence', () => {
    const words = `${'a'.repeat(200)} the end`;
    renderDock({
      listeningStyle: 'hands-free',
      status: VOICE_STATUS.USER_SPEAKING,
      state: { userCaption: { text: words, final: false } }
    });
    expect(transcript().textContent.startsWith('…')).toBe(true);
    expect(transcript().textContent.endsWith('the end')).toBe(true);
    expect(transcript().textContent.length).toBeLessThanOrEqual(161);
  });

  test('is gone once the turn has been sent: it lands in the chat', () => {
    renderDock({
      listeningStyle: 'hands-free',
      status: VOICE_STATUS.THINKING,
      state: { userCaption: { text: 'What is the weather', final: true }, runActive: true }
    });
    expect(transcript()).toBeNull();
    expect(screen.getByTestId('voice-mode-placeholder')).toHaveTextContent('Thinking…');
  });

  test('is gone when the app listens again: the sentence is in the chat', () => {
    renderDock({
      status: VOICE_STATUS.LISTENING,
      state: { userCaption: { text: 'What is the weather', final: true } }
    });
    expect(transcript()).toBeNull();
  });

  test('shows the words while push-to-talk is held, before speech is detected', () => {
    renderDock({
      status: VOICE_STATUS.LISTENING,
      state: { userCaption: { text: 'What is', final: false } }
    });
    expect(transcript()).toHaveTextContent('What is');
  });

  test('is not shown when the user switched it off', () => {
    const voiceMode = makeVoiceMode({
      listeningStyle: 'hands-free',
      status: VOICE_STATUS.USER_SPEAKING,
      state: { userCaption: { text: 'What is the weather', final: false } }
    });
    voiceMode.prefs = { ...voiceMode.prefs, captions: false };
    render(<VoiceModeDock voiceMode={voiceMode} />);
    expect(transcript()).toBeNull();
  });
});

describe('read-along in the chat message', () => {
  const answer = 'It is **sunny** today. Tomorrow it rains.';
  let registry;

  beforeEach(() => {
    registry = new Map();
    global.CSS = { highlights: registry };
    global.Highlight = class Highlight {
      constructor(range) {
        this.range = range;
      }
    };
    // jsdom lays nothing out: every message counts as shown.
    jest.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}]);
  });
  afterEach(() => {
    delete global.CSS;
    delete global.Highlight;
    jest.restoreAllMocks();
  });

  /** A chat scope with the answer as the chat renders it, and the dock in it. */
  function renderInChat(state) {
    const voiceMode = makeVoiceMode({ status: VOICE_STATUS.SPEAKING, state });
    return render(
      <div data-voice-scope="">
        <div role="log">
          <div data-message-role="assistant">
            <div className="markdown-content">
              <p>
                It is <strong>sunny</strong> today. Tomorrow it rains.
              </p>
            </div>
          </div>
        </div>
        <VoiceModeDock voiceMode={voiceMode} />
      </div>
    );
  }

  test('marks the part of the message still to be said', () => {
    // "It is **sunny** today. " said: the boundary sits before "Tomorrow".
    const spoken = answer.indexOf('Tomorrow');
    renderInChat({ assistantCaption: answer, spokenChars: spoken });
    const highlight = registry.get('voice-unspoken');
    expect(highlight).toBeDefined();
    expect(highlight.range.toString()).toBe('Tomorrow it rains.');
  });

  test('keeps the spot being read in view while the text runs ahead of the voice', () => {
    // A chat 100 px high; the spot being read 200 px down in it.
    jest.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100 });
    Range.prototype.getBoundingClientRect = () => ({ top: 200 });
    try {
      const view = renderInChat({ assistantCaption: answer, spokenChars: 5 });
      // Put 40% of the way down the chat: 200 - 40.
      expect(view.container.querySelector('[role="log"]').scrollTop).toBe(160);
    } finally {
      delete Range.prototype.getBoundingClientRect;
    }
  });

  test('does not pull back someone who just scrolled the chat', () => {
    jest.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100 });
    Range.prototype.getBoundingClientRect = () => ({ top: 200 });
    try {
      const voiceMode = makeVoiceMode({
        status: VOICE_STATUS.SPEAKING,
        state: { assistantCaption: answer, spokenChars: 5 }
      });
      const chat = (
        <div data-voice-scope="">
          <div role="log">
            <div data-message-role="assistant">
              <div className="markdown-content">
                <p>It is sunny today. Tomorrow it rains.</p>
              </div>
            </div>
          </div>
          <VoiceModeDock voiceMode={voiceMode} />
        </div>
      );
      const view = render(chat);
      const log = view.container.querySelector('[role="log"]');
      log.scrollTop = 0;
      fireEvent.wheel(log);
      view.rerender(
        <div data-voice-scope="">
          <div role="log">
            <div data-message-role="assistant">
              <div className="markdown-content">
                <p>It is sunny today. Tomorrow it rains.</p>
              </div>
            </div>
          </div>
          <VoiceModeDock
            voiceMode={makeVoiceMode({
              status: VOICE_STATUS.SPEAKING,
              state: { assistantCaption: answer, spokenChars: 12 }
            })}
          />
        </div>
      );
      expect(log.scrollTop).toBe(0);
    } finally {
      delete Range.prototype.getBoundingClientRect;
    }
  });

  test.each([
    ['a press on its scrollbar', log => fireEvent.pointerDown(log)],
    ['Page Up in it', log => fireEvent.keyDown(log, { key: 'PageUp' })]
  ])("%s counts as scrolling of the user's own", (_name, interact) => {
    jest.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100 });
    Range.prototype.getBoundingClientRect = () => ({ top: 200 });
    try {
      const chat = spokenChars => (
        <div data-voice-scope="">
          <div role="log" tabIndex={0}>
            <div data-message-role="assistant">
              <div className="markdown-content">
                <p>It is sunny today. Tomorrow it rains.</p>
              </div>
            </div>
          </div>
          <VoiceModeDock
            voiceMode={makeVoiceMode({
              status: VOICE_STATUS.SPEAKING,
              state: { assistantCaption: answer, spokenChars }
            })}
          />
        </div>
      );
      const view = render(chat(5));
      const log = view.container.querySelector('[role="log"]');
      log.scrollTop = 0;
      interact(log);
      view.rerender(chat(12));
      expect(log.scrollTop).toBe(0);
    } finally {
      delete Range.prototype.getBoundingClientRect;
    }
  });

  test('marks nothing when nothing is being played', () => {
    registry.set('voice-unspoken', {});
    renderInChat({ assistantCaption: answer, spokenChars: null });
    expect(registry.has('voice-unspoken')).toBe(false);
  });

  test('marks nothing once it has all been said', () => {
    renderInChat({ assistantCaption: answer, spokenChars: answer.length });
    expect(registry.has('voice-unspoken')).toBe(false);
  });

  test('takes the mark away when voice mode ends', () => {
    const view = renderInChat({ assistantCaption: answer, spokenChars: 5 });
    expect(registry.has('voice-unspoken')).toBe(true);
    view.unmount();
    expect(registry.has('voice-unspoken')).toBe(false);
  });
});

describe('styles that jsdom cannot apply', () => {
  const css = fs.readFileSync(
    path.resolve(__dirname, '../../../client/src/features/voice/components/VoiceMode.css'),
    'utf8'
  );

  test('the glow follows the state colour', () => {
    expect(css).toContain('color-mix(in srgb, var(--voice-accent)');
    for (const status of ['listening', 'thinking', 'speaking', 'paused', 'error']) {
      expect(css).toContain(`.voice-dock[data-status='${status}']`);
    }
  });

  test('the part still to be said is lighter, in light and dark', () => {
    expect(css).toMatch(/::highlight\(voice-unspoken\)\s*\{\s*color:/);
    expect(css).toMatch(/\[data-theme='dark'\]\)\s*::highlight\(voice-unspoken\)/);
  });

  test('motion stops for people who asked for less of it', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.voice-glow');
    expect(reduced).toContain('.voice-bars rect');
    expect(reduced).toMatch(/animation:\s*none/);
  });
});
