// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  findPassage,
  splitByPassages
} from '../../../client/src/features/documentPreview/utils/textPreview';

describe('text preview passages', () => {
  const text = '# Lease\n\n## Termination\n\nThe tenant may terminate (with notice).\n';

  it('finds a passage whose whitespace a source collapsed, with offsets into the original', () => {
    // `normalizeSource` turns the heading and its blank line into one space.
    const passage = '## Termination The tenant may terminate (with notice).';
    const range = findPassage(text, passage);
    expect(range).not.toBeNull();
    expect(text.slice(range.start, range.end)).toBe(
      '## Termination\n\nThe tenant may terminate (with notice).'
    );
  });

  it('treats the passage literally, never as a pattern', () => {
    expect(findPassage(text, 'terminate (with')).not.toBeNull();
    expect(findPassage(text, 'T.e tenant')).toBeNull();
    expect(findPassage(text, '   ')).toBeNull();
  });

  it('highlights the matched range and keeps the rest of the text', () => {
    const { segments, matches } = splitByPassages(text, ['## Termination The tenant']);
    expect(matches).toBe(1);
    const marked = segments.filter(segment => segment.match !== null);
    expect(marked).toHaveLength(1);
    expect(marked[0].text).toBe('## Termination\n\nThe tenant');
    expect(segments.map(segment => segment.text).join('')).toBe(text);
  });
});
