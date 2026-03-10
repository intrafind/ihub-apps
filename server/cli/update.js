/**
 * CLI Update Command
 * Handles in-place updates from the command line.
 *
 * Usage:
 *   ./ihub-apps-v{version}-{platform} --update           # Check and apply latest update
 *   ./ihub-apps-v{version}-{platform} --update=check     # Only check for updates
 *   ./ihub-apps-v{version}-{platform} --update=download  # Download but don't apply
 *   ./ihub-apps-v{version}-{platform} --update=apply     # Apply a previously downloaded update
 *   ./ihub-apps-v{version}-{platform} --update=rollback  # Rollback to previous version
 *   --force                                               # Skip confirmation prompt
 */
import readline from 'readline';
import {
  checkForUpdate,
  downloadUpdate,
  applyUpdate,
  rollback,
  getUpdateStatus,
  isBinaryInstallation,
  checkDiskSpace,
  checkWritePermissions
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

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${question} [y/N] `, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function handleCheck() {
  info('Checking for updates...');
  const result = await checkForUpdate();

  console.log(`\n  Current version: ${BOLD}${result.currentVersion}${NC}`);

  if (result.updateAvailable) {
    console.log(`  Latest version:  ${BOLD}${GREEN}${result.latestVersion}${NC}`);
    console.log(`  Release:         ${result.releaseName || result.latestVersion}`);
    if (result.publishedAt) {
      console.log(`  Published:       ${new Date(result.publishedAt).toLocaleDateString()}`);
    }
    if (result.assetUrl) {
      console.log(`  Platform:        ${result.platform}`);
      if (result.assetSize) {
        console.log(`  Download size:   ${(result.assetSize / 1024 / 1024).toFixed(1)} MB`);
      }
    } else {
      warn(`No binary available for platform: ${result.platform}`);
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

async function handleDownload(updateInfo) {
  if (!updateInfo) {
    updateInfo = await handleCheck();
    if (!updateInfo) {
      return false;
    }
  }

  // Pre-flight checks
  const hasPermissions = await checkWritePermissions();
  if (!hasPermissions) {
    error('Cannot write to the installation directory. Run with appropriate permissions.');
    process.exit(1);
  }

  const diskSpace = await checkDiskSpace();
  if (!diskSpace.sufficient) {
    error('Insufficient disk space. At least 500MB is required for the update.');
    process.exit(1);
  }

  info(`Downloading version ${updateInfo.latestVersion}...`);
  await downloadUpdate(updateInfo);
  success(`Version ${updateInfo.latestVersion} downloaded and staged.`);
  return true;
}

async function handleApply() {
  const status = getUpdateStatus();
  if (!status.hasStaged) {
    error('No staged update found. Run --update=download first.');
    process.exit(1);
  }

  info('Applying staged update...');
  const result = await applyUpdate();
  success(`Update applied: ${result.previousVersion} -> ${result.newVersion}`);
  info('Restart required to complete the update.');
  return result;
}

async function handleRollback() {
  const status = getUpdateStatus();
  if (!status.hasBackup) {
    error('No backup available for rollback.');
    process.exit(1);
  }

  info(`Rolling back to version ${status.backupVersion}...`);
  const result = await rollback();
  success(`Rolled back to version ${result.restoredVersion}`);
  info('Restart required to complete the rollback.');
  return result;
}

/**
 * Main CLI entry point
 * @param {string} subcommand - The update subcommand (check, download, apply, rollback, or empty for full update)
 * @param {boolean} force - Skip confirmation prompts
 */
export async function runUpdateCLI(subcommand, force = false) {
  const currentVersion = getAppVersion();
  console.log(`\n${BOLD}iHub Apps Updater${NC} (current: v${currentVersion})\n`);

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

      case 'apply': {
        await handleApply();
        // Exit 0 for CLI-invoked apply; the shell launcher wrapper handles restart
        // (exit code 75 is for the server process itself, not the one-shot CLI)
        process.exit(0);
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
        await handleRollback();
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
        await handleApply();
        // Exit 0 for CLI full-update; user can re-run the launcher manually
        process.exit(0);
      }
    }
  } catch (err) {
    error(err.message);
    process.exit(1);
  }
}
