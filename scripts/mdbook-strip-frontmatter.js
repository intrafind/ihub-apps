#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * mdBook preprocessor that removes the YAML front-matter of every chapter (see
 * shared/docsFrontMatter.js), so `docs:build` does not render it as text. Registered in
 * docs/book.toml.
 *
 * Protocol: mdBook first runs `<command> supports <renderer>` (exit 0: supported), then passes
 * `[context, book]` as JSON on stdin and reads the processed book as JSON from stdout.
 */
import { splitDocsFrontMatter } from '../shared/docsFrontMatter.js';

if (process.argv[2] === 'supports') process.exit(0);

/** Strip front-matter from every chapter, whatever the book's JSON layout of this mdBook version. */
function strip(value) {
  if (Array.isArray(value)) {
    value.forEach(strip);
  } else if (value && typeof value === 'object') {
    if (typeof value.content === 'string' && Array.isArray(value.sub_items)) {
      value.content = splitDocsFrontMatter(value.content).body;
    }
    Object.values(value).forEach(strip);
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
});
process.stdin.on('end', () => {
  const [, book] = JSON.parse(input);
  strip(book);
  process.stdout.write(JSON.stringify(book));
});
