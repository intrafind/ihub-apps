/**
 * Read-along for voice mode: the part of the answer that has been spoken stays
 * as it is in the chat message, the part still to come is muted, so the reader
 * can follow the voice in the real (rendered) message.
 *
 * `spokenChars` counts characters of the speech text: the message's markdown
 * source without its citation markers (`toSpokenText`). The message on screen is
 * rendered HTML. The two agree on their letters and digits, not on their
 * markup, spaces or punctuation, so the boundary is found by counting letters
 * and digits in both.
 *
 * The mark is a CSS Custom Highlight (`::highlight(voice-unspoken)`): it does
 * not touch the DOM React renders. A browser without the API shows no mark.
 */

export const READ_ALONG_HIGHLIGHT = 'voice-unspoken';

const COUNTED = /[\p{L}\p{N}]/gu;

/** Text on the page that is not part of what is read out. */
const SKIPPED = 'button, svg, script, style, .sr-only, [aria-hidden="true"]';

/** Markdown in the speech text that renders as no letters at all. */
function stripMarkup(markdown) {
  return (
    markdown
      // A link or image shows its text, not its address.
      .replace(/\]\([^)]*\)/g, ']')
      // A code fence's language name is not shown.
      .replace(/```[^\n]*/g, '')
  );
}

/** The number of letters and digits in `text`. */
export function countReadable(text) {
  if (typeof text !== 'string' || !text) return 0;
  return stripMarkup(text).match(COUNTED)?.length ?? 0;
}

/**
 * Where the spoken part ends in a rendered message: the text node and the
 * offset of the first letter or digit still to be said (with nothing said yet,
 * the first one of the message). Null when there is none: it has all been
 * said, or the message is not the one being read out.
 *
 * @param {Node} root - The rendered message body.
 * @param {string} spokenText - The speech text said so far.
 * @returns {{ node: Text, offset: number }|null}
 */
export function findSpokenBoundary(root, spokenText) {
  if (!root) return null;
  const target = countReadable(spokenText);
  const doc = root.ownerDocument || document;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
    acceptNode: node =>
      node.parentElement?.closest(SKIPPED) ? 2 /* FILTER_REJECT */ : 1 /* FILTER_ACCEPT */
  });
  let seen = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue || '';
    if (seen === target) {
      // Everything said: the boundary sits before the next readable character.
      COUNTED.lastIndex = 0;
      const next = COUNTED.exec(text);
      if (next) return { node, offset: next.index };
      continue;
    }
    COUNTED.lastIndex = 0;
    let match = null;
    while ((match = COUNTED.exec(text))) {
      seen += 1;
      if (seen === target) {
        // The rest of this node may still have readable text: start there.
        const end = match.index + match[0].length;
        const rest = text.slice(end);
        COUNTED.lastIndex = 0;
        const next = COUNTED.exec(rest);
        if (next) return { node, offset: end + next.index };
        break;
      }
    }
  }
  return null;
}

/**
 * The rendered body of the answer that is being read out: the newest
 * assistant message of the transcript the user can see (the phone and the
 * desktop layout each mount one; the hidden one has no boxes).
 *
 * @param {ParentNode|null} scope
 * @returns {HTMLElement|null}
 */
export function findSpokenAnswer(scope) {
  if (!scope) return null;
  const messages = [...scope.querySelectorAll('[data-message-role="assistant"]')].filter(
    element => element.getClientRects().length > 0
  );
  const latest = messages[messages.length - 1];
  return latest?.querySelector('.markdown-content') || null;
}
