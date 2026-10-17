/**
 * The voice mode overlay's controls and accessibility (issue #2868, follow-ups
 * of the UX/WCAG review): keyboard and pointer push-to-talk, the settings
 * popover, the orb, the error and notice lines, focus handling.
 *
 * The hook is a plain object of `jest.fn()`s: the overlay only reads its state
 * and calls it. What the error texts say lives in voice-mode-overlay-errors.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import fs from 'node:fs';
import path from 'node:path';
import VoiceModeOverlay from '../../../client/src/features/voice/components/VoiceModeOverlay';
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

/** A hook return for the overlay, in `status`, with every action a spy. */
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
    ...overrides
  };
}

function renderOverlay(options) {
  const voiceMode = makeVoiceMode(options);
  const view = render(<VoiceModeOverlay appName="Chat" voiceMode={voiceMode} />);
  return {
    voiceMode,
    ...view,
    /** Same overlay, new hook state (the hook re-renders it like this). */
    update: next => {
      const updated = makeVoiceMode({ ...options, ...next });
      view.rerender(<VoiceModeOverlay appName="Chat" voiceMode={updated} />);
      return updated;
    }
  };
}

const holdButton = () => screen.getByRole('button', { name: /^(Hold to talk|Release to send)$/ });
const overlayRoot = () => screen.getByTestId('voice-mode-overlay');
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
    const { voiceMode } = renderOverlay();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(voiceMode.end).toHaveBeenCalledWith('user');
  });

  test('Esc closes the popover first and gives the focus back to the gear; a second Esc ends', () => {
    const { voiceMode } = renderOverlay();
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
    renderOverlay();
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
    renderOverlay();
    fireEvent.click(gear());
    const popover = screen.getByRole('dialog');

    fireEvent.mouseDown(within(popover).getByText('Show captions'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId('voice-mode-status'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('keeps its boxes at full size and scrolls instead of being clipped', () => {
    renderOverlay();
    fireEvent.click(gear());
    const popover = screen.getByRole('dialog');
    expect(popover.className).toContain('max-h-[calc(100%-4rem)]');
    expect(popover.className).toContain('overflow-y-auto');
    const inputs = popover.querySelectorAll('input');
    expect(inputs).toHaveLength(4);
    for (const input of inputs) expect(input.className).toContain('shrink-0');
  });

  test('Space does not push to talk while the popover is open', () => {
    const { voiceMode } = renderOverlay();
    fireEvent.click(gear());
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(voiceMode.pushToTalkStart).not.toHaveBeenCalled();
  });
});

describe('Space is push-to-talk', () => {
  test('Space starts the turn, repeats are ignored, releasing it ends the turn', () => {
    const { voiceMode } = renderOverlay();
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
    const { voiceMode } = renderOverlay();
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
    const { voiceMode } = renderOverlay();
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
    const { voiceMode } = renderOverlay();
    const mute = screen.getByRole('button', { name: 'Mute' });
    mute.focus();
    fireEvent.keyDown(mute, { key: ' ' });
    expect(voiceMode.pushToTalkStart).not.toHaveBeenCalled();
  });

  test('Space on the focused Hold button starts and ends the hold, and swallows the click', () => {
    const { voiceMode } = renderOverlay();
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
    const { voiceMode } = renderOverlay();
    const hold = holdButton();
    hold.focus();
    expect(fireEvent.keyDown(hold, { key: 'Enter' })).toBe(false);
    expect(voiceMode.pushToTalkStart).toHaveBeenCalledTimes(1);
    expect(fireEvent.keyUp(hold, { key: 'Enter' })).toBe(false);
    expect(voiceMode.pushToTalkEnd).toHaveBeenCalledTimes(1);
  });

  test('Space does nothing in hands-free mode, and there is no Hold button', () => {
    const { voiceMode } = renderOverlay({ listeningStyle: 'hands-free' });
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(voiceMode.pushToTalkStart).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Hold to talk/ })).not.toBeInTheDocument();
  });

  test('Space does nothing while connecting or after an error', () => {
    const connecting = renderOverlay({ status: VOICE_STATUS.CONNECTING });
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(connecting.voiceMode.pushToTalkStart).not.toHaveBeenCalled();
    connecting.unmount();

    const failed = renderOverlay({
      status: VOICE_STATUS.ERROR,
      state: { error: { code: 'service', message: 'x' } }
    });
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(failed.voiceMode.pushToTalkStart).not.toHaveBeenCalled();
  });
});

