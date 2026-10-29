// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * CLI Update Command
 * Handles in-place updates from the command line. Run it with the server
 * stopped: `apply`, `install` and `rollback` swap the files immediately, and
 * the next start of the launcher completes (or, if the new version does not
 * start, undoes) the update.
 *
 * Usage:
 *   ./ihub-apps-v{version}-{platform} --update                         # Check GitHub, download and apply the latest release
 *   ./ihub-apps-v{version}-{platform} --update=check                   # Only check for updates
 *   ./ihub-apps-v{version}-{platform} --update=download                # Download and stage, don't apply
 *   ./ihub-apps-v{version}-{platform} --update=stage --file=<archive>   # Verify and stage a local archive (air-gapped)
 *   ./ihub-apps-v{version}-{platform} --update=install --file=<archive> # Stage a local archive and apply it
 *   ./ihub-apps-v{version}-{platform} --update=apply                   # Apply the staged update
 *   ./ihub-apps-v{version}-{platform} --update=status                  # Show the staged update, backups, last result
 *   ./ihub-apps-v{version}-{platform} --update=discard                 # Remove the staged update
 *   ./ihub-apps-v{version}-{platform} --update=rollback [--restore-config]  # Rollback to the previous version
 *   --force                         Skip confirmation prompts (not the typed one for unsigned archives)
 *   --confirm-unsigned=<version>    Install an archive that is not signed by a trusted key
 *                                   (requires update.allowUnsigned in platform.json)
 *   --skip-config-snapshot          Apply even if the configuration snapshot cannot be written
 */
import readline from 'node:readline';
import os from 'node:os';
import {
  checkForUpdate,
  downloadUpdate,
  applyUpdate,
  rollback,
  getUpdateStatus,
  isBinaryInstallation,
  isContainerInstallation,
  checkDiskSpace,
  checkWritePermissions,
  stageLocalFile,
  discardStaged
} from '../services/updateService.js';
import { getAppVersion } from '../utils/versionHelper.js';

// ANSI color codes
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const NC = '\x1b[0m';

function info(msg) {
  console.log(`${BLUE}==>${NC} ${BOLD}${msg}${NC}`);
}
function success(msg) {
  console.log(`${GREEN}OK${NC} ${msg}`);
}
function warn(msg) {
  console.log(`${YELLOW}warning:${NC} ${msg}`);
}
function error(msg) {
  console.error(`${RED}error:${NC} ${msg}`);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    // No terminal or stdin closed (cron, </dev/null): an empty answer, i.e. "no".
    rl.once('close', () => resolve(''));
    rl.question(question, answer => {
      resolve(answer.trim());
      rl.close();
    });
  });
}

