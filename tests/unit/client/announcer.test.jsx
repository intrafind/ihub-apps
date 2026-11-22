// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect } from 'react';
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  ANNOUNCER_MAX_QUEUE,
  AnnouncerProvider,
  useAnnounce
} from '../../../client/src/shared/announce/AnnouncerProvider';

/**
 * The page's one polite live region (#3191, #3782): everything a page says to a
 * screen reader goes through `useAnnounce`, so two producers never cut each
 * other off and nobody adds a second region.
 */

/** Says `text` once when mounted; `onReady` gets the announce function. */
function Speaker({ text, onReady }) {
  const announce = useAnnounce();
  useEffect(() => {
    if (text) announce(text);
    onReady?.(announce);
  }, [announce, text, onReady]);
  return null;
}

const region = () => screen.getByRole('status');

describe('AnnouncerProvider', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    jest.advanceTimersByTime(10_000);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('is one polite, atomic, visually hidden status region, there and empty from the start', () => {
    render(
      <AnnouncerProvider>
        <p>page</p>
      </AnnouncerProvider>
    );
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(region()).toHaveAttribute('aria-live', 'polite');
    expect(region()).toHaveAttribute('aria-atomic', 'true');
    expect(region().className).toMatch(/\bsr-only\b/);
    expect(region()).toBeEmptyDOMElement();
  });

  test('says a text, and empties the region again after 5 s', () => {
    render(
      <AnnouncerProvider>
        <Speaker text="Message removed" />
      </AnnouncerProvider>
    );
    expect(region()).toHaveTextContent('Message removed');
    act(() => {
      jest.advanceTimersByTime(4900);
    });
    expect(region()).toHaveTextContent('Message removed');
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(region()).toBeEmptyDOMElement();
  });

  test('puts two texts from two parts of the page at least 1.5 s apart, in order', () => {
    let say;
    render(
      <AnnouncerProvider>
        <Speaker onReady={fn => (say = fn)} />
      </AnnouncerProvider>
    );
    act(() => {
      say('First');
      say('Second');
    });
    expect(region()).toHaveTextContent('First');
    act(() => {
      jest.advanceTimersByTime(1400);
    });
    expect(region()).toHaveTextContent('First');
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(region()).toHaveTextContent('Second');
  });

  test('says an identical text again by emptying the region first', () => {
    let say;
    render(
      <AnnouncerProvider>
        <Speaker onReady={fn => (say = fn)} />
      </AnnouncerProvider>
    );
    act(() => say('Approval needed: Add comment'));
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    act(() => say('Approval needed: Add comment'));
    expect(region()).toBeEmptyDOMElement();
    act(() => {
      jest.advanceTimersByTime(60);
    });
    expect(region()).toHaveTextContent('Approval needed: Add comment');
  });

  test(`keeps at most ${ANNOUNCER_MAX_QUEUE} waiting texts, dropping the oldest`, () => {
    let say;
    render(
      <AnnouncerProvider>
        <Speaker onReady={fn => (say = fn)} />
      </AnnouncerProvider>
    );
    act(() => {
      say('now');
      for (let i = 1; i <= ANNOUNCER_MAX_QUEUE + 2; i += 1) say(`waiting ${i}`);
    });
    const heard = [];
    for (let i = 0; i < ANNOUNCER_MAX_QUEUE + 2; i += 1) {
      act(() => {
        jest.advanceTimersByTime(1600);
      });
      const text = region().textContent;
      if (text && heard.at(-1) !== text) heard.push(text);
    }
    expect(heard).toEqual(
      Array.from({ length: ANNOUNCER_MAX_QUEUE }, (_, i) => `waiting ${i + 3}`)
    );
  });

  test('the same text from two copies of a part is said once; later it is said again', () => {
    let say;
    render(
      <AnnouncerProvider>
        <Speaker onReady={fn => (say = fn)} />
      </AnnouncerProvider>
    );
    // Two copies of the chat list (narrow and wide screen) say the same at once.
    act(() => {
      say('Creating web artifact');
      say('Creating web artifact');
      say('Other');
      say('Other');
    });
    const heard = [];
    for (let i = 0; i < 4; i += 1) {
      const text = screen.getByRole('status').textContent;
      if (text && heard.at(-1) !== text) heard.push(text);
      act(() => {
        jest.advanceTimersByTime(1600);
      });
    }
    expect(heard).toEqual(['Creating web artifact', 'Other']);
    // Well after, the same words are news again.
    act(() => {
      jest.advanceTimersByTime(2000);
      say('Creating web artifact');
    });
    act(() => {
      jest.advanceTimersByTime(60);
    });
    expect(region()).toHaveTextContent('Creating web artifact');
  });

  test('ignores an empty text', () => {
    let say;
    render(
      <AnnouncerProvider>
        <Speaker onReady={fn => (say = fn)} />
      </AnnouncerProvider>
    );
    act(() => {
      say('   ');
      say(undefined);
    });
    expect(region()).toBeEmptyDOMElement();
  });

  test('a provider inside another adds no second region', () => {
    render(
      <AnnouncerProvider>
        <AnnouncerProvider>
          <Speaker text="Inner" />
        </AnnouncerProvider>
      </AnnouncerProvider>
    );
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(region()).toHaveTextContent('Inner');
  });

  test('outside a provider useAnnounce says nothing and does not throw', () => {
    expect(() => render(<Speaker text="Nobody hears this" />)).not.toThrow();
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('stops its timers when it goes away', () => {
    let say;
    const { unmount } = render(
      <AnnouncerProvider>
        <Speaker onReady={fn => (say = fn)} />
      </AnnouncerProvider>
    );
    act(() => {
      say('one');
      say('two');
    });
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});
