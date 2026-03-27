/**
 * Minimal ANSI color utilities for CLI output
 */

const isColorEnabled = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const codes = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
  magenta: '\x1b[35m'
};

function colorize(code, text) {
  if (!isColorEnabled) return text;
  return `${codes[code]}${text}${codes.reset}`;
}

export const c = {
  bold: text => colorize('bold', text),
  dim: text => colorize('dim', text),
  green: text => colorize('green', text),
  red: text => colorize('red', text),
  yellow: text => colorize('yellow', text),
  blue: text => colorize('blue', text),
  cyan: text => colorize('cyan', text),
  gray: text => colorize('gray', text),
  white: text => colorize('white', text),
  magenta: text => colorize('magenta', text)
};

export const symbols = {
  success: isColorEnabled ? '\x1b[32m✓\x1b[0m' : '✓',
  error: isColorEnabled ? '\x1b[31m✗\x1b[0m' : '✗',
  warning: isColorEnabled ? '\x1b[33m⚠\x1b[0m' : '⚠',
  info: isColorEnabled ? '\x1b[34mℹ\x1b[0m' : 'ℹ',
  arrow: isColorEnabled ? '\x1b[36m→\x1b[0m' : '→',
  bullet: isColorEnabled ? '\x1b[90m•\x1b[0m' : '•'
};
