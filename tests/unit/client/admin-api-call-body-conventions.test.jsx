import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();

function collectSourceFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (entry.isFile() && /\.(js|jsx|ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function extractMakeAdminApiCallOptions(source) {
  const blocks = [];
  const marker = 'makeAdminApiCall(';
  let start = source.indexOf(marker);

  while (start !== -1) {
    let parseIndex = start + marker.length;
    let depth = 1;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let escape = false;
    let commaIndex = -1;

    while (parseIndex < source.length && depth > 0) {
      const ch = source[parseIndex];

      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (!inDouble && !inTemplate && ch === "'") {
        inSingle = !inSingle;
      } else if (!inSingle && !inTemplate && ch === '"') {
        inDouble = !inDouble;
      } else if (!inSingle && !inDouble && ch === '`') {
        inTemplate = !inTemplate;
      } else if (!inSingle && !inDouble && !inTemplate) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (depth === 1 && ch === ',' && commaIndex === -1) {
          commaIndex = parseIndex;
        }
      }

      parseIndex += 1;
    }

    if (commaIndex !== -1) {
      let objectStart = commaIndex + 1;
      while (objectStart < parseIndex && /\s/.test(source[objectStart])) objectStart += 1;
      if (source[objectStart] === '{') {
        let braceDepth = 1;
        let objectEnd = objectStart + 1;
        let localSingle = false;
        let localDouble = false;
        let localTemplate = false;
        let localEscape = false;

        while (objectEnd < parseIndex && braceDepth > 0) {
          const ch = source[objectEnd];

          if (localEscape) {
            localEscape = false;
          } else if (ch === '\\') {
            localEscape = true;
          } else if (!localDouble && !localTemplate && ch === "'") {
            localSingle = !localSingle;
          } else if (!localSingle && !localTemplate && ch === '"') {
            localDouble = !localDouble;
          } else if (!localSingle && !localDouble && ch === '`') {
            localTemplate = !localTemplate;
          } else if (!localSingle && !localDouble && !localTemplate) {
            if (ch === '{') braceDepth += 1;
            if (ch === '}') braceDepth -= 1;
          }

          objectEnd += 1;
        }

        if (braceDepth === 0) {
          blocks.push(source.slice(objectStart, objectEnd));
        }
      }
    }

    start = source.indexOf(marker, start + marker.length);
  }

  return blocks;
}

describe('admin API body conventions', () => {
  test('makeAdminApiCall no longer uses fetch-over-axios or JSON.parse body shim', () => {
    const adminApiPath = path.join(ROOT, 'client/src/api/adminApi.js');
    const source = fs.readFileSync(adminApiPath, 'utf8');

    expect(source).not.toContain('JSON.parse(options.body)');
    expect(source).not.toContain('For FormData requests, use fetch directly');
  });

  test('admin callers do not JSON.stringify makeAdminApiCall bodies', () => {
    const files = collectSourceFiles(path.join(ROOT, 'client/src'));
    const violations = [];

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const blocks = extractMakeAdminApiCallOptions(source);
      if (blocks.some(block => /body\s*:\s*JSON\.stringify/.test(block))) {
        violations.push(path.relative(ROOT, file));
      }
    }

    expect(violations).toEqual([]);
  });

  test('admin callers do not use legacy data option with makeAdminApiCall', () => {
    const files = collectSourceFiles(path.join(ROOT, 'client/src'));
    const violations = [];

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const blocks = extractMakeAdminApiCallOptions(source);
      if (blocks.some(block => /\bdata\s*:/.test(block))) {
        violations.push(path.relative(ROOT, file));
      }
    }

    expect(violations).toEqual([]);
  });
});
