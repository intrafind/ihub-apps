/**
 * ihub backup — Archive the contents/ directory with a timestamp
 * Usage: ihub backup [output-file]
 */
import { existsSync, mkdirSync, createWriteStream, statSync } from 'fs';
import path from 'path';
import { c, symbols } from '../utils/colors.js';
import { getContentsDir, getRootDir } from '../utils/paths.js';

const HELP = `
  ${c.bold('ihub backup')} — Archive the contents/ directory with a timestamp

  ${c.bold('Usage:')}
    ihub backup [output-file] [options]

  ${c.bold('Arguments:')}
    output-file      Custom output path (default: ./ihub-backup-<timestamp>.zip)

  ${c.bold('Options:')}
    --dir <path>     Directory to backup (default: contents/)
    -h, --help       Show this help

  ${c.bold('Examples:')}
    ihub backup
    ihub backup /backups/ihub-2026-03-09.zip
    ihub restore ihub-backup-2026-03-09.zip
`;

function formatTimestamp() {
  const d = new Date();
  return d.toISOString().replace(/[T:]/g, '-').replace(/\..+/, '');
}

export default async function backup(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const dirIdx = args.indexOf('--dir');
  const sourceDir = dirIdx !== -1 ? args[dirIdx + 1] : getContentsDir();

  const outputArg = args.filter(a => !a.startsWith('--') && a !== args[dirIdx + 1])[0];
  const outputFile = outputArg || path.join(getRootDir(), `ihub-backup-${formatTimestamp()}.zip`);

  if (!existsSync(sourceDir)) {
    console.error(`${symbols.error} Source directory not found: ${sourceDir}`);
    console.error(
      `  Make sure iHub has been started at least once to create the contents directory.`
    );
    process.exit(1);
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputFile);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  let archiver;
  try {
    archiver = (await import('archiver')).default;
  } catch {
    console.error(`${symbols.error} archiver package not found.`);
    console.error(`  Run: npm install archiver`);
    process.exit(1);
  }

  console.log(`${symbols.info} Creating backup...`);
  console.log(`  ${c.gray('Source:')} ${sourceDir}`);
  console.log(`  ${c.gray('Output:')} ${outputFile}`);

  const output = createWriteStream(outputFile);
  const archive = archiver('zip', { zlib: { level: 9 } });

  let fileCount = 0;

  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    archive.on('entry', () => fileCount++);

    archive.pipe(output);
    archive.directory(sourceDir, 'contents');
    archive.finalize();
  });

  const size = statSync(outputFile).size;
  const sizeMB = (size / (1024 * 1024)).toFixed(2);

  console.log(`${symbols.success} Backup created successfully`);
  console.log(`  ${c.gray('Files:')} ${fileCount}`);
  console.log(`  ${c.gray('Size:')}  ${sizeMB} MB`);
  console.log(`  ${c.gray('Path:')}  ${c.cyan(outputFile)}`);
  console.log('');
  console.log(`  Restore with: ${c.cyan(`ihub restore ${outputFile}`)}`);
}
