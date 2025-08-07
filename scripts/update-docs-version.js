#!/usr/bin/env node

import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

async function updateDocsVersion() {
  try {
    // Read package.json to get the current version
    const packageJsonPath = join(rootDir, 'package.json');
    const packageJsonContent = await readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);
    const version = packageJson.version;

    console.log(`Updating documentation version to: ${version}`);

    // Update docs/README.md
    const docsReadmePath = join(rootDir, 'docs', 'README.md');
    let docsReadmeContent = await readFile(docsReadmePath, 'utf-8');

    // Replace version line
    docsReadmeContent = docsReadmeContent.replace(/\*\*Version:.*?\*\*/, `**Version: ${version}**`);

    await writeFile(docsReadmePath, docsReadmeContent, 'utf-8');

    // Update theme/head.hbs if it exists
    const themeHeadPath = join(rootDir, 'docs', 'theme', 'head.hbs');
    try {
      let themeHeadContent = await readFile(themeHeadPath, 'utf-8');

      // Replace version meta tag
      themeHeadContent = themeHeadContent.replace(
        /<meta name="version" content=".*?">/,
        `<meta name="version" content="${version}">`
      );

      await writeFile(themeHeadPath, themeHeadContent, 'utf-8');
      console.log('Theme head.hbs version updated!');
    } catch (error) {
      console.log('Theme head.hbs not found, skipping');
    }

    console.log('Documentation version updated successfully!');
  } catch (error) {
    console.error('Error updating documentation version:', error);
    process.exit(1);
  }
}

updateDocsVersion();
