#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const docsDir = join(rootDir, 'docs');
const outputDir = join(docsDir, 'book');
const outputFile = join(outputDir, 'iHub-Apps-Documentation.md');

/**
 * Parse SUMMARY.md to get ordered list of markdown files
 */
async function parseSummary() {
  const summaryPath = join(docsDir, 'SUMMARY.md');
  const summaryContent = await readFile(summaryPath, 'utf-8');

  // Extract markdown file paths from links: [Title](path.md)
  const linkRegex = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
  const files = [];
  let match;

  while ((match = linkRegex.exec(summaryContent)) !== null) {
    const title = match[1];
    const path = match[2];
    const fullPath = resolve(docsDir, path);

    if (existsSync(fullPath)) {
      files.push({ title, path, fullPath });
    } else {
      console.warn(`Warning: File not found: ${path}`);
    }
  }

  return files;
}

/**
 * Read and process a markdown file
 */
async function processMarkdownFile(file, index) {
  const content = await readFile(file.fullPath, 'utf-8');

  // Add section separator
  const separator = index === 0 ? '' : '\n\n---\n\n';

  // Add section header with file path reference
  const header = `<!-- Source: ${file.path} -->\n\n`;

  return separator + header + content;
}

/**
 * Generate metadata header
 */
function generateMetadata(version) {
  return `---
title: iHub Apps Documentation
version: ${version}
date: ${new Date().toISOString().split('T')[0]}
author: IntraFind
---

# iHub Apps Documentation

**Complete Documentation Export**

- **Version:** ${version}
- **Generated:** ${new Date().toLocaleString()}
- **Format:** Standalone Markdown

This document contains the complete iHub Apps documentation exported from mdBook.

---

`;
}

/**
 * Main export function
 */
async function exportMarkdown() {
  try {
    console.log('Starting markdown export...');

    // Get version from package.json
    const packageJsonPath = join(rootDir, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
    const version = packageJson.version;

    // Parse SUMMARY.md
    console.log('Parsing SUMMARY.md...');
    const files = await parseSummary();
    console.log(`Found ${files.length} documentation files`);

    // Generate metadata
    let output = generateMetadata(version);

    // Process each file
    console.log('Processing markdown files...');
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`  [${i + 1}/${files.length}] ${file.path}`);
      const processedContent = await processMarkdownFile(file, i);
      output += processedContent;
    }

    // Ensure output directory exists
    await mkdir(outputDir, { recursive: true });

    // Write output
    console.log(`Writing to ${outputFile}...`);
    await writeFile(outputFile, output, 'utf-8');

    // Calculate stats
    const lines = output.split('\n').length;
    const size = Buffer.byteLength(output, 'utf-8');
    const sizeKB = (size / 1024).toFixed(2);

    console.log('\n✅ Markdown export completed successfully!');
    console.log(`   Output: ${outputFile}`);
    console.log(`   Files processed: ${files.length}`);
    console.log(`   Total lines: ${lines}`);
    console.log(`   Size: ${sizeKB} KB`);
  } catch (error) {
    console.error('❌ Error exporting markdown:', error);
    process.exit(1);
  }
}

// Run export
exportMarkdown();