describe('the microphone is never left open', () => {
  test('a window blur ends a hold whose keyup got lost', () => {
    const { voiceMode } = renderOverlay();
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
    const { voiceMode } = renderOverlay();
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(voiceMode.pushToTalkEnd).not.toHaveBeenCalled();
  });

  test('a cancelled pointer ends the hold', () => {
    const { voiceMode } = renderOverlay();
    fireEvent.pointerDown(holdButton(), { button: 0, pointerId: 1 });
    fireEvent.pointerCancel(holdButton(), { pointerId: 1 });
    expect(voiceMode.pushToTalkEnd).toHaveBeenCalledTimes(1);
  });

  test('muting while the button is down ends the hold', () => {
    const { voiceMode, update } = renderOverlay();
    fireEvent.pointerDown(holdButton(), { button: 0, pointerId: 1 });
    expect(voiceMode.pushToTalkStart).toHaveBeenCalledTimes(1);

    const muted = update({ status: VOICE_STATUS.PAUSED, pushToTalkEnd: voiceMode.pushToTalkEnd });
    expect(muted.pushToTalkEnd).toHaveBeenCalledTimes(1);
  });
});

describe('the Hold button with a pointer', () => {
  test('the primary button holds, releasing it sends', () => {
    const { voiceMode } = renderOverlay();
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
    const { voiceMode } = renderOverlay();
    fireEvent.pointerDown(holdButton(), { button: 2, pointerId: 1 });
    fireEvent.pointerDown(holdButton(), { button: 1, pointerId: 1 });
    expect(voiceMode.pushToTalkStart).not.toHaveBeenCalled();
    expect(holdButton()).toHaveTextContent('Hold to talk');
  });

  test('the context menu does not open on a long press', () => {
    renderOverlay();
    expect(fireEvent.contextMenu(holdButton())).toBe(false);
  });

  test('the muted (disabled) button does not flip its label or start a turn', () => {
    const { voiceMode } = renderOverlay({ status: VOICE_STATUS.PAUSED });
    const hold = screen.getByRole('button', { name: 'Hold to talk' });
    expect(hold).toBeDisabled();
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    expect(voiceMode.pushToTalkStart).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Hold to talk' })).toBeInTheDocument();
  });

  test('a click without a press latches: click to talk, click again to send', () => {
    const { voiceMode } = renderOverlay();
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
    const { voiceMode } = renderOverlay();
    fireEvent.click(holdButton(), { detail: 0 });
    fireEvent.pointerDown(holdButton(), { button: 0, pointerId: 1 });
    expect(voiceMode.pushToTalkEnd).toHaveBeenCalledTimes(1);
    expect(voiceMode.pushToTalkStart).toHaveBeenCalledTimes(1);
  });

  test('a window blur ends a latched hold too', () => {
    const { voiceMode } = renderOverlay();
    fireEvent.click(holdButton(), { detail: 0 });
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(voiceMode.pushToTalkEnd).toHaveBeenCalledTimes(1);
  });
});

