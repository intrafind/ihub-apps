/**
 * ihub update — Check for and apply updates
 * Usage: ihub update
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { c, symbols } from '../utils/colors.js';
import { getRootDir } from '../utils/paths.js';

const HELP = `
  ${c.bold('ihub update')} — Check for and apply updates

  ${c.bold('Usage:')}
    ihub update [options]

  ${c.bold('Options:')}
    --check          Check for updates without installing
    -h, --help       Show this help

  ${c.bold('Description:')}
    Checks the npm registry for a newer version of ihub-apps
    and provides instructions for updating.
`;

export default async function update(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const checkOnly = args.includes('--check');
  const rootDir = getRootDir();
  const pkgPath = path.join(rootDir, 'package.json');

  if (!existsSync(pkgPath)) {
    console.error(`${symbols.error} package.json not found at: ${pkgPath}`);
    process.exit(1);
  }

  const { version, name } = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  console.log(`${symbols.info} Current version: ${c.bold(`v${version}`)}`);
  console.log(`${symbols.info} Checking for updates...`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(`https://registry.npmjs.org/${name}/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Registry returned ${res.status}`);
    }

    const data = await res.json();
    const latest = data.version;

    if (latest === version) {
      console.log(`${symbols.success} You are on the latest version (${c.green(`v${version}`)})`);
    } else {
      console.log(`${symbols.warning} Update available: ${c.yellow(`v${version}`)} → ${c.green(`v${latest}`)}`);
      console.log('');

      if (!checkOnly) {
        console.log(`  To update, run one of the following:`);
        console.log('');
        console.log(`  ${c.cyan('npm install -g ihub-apps@latest')}     (if installed globally)`);
        console.log(`  ${c.cyan('npm install ihub-apps@latest')}         (if installed locally)`);
        console.log(`  ${c.cyan('git pull && npm run install:all')}      (if using source)`);
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`${symbols.warning} Update check timed out. Check your internet connection.`);
    } else {
      console.error(`${symbols.warning} Unable to check for updates: ${err.message}`);
    }
  }
}
