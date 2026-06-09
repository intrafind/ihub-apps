#!/usr/bin/env node
/**
 * Build the consolidated iHub documentation source file.
 *
 * Concatenates every Markdown file under docs/ into a single document that is
 * shipped as the "ihub-documentation" standard source
 * (server/defaults/sources/ihub-documentation.md). Files are ordered to follow
 * docs/SUMMARY.md; any docs not referenced there are appended afterwards so the
 * source always contains the *full* documentation.
 *
 * Run this whenever documentation changes:
 *   node scripts/build-documentation-source.js
 */
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const docsDir = path.join(rootDir, 'docs');
const outFile = path.join(rootDir, 'server', 'defaults', 'sources', 'ihub-documentation.md');

// Files that are navigation/meta only and should not be inlined as content.
const EXCLUDE = new Set(['SUMMARY.md', 'book.toml']);

/** Extract the ordered list of referenced markdown files from SUMMARY.md. */
async function getSummaryOrder() {
  const summary = await fs.readFile(path.join(docsDir, 'SUMMARY.md'), 'utf8');
  const order = [];
  const linkRe = /\]\(([^)]+\.md)\)/g;
  let match;
  while ((match = linkRe.exec(summary)) !== null) {
    const file = match[1].trim();
    if (!EXCLUDE.has(file) && !order.includes(file)) {
      order.push(file);
    }
  }
  return order;
}

/** Derive a human-readable title from a doc's first H1, falling back to filename. */
function deriveTitle(content, file) {
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return path.basename(file, '.md');
}

async function main() {
  const ordered = await getSummaryOrder();

  // Discover all markdown files so unreferenced ones still get included.
  const allEntries = (await fs.readdir(docsDir)).filter(f => f.endsWith('.md') && !EXCLUDE.has(f));
  const remaining = allEntries.filter(f => !ordered.includes(f)).sort();
  const files = [...ordered, ...remaining];

  const sections = [];
  const toc = [];
  const generatedAt = new Date().toISOString();

  for (const file of files) {
    const filePath = path.join(docsDir, file);
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      // Referenced in SUMMARY but file missing — skip silently.
      continue;
    }
    const title = deriveTitle(content, file);
    const anchor = file.replace(/\.md$/, '').toLowerCase();
    toc.push(`- [${title}](#${anchor})`);
    sections.push(
      `<a id="${anchor}"></a>\n\n` +
        `# ${title}\n\n` +
        `> Source file: \`docs/${file}\`\n\n` +
        `${content.trim()}\n`
    );
  }

  const header =
    `# iHub Apps — Full Documentation\n\n` +
    `This document is an automatically generated, consolidated copy of the complete ` +
    `iHub Apps documentation found under \`docs/\`. It is used as the standard ` +
    `"iHub Documentation" knowledge source so AI apps can answer questions about the ` +
    `platform, its configuration, authentication, features, and operations.\n\n` +
    `Generated: ${generatedAt}\n` +
    `Documents included: ${sections.length}\n\n` +
    `Regenerate with: \`node scripts/build-documentation-source.js\`\n\n` +
    `## Table of Contents\n\n${toc.join('\n')}\n`;

  const body = sections.join('\n---\n\n');
  const output = `${header}\n---\n\n${body}`;

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, output, 'utf8');

  console.log(
    `Wrote ${path.relative(rootDir, outFile)} (${sections.length} docs, ${output.length} bytes)`
  );
}

main().catch(err => {
  console.error('Failed to build documentation source:', err);
  process.exit(1);
});
