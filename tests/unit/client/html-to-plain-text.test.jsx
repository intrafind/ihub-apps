// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { htmlToPlainText } from '../../../client/src/utils/htmlText';

/**
 * Plain text of the canvas editor's HTML, for the character count and the
 * replace-confirmation preview. A single-pass `replace(/<[^>]*>/g, '')` left
 * markup behind for nested input such as `<<script>script>`.
 */
describe('htmlToPlainText', () => {
  it('returns the text of ordinary editor HTML', () => {
    expect(htmlToPlainText('<h1>Title</h1><p>One <strong>two</strong> <em>three</em></p>')).toBe(
      'TitleOne two three'
    );
  });

  it('decodes entities instead of counting them as characters', () => {
    expect(htmlToPlainText('<p>Fish &amp; chips &lt;3</p>')).toBe('Fish & chips <3');
  });

  it('keeps a greater-than sign inside an attribute value out of the text', () => {
    expect(htmlToPlainText('<a title="a > b" href="#">link</a>')).toBe('link');
  });

  it('leaves plain text and a lone less-than sign alone', () => {
    expect(htmlToPlainText('1 < 2 and 3 > 2')).toBe('1 < 2 and 3 > 2');
  });

  it.each([
    ['<<script>script>alert(1)<</script>/script>'],
    ['<img src=x onerror=alert(1)>'],
    ['<style>body{background:url(https://evil.example/x)}</style>']
  ])('does not leave a tag or element content in the text of %p', html => {
    const text = htmlToPlainText(html);
    expect(text).not.toMatch(/<script/i);
    expect(text).not.toMatch(/<img/i);
    expect(text).not.toMatch(/alert\(1\)|evil\.example/);
  });

  it('does not run scripts or load resources while parsing', () => {
    window.__htmlTextProbe = false;
    htmlToPlainText(
      '<img src="x" onerror="window.__htmlTextProbe = true"><script>window.__htmlTextProbe = true</script>'
    );
    expect(window.__htmlTextProbe).toBe(false);
    delete window.__htmlTextProbe;
  });

  it.each([[''], [null], [undefined], [42], [{}]])('returns an empty string for %p', value => {
    expect(htmlToPlainText(value)).toBe('');
  });
});
