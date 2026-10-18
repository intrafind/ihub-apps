/**
 * Read-along (voice mode inline redesign): where the spoken part of the answer
 * ends in the rendered chat message. The speech text is markdown, the message
 * is HTML; the two are matched on their letters and digits.
 */
import {
  countReadable,
  findSpokenAnswer,
  findSpokenBoundary
} from '../../../client/src/features/voice/utils/readAlong';

/** A rendered message body from HTML. */
function body(html) {
  const element = document.createElement('div');
  element.className = 'markdown-content';
  element.innerHTML = html;
  document.body.appendChild(element);
  return element;
}

/** The text from the boundary to the end of the message. */
function rest(root, spoken) {
  const boundary = findSpokenBoundary(root, spoken);
  if (!boundary) return null;
  const range = document.createRange();
  range.setStart(boundary.node, boundary.offset);
  range.setEnd(root, root.childNodes.length);
  return range.toString();
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('countReadable', () => {
  test('counts letters and digits only, in any script', () => {
    expect(countReadable('Hallo, Welt! 42 — Grüße')).toBe(16);
    expect(countReadable('')).toBe(0);
    expect(countReadable(undefined)).toBe(0);
  });

  test("does not count a link's address or a code fence's language", () => {
    expect(countReadable('[the docs](https://example.com/x)')).toBe(countReadable('the docs'));
    expect(countReadable('```js\nconst a\n```')).toBe(countReadable('const a'));
  });
});

describe('findSpokenBoundary', () => {
  test('starts the unspoken part at the first word still to be said, across markup', () => {
    const root = body('<p>It is <strong>sunny</strong> today.</p><ul><li>Tomorrow rain</li></ul>');
    expect(rest(root, 'It is **sunny** today.\n\n- ')).toBe('Tomorrow rain');
    expect(rest(root, 'It is **sun')).toBe('ny today.Tomorrow rain');
  });

  test('with nothing said yet, it is the whole message', () => {
    const root = body('<p>Hello there</p>');
    expect(rest(root, '')).toBe('Hello there');
  });

  test('is null once everything has been said', () => {
    const root = body('<p>Hello there.</p>');
    expect(findSpokenBoundary(root, 'Hello there.')).toBeNull();
  });

  test('skips text that is not read out: buttons, icons, screen-reader text', () => {
    const root = body(
      '<p>One <button>Copy</button><span class="sr-only">hidden</span><span aria-hidden="true">x</span>two three</p>'
    );
    expect(rest(root, 'One two')).toBe('three');
  });

  test('a link reads as its text', () => {
    const root = body('<p>See <a href="https://example.com">the docs</a> for more.</p>');
    expect(rest(root, 'See [the docs](https://example.com) ')).toBe('for more.');
  });
});

describe('findSpokenAnswer', () => {
  test('is the newest assistant message that is shown', () => {
    const scope = document.createElement('div');
    scope.innerHTML = `
      <div data-message-role="assistant" id="old"><div class="markdown-content">old</div></div>
      <div data-message-role="user"><div class="markdown-content">question</div></div>
      <div data-message-role="assistant" id="new"><div class="markdown-content">new</div></div>
      <div data-message-role="assistant" id="hidden"><div class="markdown-content">hidden copy</div></div>`;
    document.body.appendChild(scope);
    for (const element of scope.querySelectorAll('[data-message-role]')) {
      element.getClientRects = () => (element.id === 'hidden' ? [] : [{}]);
    }
    expect(findSpokenAnswer(scope).textContent).toBe('new');
  });

  test('is null without a scope or an answer', () => {
    expect(findSpokenAnswer(null)).toBeNull();
    expect(findSpokenAnswer(document.createElement('div'))).toBeNull();
  });
});
