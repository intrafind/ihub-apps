/**
 * ihub doctor — Diagnose configuration, ports, API keys, and connectivity
 * Usage: ihub doctor [--port <port>]
 */
import { existsSync, statfsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import os from 'os';
import { c, symbols } from '../utils/colors.js';
import { checkHealth, isPortAvailable, parseServerArgs } from '../utils/api.js';
import { getRootDir, getContentsDir, getServerDir, getDefaultsDir } from '../utils/paths.js';

const HELP = `
  ${c.bold('ihub doctor')} — Diagnose configuration, ports, API keys, and connectivity

  ${c.bold('Usage:')}
    ihub doctor [options]

  ${c.bold('Options:')}
    --port <port>    Port to check (default: 3000)
    -h, --help       Show this help

  ${c.bold('Checks:')}
    • Node.js version requirement (>=24)
    • Server port availability
    • API keys for configured providers
    • Contents directory and config files
    • Server health (if running)
    • Available disk space
`;

const API_KEY_CHECKS = [
  { name: 'OpenAI', envVars: ['OPENAI_API_KEY'], provider: 'openai' },
  { name: 'Anthropic', envVars: ['ANTHROPIC_API_KEY'], provider: 'anthropic' },
  { name: 'Google Gemini', envVars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'], provider: 'google' },
  { name: 'Mistral', envVars: ['MISTRAL_API_KEY'], provider: 'mistral' },
  { name: 'Azure OpenAI', envVars: ['AZURE_OPENAI_API_KEY'], provider: 'azure-openai' }
];

function pass(label, detail = '') {
  const suffix = detail ? ` ${c.gray('— ' + detail)}` : '';
  console.log(`  ${symbols.success} ${label}${suffix}`);
}

function fail(label, detail = '') {
  const suffix = detail ? ` ${c.gray('— ' + detail)}` : '';
  console.log(`  ${symbols.error} ${label}${suffix}`);
}

function warn(label, detail = '') {
  const suffix = detail ? ` ${c.gray('— ' + detail)}` : '';
  console.log(`  ${symbols.warning} ${label}${suffix}`);
}

function formatBytes(bytes) {
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(1)} GB`;
}

export default async function doctor(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const { port } = parseServerArgs(args);
  const rootDir = getRootDir();
  const contentsDir = getContentsDir();
  const serverDir = getServerDir();
  const defaultsDir = getDefaultsDir();

  let issues = 0;
  let warnings = 0;

  console.log('');
  console.log(`  ${c.bold('iHub Apps — Doctor')}`);
  console.log(`  ${c.gray('─'.repeat(40))}`);
  console.log('');

  // ─── Node.js version ──────────────────────────────────────────────────
  console.log(`  ${c.cyan('System')}`);
  const nodeMajor = parseInt(process.version.slice(1).split('.')[0], 10);
  if (nodeMajor >= 24) {
    pass(`Node.js ${process.version}`);
  } else {
    fail(`Node.js ${process.version}`, `requires >=24.0.0`);
    issues++;
  }

  const platform = `${os.type()} ${os.release()} (${os.arch()})`;
  pass(platform);

  // Disk space
  try {
    const stats = statfsSync(rootDir);
    const freeBytes = stats.bfree * stats.bsize;
    const freeGB = freeBytes / 1024 ** 3;
    if (freeGB < 0.5) {
      fail(`Disk space`, `only ${formatBytes(freeBytes)} free — critically low`);
      issues++;
    } else if (freeGB < 2) {
      warn(`Disk space`, `${formatBytes(freeBytes)} free — consider freeing space`);
      warnings++;
    } else {
      pass(`Disk space`, `${formatBytes(freeBytes)} available`);
    }
  } catch {
    warn('Disk space', 'unable to check');
    warnings++;
  }

  console.log('');

  // ─── Server ───────────────────────────────────────────────────────────
  console.log(`  ${c.cyan('Server')}`);

  if (existsSync(path.join(serverDir, 'server.js'))) {
    pass('Server files found', rootDir);
  } else {
    fail('Server files not found', `expected at ${serverDir}`);
    issues++;
  }

  const portFree = await isPortAvailable(port);
  if (portFree) {
    pass(`Port ${port} available`);
  } else {
    // Check if it's our own server
    const health = await checkHealth(port);
    if (health) {
      pass(`Port ${port} in use`, `iHub server is running`);
    } else {
      warn(`Port ${port} in use`, `another process is using this port`);
      warnings++;
    }
  }

  const health = await checkHealth(port);
  if (health) {
    pass(`Server responding on port ${port}`, `uptime: ${Math.floor((health.uptime || 0) / 60)}m`);
  } else if (!portFree) {
    // Already handled above
  } else {
    pass('Server not running', 'start with: ihub start');
  }

  console.log('');

  // ─── Configuration ────────────────────────────────────────────────────
  console.log(`  ${c.cyan('Configuration')}`);

  if (existsSync(defaultsDir)) {
    pass('Default config templates found');
  } else {
    fail('Default config templates missing', `expected at ${defaultsDir}`);
    issues++;
  }

  if (existsSync(contentsDir)) {
    pass('Contents directory found', contentsDir);

    const configFiles = ['config/platform.json', 'config/groups.json', 'config/ui.json'];
    for (const f of configFiles) {
      const fp = path.join(contentsDir, f);
      if (existsSync(fp)) {
        try {
          JSON.parse(readFileSync(fp, 'utf-8'));
          pass(`Config: ${f}`);
        } catch (e) {
          fail(`Config: ${f}`, `invalid JSON: ${e.message}`);
          issues++;
        }
      } else {
        warn(`Config: ${f}`, 'not found — will use defaults');
        warnings++;
      }
    }
  } else {
    warn('Contents directory not found', `run 'ihub start' to create it`);
    warnings++;
  }

  console.log('');

  // ─── API Keys ─────────────────────────────────────────────────────────
  console.log(`  ${c.cyan('API Keys')}`);

  let anyKeyFound = false;
  for (const check of API_KEY_CHECKS) {
    const foundVar = check.envVars.find(v => process.env[v]);
    if (foundVar) {
      const masked = process.env[foundVar].slice(0, 4) + '••••';
      pass(`${check.name} API key configured`, `${foundVar}=${masked}`);
      anyKeyFound = true;
    } else {
      // Check if configured in models
      const modelsDir = existsSync(contentsDir)
        ? path.join(contentsDir, 'models')
        : path.join(defaultsDir, 'models');

      if (existsSync(modelsDir)) {
        const modelFiles = readdirSync(modelsDir).filter(f => f.endsWith('.json'));
        const hasProvider = modelFiles.some(f => {
          try {
            const m = JSON.parse(readFileSync(path.join(modelsDir, f), 'utf-8'));
            return (
              m.provider === check.provider ||
              (m.provider === 'openai' && check.provider === 'openai')
            );
          } catch {
            return false;
          }
        });
        if (hasProvider) {
          warn(`${check.name} API key not set`, `set via ${check.envVars[0]} or admin UI`);
          warnings++;
        }
      }
    }
  }

  if (!anyKeyFound) {
    warn('No API keys configured', `add keys via admin UI or environment variables`);
    warnings++;
  }

  console.log('');

  // ─── Summary ──────────────────────────────────────────────────────────
  console.log(`  ${c.gray('─'.repeat(40))}`);
  if (issues === 0 && warnings === 0) {
    console.log(`  ${symbols.success} ${c.green('All checks passed!')}`);
  } else {
    if (issues > 0) {
      console.log(`  ${symbols.error} ${c.red(`${issues} issue${issues > 1 ? 's' : ''} found`)}`);
    }
    if (warnings > 0) {
      console.log(
        `  ${symbols.warning} ${c.yellow(`${warnings} warning${warnings > 1 ? 's' : ''}`)}`
      );
    }
    if (issues > 0) {
      console.log('');
      console.log(`  Fix the issues above and run ${c.cyan('ihub doctor')} again.`);
    }
  }
  console.log('');

  if (issues > 0) process.exit(1);
}
