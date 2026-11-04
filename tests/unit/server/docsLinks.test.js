/**
 * @jest-environment node
 */

/**
 * Every relative `*.md` link in the shipped documentation and release notes must point to a file
 * that exists: Admin → Documentation and What's New turn them into in-app links, and a dead one
 * lands on "This documentation page does not exist".
 */
import { describe, expect, test } from '@jest/globals';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

const repoDir = process.cwd();
const docsDir = path.resolve(repoDir, 'docs');

// Shipped (numbered) release notes are not edited after the release; a dead link there is listed
// here instead. The viewer shows "page does not exist" for it.
const KNOWN_BROKEN = new Set(['releases/5.5.38/features.md → ../tool-calling.md']);
const SKIP_DIRS = new Set(['book', 'theme', 'assets', 'superpowers', 'node_modules']);

function markdownFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) files.push(...markdownFiles(full));
    } else if (name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

/** Relative `.md` link targets outside fenced code blocks and inline code. */
function relativeMarkdownLinks(markdown) {
  const withoutCode = markdown
    .replace(/^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1/gm, '')
    .replace(/`[^`\n]*`/g, '');
  const links = [];
  for (const match of withoutCode.matchAll(
    /\]\(\s*<?([^)\s>]+?\.md)(#[^)\s>]*)?>?(?:\s+"[^"]*")?\s*\)/g
  )) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue;
    links.push(target);
  }
  return links;
}

describe('documentation links', () => {
  test('every relative .md link resolves to a file in the repository', () => {
    const broken = [];
    for (const file of markdownFiles(docsDir)) {
      for (const target of relativeMarkdownLinks(readFileSync(file, 'utf8'))) {
        let decoded = target;
        try {
          decoded = decodeURI(target);
        } catch {
          // keep as written
        }
        const resolved = path.resolve(path.dirname(file), decoded);
        // Links that leave docs/ open on GitHub, so they must exist in the repository.
        const label = `${path.relative(docsDir, file).split(path.sep).join('/')} → ${target}`;
        if (!resolved.startsWith(repoDir + path.sep) || !existsSync(resolved)) {
          if (!KNOWN_BROKEN.has(label)) broken.push(label);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
