// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps
import { splitUserMessageContent } from '../../../client/src/utils/userMessageContent';

const typed = '# Title\n\n- one\n  - nested\n\n<b>raw</b>';
const badge = '<div style="x">\n  <span>📎</span>\n</div>';

test('splits typed text from attachment markup', () => {
  const r = splitUserMessageContent(`${typed}\n\n${badge}`, typed);
  expect(r.text).toBe(typed);
  expect(r.html.trim()).toBe(badge);
});

test('typed text only yields empty markup', () => {
  expect(splitUserMessageContent(typed, typed)).toEqual({ text: typed, html: '' });
});

test('no raw content or mismatch means no split', () => {
  expect(splitUserMessageContent(`${typed}\n\n${badge}`, undefined)).toBeNull();
  expect(splitUserMessageContent(badge, typed)).toBeNull();
  expect(splitUserMessageContent(`${typed} ${badge}`, '')).toBeNull();
});