async function confirm(question) {
  const answer = (await ask(`${question} [y/N] `)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function option(argv, name) {
  const found = argv.find(a => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : undefined;
}

/**
 * Best effort: record the operation in the audit log like the admin UI does.
 * The CLI has no request, so the actor is the operating-system user.
 */
async function audit(action, resourceId, summary, result = 'success') {
  try {
    const { logAudit, flushAuditLog } = await import('../services/AuditLogService.js');
    let username = 'unknown';
    try {
      username = os.userInfo().username;
    } catch {
      // ignore
    }
    logAudit({
      action,
      resource: 'update',
      resourceId,
      summary: `${summary} (CLI)`,
      result,
      source: 'admin',
      actor: { id: `cli:${username}`, username, groups: [], authenticated: true }
    });
    await flushAuditLog();
  } catch {
    // The audit log is not available without a configured server; the console output stands.
  }
}

async function handleCheck() {
  info('Checking for updates...');
  const result = await checkForUpdate();

  console.log(`\n  Current version: ${BOLD}${result.currentVersion}${NC}`);

  if (result.versionCheckDisabled) {
    warn('Version checks are disabled (NO_VERSION_CHECK is set).');
    warn('To update without network access use --update=install --file=<archive>.');
    console.log('');
    return null;
  }

  if (result.updateAvailable) {
    console.log(`  Latest version:  ${BOLD}${GREEN}${result.latestVersion}${NC}`);
    console.log(`  Release:         ${result.releaseName || result.latestVersion}`);
    if (result.publishedAt) {
      console.log(`  Published:       ${new Date(result.publishedAt).toLocaleDateString()}`);
    }
    if (result.assetUrl) {
      console.log(`  Platform:        ${result.platform}`);
      console.log(`  Archive:         ${result.archiveName}`);
      if (result.assetSize) {
        console.log(`  Download size:   ${(result.assetSize / 1024 / 1024).toFixed(1)} MB`);
      }
    } else {
      warn(`No ${result.archiveName} in the release for platform: ${result.platform}`);
    }
    console.log('');
    return result;
  } else {
    success('You are running the latest version.');
    if (result.error) {
      warn(result.error);
    }
    console.log('');
    return null;
  }
}

async function preflight() {
  if (!(await checkWritePermissions())) {
    error('Cannot write to the installation directory. Run with appropriate permissions.');
    process.exit(1);
  }
  const disk = checkDiskSpace();
  if (!disk.sufficient) {
    error(
      `Insufficient disk space: about ${Math.round(disk.required / 1024 / 1024)} MB are needed.`
    );
    process.exit(1);
  }
}

/** Print a staging summary; returns whether the archive was accepted. */
function printSummary(summary) {
  console.log('');
  console.log(`  Archive:      ${summary.fileName} (${summary.source})`);
  console.log(`  SHA-256:      ${summary.archiveSha256}`);
  console.log(
    `  Version:      ${BOLD}${summary.version || 'unknown'}${NC} (${summary.comparison}, running ${summary.currentVersion})`
  );
  console.log(`  Platform:     ${summary.platform}${summary.arch ? ` / ${summary.arch}` : ''}`);
  const sig = summary.signature;
  console.log(
    `  Signature:    ${sig.status === 'valid' ? `${GREEN}valid${NC} (${sig.via}, key ${sig.keyId})` : `${YELLOW}${sig.status}${NC}`}`
  );
  console.log(`  Checksum:     ${summary.checksum}`);
  console.log(`  Apply mode:   ${summary.applyMode}`);
  for (const w of summary.warnings) warn(w.message);
  for (const p of summary.problems) error(p.message);
  console.log('');
  return summary.accepted;
}

async function handleDownload(updateInfo) {
  if (!updateInfo) {
    updateInfo = await handleCheck();
    if (!updateInfo) {
      return null;
    }
  }
  await preflight();
  info(`Downloading version ${updateInfo.latestVersion}...`);
  const summary = await downloadUpdate(updateInfo);
  const accepted = printSummary(summary);
  await audit(
    'import',
    summary.version || 'github',
    `Staged ${summary.fileName} from GitHub`,
    accepted ? 'success' : 'failure'
  );
  if (!accepted) {
    error('The downloaded archive was rejected; nothing was changed.');
    process.exit(1);
  }
  success(`Version ${summary.version} downloaded, verified and staged.`);
  return summary;
}

async function handleStage(argv) {
  const file = option(argv, 'file');
  if (!file) {
    error('--file=<path to the release archive> is required.');
    process.exit(1);
  }
  await preflight();
  info(`Verifying ${file}...`);
  const summary = await stageLocalFile(file);
  const accepted = printSummary(summary);
  await audit(
    'import',
    summary.version || 'local',
    `Staged ${summary.sourcePath}, sha256 ${summary.archiveSha256}`,
    accepted ? 'success' : 'failure'
  );
  if (!accepted) {
    error('The archive was rejected; nothing was changed.');
    process.exit(1);
  }
  success(`Version ${summary.version} verified and staged.`);
  return summary;
}

async function handleApply(argv, force) {
  const status = getUpdateStatus();
  if (!status.hasStaged || !status.staged) {
    error(
      'No staged update found. Run --update=stage --file=<archive> or --update=download first.'
    );
    process.exit(1);
  }
  const staged = status.staged;

  let confirmDowngrade = false;
  if (staged.requiresConfirmation?.downgrade) {
    warn(`Version ${staged.version} is not newer than the running ${staged.currentVersion}.`);
    confirmDowngrade = force || (await confirm('Install it anyway?'));
    if (!confirmDowngrade) {
      info('Cancelled.');
      process.exit(0);
    }
  }

  let confirmUnsigned = option(argv, 'confirm-unsigned');
  if (staged.requiresConfirmation?.unsigned && !confirmUnsigned) {
    warn('The archive is NOT signed by a trusted key; its origin cannot be verified.');
    confirmUnsigned = await ask(`Type the version (${staged.version}) to install it anyway: `);
  }

  info(`Applying ${staged.version}...`);
  const result = await applyUpdate({
    confirmDowngrade,
    confirmUnsigned,
    skipConfigSnapshot: argv.includes('--skip-config-snapshot'),
    inProcess: true
  });
  await audit(
    'execute',
    result.newVersion,
    `Applied update ${result.previousVersion} → ${result.newVersion}` +
      (result.configSnapshot ? '' : ', NO configuration snapshot')
  );
  success(`Update applied: ${result.previousVersion} -> ${result.newVersion}`);
  info('Start the server to complete the update. If the new version does not start,');
  info('the launcher restores the previous one automatically.');
  return result;
}

async function handleRollback(argv) {
  const status = getUpdateStatus();
  if (!status.hasBackup) {
    error('No backup available for rollback.');
    process.exit(1);
  }
  const restoreConfig = argv.includes('--restore-config');
  info(`Rolling back to version ${status.backupVersion}...`);
  if (restoreConfig) {
    warn(
      'The configuration snapshot taken before the update is restored; later configuration changes are lost.'
    );
  }
  const result = await rollback({ restoreConfig, inProcess: true });
  await audit(
    'execute',
    result.restoredVersion || 'rollback',
    `Rolled back to ${result.restoredVersion}${restoreConfig ? ' and restored the configuration snapshot' : ''}`
  );
  success(`Rolled back to version ${result.restoredVersion}`);
  info('Restart required to complete the rollback.');
  return result;
}

function handleStatus() {
  const status = getUpdateStatus();
  console.log(
    `  Installed version:   ${BOLD}${status.currentVersion}${NC} (${status.platform}/${status.arch})`
  );
  console.log(`  Archive for this server: ${status.archiveNameExample}`);
  console.log(`  Drop-in folder:      ${status.localUpdateDir}`);
  console.log(
    `  Trusted signing keys: ${status.signing.trustedKeys}${status.signing.allowUnsigned ? ' (unsigned archives allowed)' : ''}`
  );
  if (status.staged) {
    console.log(`  Staged:              ${status.staged.version} from ${status.staged.fileName}`);
  } else {
    console.log('  Staged:              none');
  }
  if (status.pendingRestart)
    console.log('  Pending:             an update is applied on the next start');
  console.log(
    `  Backup:              ${status.hasBackup ? `${status.backupVersion}${status.backupHasConfigSnapshot ? ' (with configuration snapshot)' : ''}` : 'none'}`
  );
  if (status.lastResult) {
    console.log(
      `  Last result:         ${status.lastResult.status} (${status.lastResult.previousVersion} -> ${status.lastResult.targetVersion})` +
        (status.lastResult.reason ? `\n                       ${status.lastResult.reason}` : '')
    );
  }
  console.log('');
}

/**
 * Main CLI entry point
 * @param {string} subcommand - The update subcommand (check, download, stage, install, apply,
 *   status, discard, rollback, or empty for a full online update)
 * @param {boolean} force - Skip confirmation prompts
 * @param {string[]} [argv] - The command line, for --file and the other options
 */
export async function runUpdateCLI(subcommand, force = false, argv = process.argv) {
  const currentVersion = getAppVersion();
  console.log(`\n${BOLD}iHub Apps Updater${NC} (current: v${currentVersion})\n`);

  if (isContainerInstallation()) {
    warn('In-place updates are disabled when running in a container.');
    warn('Pull a new container image and restart the container to update.');
    process.exit(1);
  }

  if (!isBinaryInstallation()) {
    warn('In-place updates are only available for binary installations.');
    warn('For development mode, use git pull. For Docker, use docker pull.');
    process.exit(1);
  }

  try {
    switch (subcommand) {
      case 'check': {
        await handleCheck();
        break;
      }

      case 'download': {
        await handleDownload();
        break;
      }

      case 'stage': {
        await handleStage(argv);
        process.exit(0);
        break;
      }

      case 'install': {
        const summary = await handleStage(argv);
        if (!force && !summary.requiresConfirmation?.downgrade) {
          const confirmed = await confirm(`Install ${summary.version} over ${currentVersion}?`);
          if (!confirmed) {
            info('Cancelled. The update stays staged; apply it with --update=apply.');
            process.exit(0);
          }
        }
        await handleApply(argv, force);
        process.exit(0);
        break;
      }

      case 'apply': {
        await handleApply(argv, force);
        // Exit 0 for CLI-invoked apply; the shell launcher wrapper handles restart
        // (exit code 75 is for the server process itself, not the one-shot CLI)
        process.exit(0);
        break;
      }

      case 'status': {
        handleStatus();
        break;
      }

      case 'discard': {
        await discardStaged();
        success('Staged update removed.');
        break;
      }

      case 'rollback': {
        if (!force) {
          const confirmed = await confirm(
            'Are you sure you want to rollback to the previous version?'
          );
          if (!confirmed) {
            info('Rollback cancelled.');
            process.exit(0);
          }
        }
        await handleRollback(argv);
        // Exit 0 for CLI-invoked rollback; same reasoning as apply above
        process.exit(0);
        break;
      }

      default: {
        // Full update: check -> download -> apply
        const updateInfo = await handleCheck();
        if (!updateInfo) {
          process.exit(0);
        }

        if (!force) {
          const confirmed = await confirm(
            `Update from ${currentVersion} to ${updateInfo.latestVersion}?`
          );
          if (!confirmed) {
            info('Update cancelled.');
            process.exit(0);
          }
        }

        await handleDownload(updateInfo);
        await handleApply(argv, force);
        // Exit 0 for CLI full-update; user can re-run the launcher manually
        process.exit(0);
      }
    }
  } catch (err) {
    error(err.message);
    process.exit(1);
  }
}
