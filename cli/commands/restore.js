/**
 * ihub restore — Restore contents/ from a backup archive
 * Usage: ihub restore <file>
 */
import { existsSync, mkdirSync, createWriteStream } from 'fs';
import path from 'path';
import { c, symbols } from '../utils/colors.js';
import { getContentsDir } from '../utils/paths.js';

const HELP = `
  ${c.bold('ihub restore')} — Restore the contents/ directory from a backup archive

  ${c.bold('Usage:')}
    ihub restore <backup-file> [options]

  ${c.bold('Arguments:')}
    backup-file      Path to the backup .zip file (created with 'ihub backup')

  ${c.bold('Options:')}
    --dest <path>    Destination directory (default: contents/)
    --no-confirm     Skip confirmation prompt
    -h, --help       Show this help

  ${c.bold('Examples:')}
    ihub restore ihub-backup-2026-03-09.zip
    ihub restore ./backups/ihub-backup.zip --dest ./contents-restored
`;

export default async function restore(args) {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(HELP);
    if (args.length === 0) {
      console.error(`${symbols.error} Usage: ihub restore <backup-file>`);
      process.exit(1);
    }
    return;
  }

  const noConfirm = args.includes('--no-confirm');
  const destIdx = args.indexOf('--dest');
  const destDir = destIdx !== -1 ? args[destIdx + 1] : getContentsDir();
  const backupFile = args.filter(a => !a.startsWith('--') && a !== args[destIdx + 1])[0];

  if (!backupFile) {
    console.error(`${symbols.error} No backup file specified.`);
    console.error(`  Usage: ihub restore <backup-file>`);
    process.exit(1);
  }

  const resolvedBackup = path.resolve(backupFile);

  if (!existsSync(resolvedBackup)) {
    console.error(`${symbols.error} Backup file not found: ${resolvedBackup}`);
    process.exit(1);
  }

  if (!resolvedBackup.endsWith('.zip')) {
    console.error(`${symbols.error} Only .zip archives are supported.`);
    process.exit(1);
  }

  if (!noConfirm) {
    let clack;
    try {
      clack = await import('@clack/prompts');
    } catch {}
    if (clack) {
      const { confirm, isCancel, cancel } = clack;
      const proceed = await confirm({
        message: `Restore from ${path.basename(resolvedBackup)}? This will overwrite the contents directory.`,
        initialValue: false
      });
      if (isCancel(proceed) || !proceed) {
        cancel('Restore cancelled.');
        return;
      }
    }
  }

  // Use yauzl for extraction (already in server dependencies)
  let yauzl;
  try {
    yauzl = (await import('yauzl')).default;
  } catch {
    console.error(`${symbols.error} yauzl package not found.`);
    console.error(`  Run: cd server && npm install yauzl`);
    process.exit(1);
  }

  console.log(`${symbols.info} Restoring from backup...`);
  console.log(`  ${c.gray('Source:')} ${resolvedBackup}`);
  console.log(`  ${c.gray('Dest:')}   ${destDir}`);

  let extractedCount = 0;

  await new Promise((resolve, reject) => {
    yauzl.open(resolvedBackup, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);

      zipfile.readEntry();

      zipfile.on('entry', entry => {
        // Strip leading 'contents/' prefix from archived paths
        let entryPath = entry.fileName;
        if (entryPath.startsWith('contents/')) {
          entryPath = entryPath.slice('contents/'.length);
        }

        const fullPath = path.join(destDir, entryPath);

        if (/\/$/.test(entry.fileName)) {
          // Directory entry
          mkdirSync(fullPath, { recursive: true });
          zipfile.readEntry();
          return;
        }

        // Ensure parent directory exists
        mkdirSync(path.dirname(fullPath), { recursive: true });

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) return reject(streamErr);

          const writeStream = createWriteStream(fullPath);
          readStream.pipe(writeStream);

          writeStream.on('close', () => {
            extractedCount++;
            zipfile.readEntry();
          });

          writeStream.on('error', reject);
        });
      });

      zipfile.on('end', resolve);
      zipfile.on('error', reject);
    });
  });

  console.log(`${symbols.success} Restore complete`);
  console.log(`  ${c.gray('Files extracted:')} ${extractedCount}`);
  console.log(`  ${c.gray('Destination:')}    ${destDir}`);
  console.log('');
  console.log(`  Restart the server to apply the restored configuration: ${c.cyan('ihub start')}`);
}