describe('Mute', () => {
  test('toggles the microphone, and its name says which way', () => {
    const { voiceMode, update } = renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(voiceMode.setMuted).toHaveBeenCalledWith(true);

    const muted = update({ status: VOICE_STATUS.PAUSED });
    fireEvent.click(screen.getByRole('button', { name: 'Unmute' }));
    expect(muted.setMuted).toHaveBeenCalledWith(false);
  });

  test('the name changes, so it is not also a pressed toggle (same for Hold)', () => {
    const { update } = renderOverlay();
    expect(screen.getByRole('button', { name: 'Mute' })).not.toHaveAttribute('aria-pressed');
    expect(holdButton()).not.toHaveAttribute('aria-pressed');
    update({ status: VOICE_STATUS.PAUSED });
    expect(screen.getByRole('button', { name: 'Unmute' })).not.toHaveAttribute('aria-pressed');
    expect(screen.getByRole('button', { name: 'Hold to talk' })).not.toHaveAttribute(
      'aria-pressed'
    );
  });

  test('the muted button keeps a readable hover in dark mode', () => {
    renderOverlay({ status: VOICE_STATUS.PAUSED });
    const unmute = screen.getByRole('button', { name: 'Unmute' });
    expect(unmute.className).toContain('hover:bg-amber-200');
    expect(unmute.className).toContain('dark:hover:bg-amber-900/60');
  });

  test('is off while connecting and after an error', () => {
    renderOverlay({ status: VOICE_STATUS.CONNECTING });
    expect(screen.getByRole('button', { name: 'Mute' })).toBeDisabled();
  });
});

describe('focus after a mouse click', () => {
  test.each([
    ['Mute', () => screen.getByRole('button', { name: 'Mute' })],
    ['the gear', gear],
    ['Hold to talk', holdButton]
  ])('a mouse click on %s hands the focus to the overlay, so Space is push-to-talk', (_n, find) => {
    renderOverlay();
    const button = find();
    button.focus();
    fireEvent.click(button, { detail: 1 });
    expect(overlayRoot()).toHaveFocus();
  });

  test.each([
    ['Mute', () => screen.getByRole('button', { name: 'Mute' })],
    ['the gear', gear],
    ['Hold to talk', holdButton]
  ])('a keyboard activation of %s keeps the focus where it is', (_n, find) => {
    renderOverlay();
    const button = find();
    button.focus();
    fireEvent.click(button, { detail: 0 });
    expect(button).toHaveFocus();
  });

  test('Space after a mouse click on Mute talks instead of pressing Mute again', () => {
    const { voiceMode } = renderOverlay();
    const mute = screen.getByRole('button', { name: 'Mute' });
    mute.focus();
    fireEvent.click(mute, { detail: 1 });
    fireEvent.keyDown(document.activeElement, { key: ' ' });
    expect(voiceMode.pushToTalkStart).toHaveBeenCalledTimes(1);
  });

  test('opens with the focus on the overlay and gives it back on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = renderOverlay();
    expect(overlayRoot()).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
  });
});

