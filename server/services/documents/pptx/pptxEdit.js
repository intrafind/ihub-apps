// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { parseStructured } from '../documentToolHelpers.js';
import { GeneratedFileError } from '../generatedFiles.js';

/**
 * Slide operations of `edit_pptx`: replace, update, insert, delete and move
 * slides of a deck's stored `slides`, without the model writing the others
 * again. Slide numbers are 1-based and refer to the deck as the operations
 * before them left it.
 *
 * @module services/documents/pptx/pptxEdit
 */

/** Most slide operations one call may carry. */
export const MAX_SLIDE_CHANGES = 60;

/** Most slides a deck may have (as `create_pptx`). */
const MAX_SLIDES = 60;

const OPS = ['replace', 'update', 'insert', 'delete', 'move'];

function invalid(message) {
  return new GeneratedFileError(message, 'invalid');
}

/** A slide object from an operation. */
function slideOf(value, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${where} must be a slide object, as in create_pptx.`);
  }
  return value;
}

/** A 1-based position that exists in `slides` (or, with `allowEnd`, one past the end). */
function positionOf(value, slides, where, { allowZero = false } = {}) {
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < min || value > slides.length) {
    throw invalid(
      `${where} must be a slide number from ${min} to ${slides.length} (the deck has ${slides.length} slide${slides.length === 1 ? '' : 's'} at this point).`
    );
  }
  return value;
}

/**
 * Apply slide operations to a deck's slides, all or none.
 *
 * @param {Array<Object>} slides - The stored slides; not changed.
 * @param {unknown} value - `changes`, as a list or its JSON.
 * @returns {Array<Object>} The changed copy.
 */
export function applySlideChanges(slides, value) {
  const changes = parseStructured(value, 'changes', 'a list of slide operations');
  if (changes === undefined) return slides;
  if (!Array.isArray(changes)) throw invalid('"changes" must be a list of slide operations.');
  if (changes.length > MAX_SLIDE_CHANGES) {
    throw invalid(`One call can carry at most ${MAX_SLIDE_CHANGES} slide operations.`);
  }
  const deck = structuredClone(slides);
  changes.forEach((change, index) => {
    const where = `changes[${index}]`;
    const op = change?.op;
    if (!OPS.includes(op)) throw invalid(`${where}.op must be one of: ${OPS.join(', ')}.`);
    if (op === 'replace') {
      const at = positionOf(change.slide, deck, `${where}.slide`);
      deck[at - 1] = slideOf(change.with, `${where}.with`);
    } else if (op === 'update') {
      const at = positionOf(change.slide, deck, `${where}.slide`);
      const fields = slideOf(change.set, `${where}.set`);
      const next = { ...deck[at - 1] };
      for (const [key, field] of Object.entries(fields)) {
        if (field === null) delete next[key];
        else next[key] = field;
      }
      deck[at - 1] = next;
    } else if (op === 'insert') {
      const after = positionOf(change.after ?? deck.length, deck, `${where}.after`, {
        allowZero: true
      });
      if (deck.length >= MAX_SLIDES) throw invalid(`A deck has at most ${MAX_SLIDES} slides.`);
      deck.splice(after, 0, slideOf(change.slide, `${where}.slide`));
    } else if (op === 'delete') {
      const at = positionOf(change.slide, deck, `${where}.slide`);
      if (deck.length === 1) throw invalid('A deck keeps at least one slide.');
      deck.splice(at - 1, 1);
    } else {
      const from = positionOf(change.slide, deck, `${where}.slide`);
      const to = positionOf(change.to, deck, `${where}.to`);
      const [moved] = deck.splice(from - 1, 1);
      deck.splice(to - 1, 0, moved);
    }
  });
  return deck;
}
