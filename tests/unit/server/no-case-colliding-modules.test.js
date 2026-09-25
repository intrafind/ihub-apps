/**
 * Two source files whose paths differ only in case (`McpAppViews.jsx` next to
 * `mcpAppViews.js`) resolve to the same module on macOS and Windows, so an
 * import picks whichever extension the resolver tries first — green on Linux
 * CI, broken on every developer machine. Catch the collision instead of the
 * import that trips over it.
 */
import { execFileSync } from 'child_process';
import path from 'path';

test('no two source files differ only in case', () => {
  const files = execFileSync('git', ['ls-files', '-z'], {
    cwd: path.resolve(__dirname, '../../..'),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
    .split('\0')
    .filter(f => /\.(js|jsx|mjs|cjs|json)$/.test(f));

  const byLowerCase = new Map();
  for (const file of files) {
    // An import writes no extension, so `a/Foo.jsx` and `a/foo.js` collide too.
    const key = file.toLowerCase().replace(/\.(js|jsx|mjs|cjs)$/, '');
    if (!byLowerCase.has(key)) byLowerCase.set(key, []);
    byLowerCase.get(key).push(file);
  }

  const collisions = [...byLowerCase.values()].filter(group => group.length > 1);
  expect(collisions).toEqual([]);
});