describe('the orb', () => {
  test.each([[VOICE_STATUS.SPEAKING], [VOICE_STATUS.THINKING]])(
    'is a button that stops the answer while %s, and calls interrupt without arguments',
    status => {
      const { voiceMode } = renderOverlay({ status });
      fireEvent.click(screen.getByRole('button', { name: 'Stop the answer and talk' }), {
        detail: 1
      });
      // The hook reads its first argument: the click event must not reach it.
      expect(voiceMode.interrupt).toHaveBeenCalledTimes(1);
      expect(voiceMode.interrupt).toHaveBeenCalledWith();
      expect(overlayRoot()).toHaveFocus();
    }
  );

  test.each([
    [VOICE_STATUS.CONNECTING],
    [VOICE_STATUS.LISTENING],
    [VOICE_STATUS.USER_SPEAKING],
    [VOICE_STATUS.PAUSED]
  ])('is not a button while %s', status => {
    renderOverlay({ status });
    expect(screen.queryByRole('button', { name: /Stop the answer|Voice activity/ })).toBeNull();
    const orb = screen.getByRole('img', { name: 'Voice activity' });
    expect(orb.tagName).toBe('DIV');
    expect(orb).toHaveAttribute('data-status', status);
    expect(orb).not.toHaveAttribute('disabled');
  });

  test('turns into a button and back as the status changes', () => {
    const { update } = renderOverlay({ status: VOICE_STATUS.LISTENING });
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
    const { update } = renderOverlay();
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
    renderOverlay();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('the retry button takes the focus when the error appears', () => {
    const { update } = renderOverlay();
    update(errored());
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry).toHaveFocus();
  });

  test('retrying calls the hook and keeps the focus in the overlay', () => {
    const { update } = renderOverlay();
    const failed = update(errored());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(failed.retry).toHaveBeenCalledTimes(1);
    expect(overlayRoot()).toHaveFocus();
  });

  test('no-speech says that nothing was said, not that something broke', () => {
    renderOverlay(errored('no-speech'));
    const text = screen.getByRole('alert').textContent;
    expect(text).toBe('Voice mode ended because nothing was said for a while.');
  });
});

describe('the notice', () => {
  test('a failed read-aloud is said in a status line of its own', () => {
    renderOverlay({ state: { notice: 'tts-failed' } });
    const notice = screen.getByTestId('voice-mode-notice');
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveTextContent('I could not speak this answer. It is in the chat.');
    expect(notice).not.toHaveClass('sr-only');
    // Not part of the status label or of an error.
    expect(screen.getByTestId('voice-mode-status')).not.toHaveTextContent(/could not speak/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('the line is there, empty and out of the way, until there is a notice', () => {
    const { update } = renderOverlay();
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
    renderOverlay();
    expect(screen.getByTestId('voice-mode-status')).toHaveTextContent(
      'Hold Space or the button to talk'
    );
  });

  test('push-to-talk does not name Space on a touch screen', () => {
    window.matchMedia = jest.fn(query => ({ matches: query === '(pointer: coarse)' }));
    renderOverlay();
    expect(screen.getByTestId('voice-mode-status')).toHaveTextContent('Hold the button to talk');
    expect(screen.getByTestId('voice-mode-status')).not.toHaveTextContent('Space');
  });

  test('hands-free says it is listening on either device', () => {
    window.matchMedia = jest.fn(() => ({ matches: true }));
    renderOverlay({ listeningStyle: 'hands-free' });
    expect(screen.getByTestId('voice-mode-status')).toHaveTextContent('Listening…');
  });

  test('the header and the footer do not both announce "End"', () => {
    renderOverlay();
    expect(screen.getByRole('button', { name: 'End voice mode (Esc)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End' })).toBeInTheDocument();
  });

  test('both end buttons end voice mode', () => {
    const { voiceMode } = renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: 'End voice mode (Esc)' }));
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    expect(voiceMode.end).toHaveBeenCalledTimes(2);
    expect(voiceMode.end).toHaveBeenCalledWith('user');
  });
});

describe('layout that jsdom cannot measure', () => {
  const css = fs.readFileSync(
    path.resolve(__dirname, '../../../client/src/features/voice/components/VoiceMode.css'),
    'utf8'
  );
  const orbRule = css.slice(css.indexOf('.voice-orb {'), css.indexOf("[data-clickable='true']"));

  test('the orb keeps its shape and shrinks with the screen height, not to a sliver', () => {
    expect(orbRule).toMatch(/flex-shrink:\s*0/);
    expect(orbRule).toMatch(/aspect-ratio:\s*1/);
    expect(orbRule).toMatch(/width:\s*min\(9rem,\s*28vh\)/);
    expect(orbRule).not.toMatch(/\bheight:\s*9rem/);
  });

  test('the orb gradient follows the state colour instead of fixed indigo stops', () => {
    expect(orbRule).toContain('color-mix(in srgb, var(--orb-core)');
    expect(orbRule).not.toMatch(/#a5b4fc|#4338ca/i);
  });

  test('the middle of the view scrolls on its own and centres without cutting off the top', () => {
    renderOverlay();
    const middle = screen.getByTestId('voice-mode-status').parentElement.parentElement;
    expect(middle.className).toMatch(/\bmin-h-0\b/);
    expect(middle.className).toMatch(/\boverflow-y-auto\b/);
    expect(screen.getByTestId('voice-mode-status').parentElement.className).toMatch(/\bmy-auto\b/);
    // The header and the controls keep their size.
    expect(overlayRoot().querySelector('header').className).toMatch(/\bshrink-0\b/);
    expect(overlayRoot().querySelector('footer').className).toMatch(/\bshrink-0\b/);
  });
});
