/**
 * ihub logs — Stream server logs
 * Usage: ihub logs [options]
 */
import { existsSync, createReadStream, statSync } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import { c, symbols } from '../utils/colors.js';
import { getRootDir } from '../utils/paths.js';

const HELP = `
  ${c.bold('ihub logs')} — Stream server logs

  ${c.bold('Usage:')}
    ihub logs [options]

  ${c.bold('Options:')}
    --level <level>  Filter by log level: error, warn, info, debug (default: all)
    --since <time>   Show logs since: 1h, 30m, 1d (default: last 100 lines)
    --lines <n>      Number of lines to show initially (default: 100)
    --no-follow      Show existing logs and exit (don't follow)
    -h, --help       Show this help

  ${c.bold('Log levels:')}
    error  Critical errors only
    warn   Warnings and errors
    info   Informational messages (default server output)
    debug  All messages including debug
`;

const LOG_COLORS = {
  error: c.red,
  warn: c.yellow,
  info: c.white,
  debug: c.gray,
  http: c.cyan
};

function colorizeLog(line, levelFilter) {
  // Try to parse JSON log lines (Winston format)
  try {
    const obj = JSON.parse(line);
    const level = obj.level?.toLowerCase() || 'info';

    if (levelFilter && !isLevelMatch(level, levelFilter)) return null;

    const timestamp = obj.timestamp
      ? c.gray(new Date(obj.timestamp).toLocaleTimeString())
      : c.gray(new Date().toLocaleTimeString());
    const levelStr = level.toUpperCase().padEnd(5);
    const colorFn = LOG_COLORS[level] || c.white;
    const message = obj.message || line;

    return `${timestamp} ${colorFn(levelStr)} ${message}`;
  } catch {
    // Plain text log line
    if (levelFilter) {
      const lower = line.toLowerCase();
      if (!lower.includes(`[${levelFilter}]`) && !lower.includes(` ${levelFilter}:`)) {
        // Heuristic level detection
        if (levelFilter === 'error' && !lower.includes('error')) return null;
        if (levelFilter === 'warn' && !lower.includes('warn') && !lower.includes('error')) return null;
      }
    }
    return line;
  }
}

function isLevelMatch(level, filter) {
  const levels = { debug: 0, info: 1, http: 2, warn: 3, error: 4 };
  const filterLevel = levels[filter] ?? 0;
  const logLevel = levels[level] ?? 1;
  return logLevel >= filterLevel;
}

function parseLines(num) {
  const n = parseInt(num, 10);
  return isNaN(n) ? 100 : Math.max(1, n);
}

async function readLastNLines(filePath, n) {
  const stats = statSync(filePath);
  const fileSize = stats.size;

  if (fileSize === 0) return [];

  // Read from end of file
  const chunkSize = Math.min(fileSize, n * 200); // rough estimate
  const stream = createReadStream(filePath, {
    start: Math.max(0, fileSize - chunkSize),
    end: fileSize
  });

  const lines = [];
  const rl = createInterface({ input: stream });

  await new Promise(resolve => {
    rl.on('line', line => lines.push(line));
    rl.on('close', resolve);
  });

  return lines.slice(-n);
}

export default async function logs(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const levelIdx = args.indexOf('--level');
  const levelFilter = levelIdx !== -1 ? args[levelIdx + 1] : null;
  const linesIdx = args.indexOf('--lines');
  const initialLines = linesIdx !== -1 ? parseLines(args[linesIdx + 1]) : 100;
  const noFollow = args.includes('--no-follow');

  // Find the log file
  const rootDir = getRootDir();
  const candidateLogFiles = [
    path.join(rootDir, 'server.log'),
    path.join(rootDir, 'logs', 'server.log'),
    path.join(rootDir, 'data', 'server.log'),
    path.join(rootDir, 'server', 'server.log')
  ];

  let logFile = candidateLogFiles.find(f => existsSync(f));

  if (!logFile) {
    console.error(`${symbols.error} No log file found.`);
    console.error(
      `  Looked in:\n${candidateLogFiles.map(f => `    ${f}`).join('\n')}`
    );
    console.error(`\n  Make sure the server is running with logging enabled.`);
    process.exit(1);
  }

  console.log(`${symbols.info} Reading logs from: ${c.gray(logFile)}`);
  if (levelFilter) console.log(`${symbols.info} Filtering: level >= ${c.cyan(levelFilter)}`);
  console.log(c.gray('─'.repeat(60)));

  // Show initial lines
  try {
    const lastLines = await readLastNLines(logFile, initialLines);
    for (const line of lastLines) {
      if (!line.trim()) continue;
      const colored = colorizeLog(line, levelFilter);
      if (colored !== null) console.log(colored);
    }
  } catch (err) {
    console.error(`${symbols.error} Error reading log file: ${err.message}`);
    process.exit(1);
  }

  if (noFollow) return;

  // Follow mode: watch for new content
  console.log(c.gray(`--- Following logs (Ctrl+C to stop) ---`));

  let fileSize = statSync(logFile).size;
  let buffer = '';

  const interval = setInterval(async () => {
    try {
      const newSize = statSync(logFile).size;
      if (newSize <= fileSize) {
        // File rotated or truncated
        if (newSize < fileSize) {
          fileSize = 0;
          buffer = '';
        }
        return;
      }

      const stream = createReadStream(logFile, { start: fileSize, end: newSize });
      fileSize = newSize;

      stream.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const colored = colorizeLog(line, levelFilter);
          if (colored !== null) console.log(colored);
        }
      });
    } catch {}
  }, 500);

  process.on('SIGINT', () => {
    clearInterval(interval);
    process.exit(0);
  });

  // Keep process alive
  await new Promise(resolve => process.on('exit', resolve));
}
