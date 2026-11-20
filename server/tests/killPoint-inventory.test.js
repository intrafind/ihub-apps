// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The inventory of kill points (`server/utils/killPoint.js`).
 *
 * A kill point is test code inside the product. Five things keep it from
 * spreading unseen:
 *
 * 1. Every call site is listed in `server/tests/faults/KILLPOINTS.md`, and
 *    every listed one exists. A kill point that was added without a line in
 *    the list fails here.
 * 2. A call site names its kill point as a plain string, so that the list can
 *    be compared at all.
 * 3. A file gets at the module in one way only, `import { killPoint } from`
 *    (or `killPoint as <name>`, which the search for call sites follows), and
 *    the files that import it are the files of the list. A call through a
 *    default import, a namespace, a dynamic import or a re-export would be a
 *    call this test cannot see, so those are refused.
 * 4. The names of the variables that arm a kill point and the test tools
 *    appear in two server files only: the two modules that read them. No other
 *    code can switch them on, and a search of a build for the names finds
 *    exactly those files.
 * 5. The same two modules are the only server files that ask whether
 *    `NODE_ENV` is `test`. A server started for a test differs from another
 *    one by the kill point and the test tools, and by nothing else.
 *
 * No kill point is placed in the frozen legacy workflow path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { byCodeUnit } from './golden/byCodeUnit.js';
import { FIXTURE_SECTION, SERVER_SECTION, documentedKillPoints } from './faults/killpoints.mjs';
import * as killPointModule from '../utils/killPoint.js';

const { KILL_POINT_NAME } = killPointModule;

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(serverDir, '..');
const relative = file => path.relative(root, file).split(path.sep).join('/');

const KILL_POINT_MODULE = 'server/utils/killPoint.js';
const TEST_TOOLS_MODULE = 'server/services/integrations/protocols/native/connectors/testTools.js';

function sourceFiles(dir, { skip = () => false } = {}) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name === 'node_modules' || skip(relative(full))) continue;
    if (entry.isDirectory()) found.push(...sourceFiles(full, { skip }));
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** Source text without its comments: a comment may talk about a kill point. */
function code(file) {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** The kill point module as the source of an import, whatever the path to it. */
const MODULE_MENTION = /(['"`])[^'"`\n]*\bkillPoint\.js\1/g;
/** `import { … } from '…/killPoint.js'`, also over several lines. */
const NAMED_IMPORT = /\bimport\s*\{([^}]*)\}\s*from\s*(['"])[^'"\n]*\bkillPoint\.js\2/g;

/**
 * How a source text gets at the kill point module.
 *
 * @param {string} text - Source without comments
 * @returns {{imports: boolean, names: string[], refused: string[]}} `names`: what
 *   `killPoint` is called in this text; `refused`: every way of getting at the
 *   module whose calls the search below could not follow
 */
function importsIn(text) {
  const names = [];
  const refused = [];
  const named = [...text.matchAll(NAMED_IMPORT)];
  for (const statement of named) {
    const parts = statement[1]
      .split(',')
      .map(part => part.trim())
      .filter(part => part !== '');
    for (const part of parts) {
      const binding = /^killPoint(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part);
      if (binding) names.push(binding[1] || 'killPoint');
      else refused.push(`imports "${part}"`);
    }
  }
  const mentions = [...text.matchAll(MODULE_MENTION)].length;
  if (mentions > named.length) {
    refused.push('names the module outside an `import { killPoint } from`');
  }
  return { imports: mentions > 0, names, refused };
}

/**
 * Every call of a kill point in a text: the literal name, or null when it is
 * not a plain string.
 *
 * @param {string} text - Source without comments
 * @param {string[]} [names] - What `killPoint` is called in this text
 * @returns {Array<string|null>}
 */
function callsIn(text, names = ['killPoint']) {
  const called = names.map(name => name.replace(/[$]/g, '\\$&')).join('|');
  const call = new RegExp(`(?<![\\w$])(?:${called})\\s*\\(\\s*([^)]*)\\)`, 'g');
  return [...text.matchAll(call)].map(match => {
    const literal = /^(['"])([^'"`$]+)\1$/.exec(match[1].trim());
    return literal ? literal[2] : null;
  });
}

function callSites(files) {
  const sites = [];
  for (const file of files) {
    const text = code(file);
    // A parameter may be named `killPoint` too, so that name always counts.
    const names = [...new Set(['killPoint', ...importsIn(text).names])];
    for (const name of callsIn(text, names)) sites.push({ file: relative(file), name });
  }
  return sites;
}

/** The files that import the kill point module, each once. */
const importersOf = files =>
  files
    .filter(file => importsIn(code(file)).imports)
    .map(file => relative(file))
    .sort(byCodeUnit);

/** Every import of the module that is not `import { killPoint } from`, with its file. */
const refusedImportsOf = files =>
  files.flatMap(file => importsIn(code(file)).refused.map(reason => `${relative(file)} ${reason}`));

const productionFiles = sourceFiles(serverDir, {
  skip: file => file === 'server/tests' || file === KILL_POINT_MODULE
});
const fixtureFiles = sourceFiles(path.join(serverDir, 'tests', 'faults', 'fixtures'));

const rowsOf = section =>
  documentedKillPoints()
    .filter(row => row.section === section)
    .map(row => `${row.name} in ${row.file}`)
    .sort(byCodeUnit);
const sitesOf = files =>
  callSites(files)
    .map(site => `${site.name} in ${site.file}`)
    .sort(byCodeUnit);
/** The files a table names, each once. */
const filesOf = section =>
  [
    ...new Set(
      documentedKillPoints()
        .filter(row => row.section === section)
        .map(row => row.file)
    )
  ].sort(byCodeUnit);

test('every kill point in the server is listed in KILLPOINTS.md, and every listed one exists', () => {
  assert.deepEqual(
    sitesOf(productionFiles),
    rowsOf(SERVER_SECTION),
    'The call sites of killPoint() under server/ (left) and the table "In the server" of ' +
      'server/tests/faults/KILLPOINTS.md (right) differ. Add or remove the row.'
  );
});

test('every kill point of the fixture server is listed, and every listed one exists', () => {
  assert.deepEqual(sitesOf(fixtureFiles), rowsOf(FIXTURE_SECTION));
});

test('the list has no row outside its two tables, no name twice and only well-formed names', () => {
  const rows = documentedKillPoints();
  assert.ok(rows.length > 0, 'the tables were read');
  for (const row of rows) {
    assert.ok(
      [SERVER_SECTION, FIXTURE_SECTION].includes(row.section),
      `${row.name}: ${row.section}`
    );
    assert.match(row.name, KILL_POINT_NAME);
  }
  const names = rows.map(row => row.name);
  assert.deepEqual([...new Set(names)], names);
});

test('a call site names its kill point as a plain string', () => {
  const dynamic = callSites([...productionFiles, ...fixtureFiles]).filter(site => !site.name);
  assert.deepEqual(dynamic, []);
  // The detector itself: what counts as a call, and what is not a plain string.
  assert.deepEqual(callsIn('killPoint(\'a-b\'); killPoint( "c" );'), ['a-b', 'c']);
  assert.deepEqual(callsIn('killPoint(name); killPoint(`after-${step}`);'), [null, null]);
  assert.deepEqual(callsIn('createKillPoint({ env }); xkillPoint("a");'), []);
  assert.deepEqual(callsIn("dieAt('a'); killPoint('b'); other('c');", ['killPoint', 'dieAt']), [
    'a',
    'b'
  ]);
});

test('the files that import the kill point module are the files of the list', () => {
  assert.deepEqual(
    importersOf(productionFiles),
    filesOf(SERVER_SECTION),
    'The server files that import utils/killPoint.js (left) and the files of the table ' +
      '"In the server" of KILLPOINTS.md (right) differ. A file that imports the module ' +
      'has a kill point with a row, or does not import it.'
  );
  assert.deepEqual(importersOf(fixtureFiles), filesOf(FIXTURE_SECTION));
});

test('the module is imported in one way only, and has no other way in', () => {
  assert.deepEqual(refusedImportsOf([...productionFiles, ...fixtureFiles]), []);
  // No default export: `import anyName from` would be a call this test cannot follow.
  assert.deepEqual(Object.keys(killPointModule).sort(byCodeUnit), [
    'KILL_POINT_NAME',
    'createKillPoint',
    'killPoint',
    'parseKillPointSpec'
  ]);
});

test('a kill point without a row fails the comparison, under whatever name it is called', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-killpoint-inventory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourceFile = (name, source) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, source);
    return file;
  };
  const from = "from '../utils/killPoint.js';";

  // Found: the plain name, and a name the import gave it, also over several lines.
  const found = [
    sourceFile('plain.js', `import { killPoint } ${from}\nkillPoint('after-tool-start');\n`),
    sourceFile('alias.js', `import { killPoint as dieAt } ${from}\ndieAt('after-tool-start');\n`),
    sourceFile(
      'lines.js',
      `import {\n  killPoint as dieAt\n} ${from}\n\nexport const run = () => dieAt('after-tool-start');\n`
    )
  ];
  for (const file of found) {
    assert.deepEqual(
      callSites([file]).map(site => site.name),
      ['after-tool-start'],
      path.basename(file)
    );
    assert.deepEqual(refusedImportsOf([file]), [], path.basename(file));
    // The comparisons of the tests above, with this file among the server files.
    assert.throws(
      () => assert.deepEqual(sitesOf([...productionFiles, file]), rowsOf(SERVER_SECTION)),
      assert.AssertionError,
      `${path.basename(file)}: the call sites`
    );
    assert.throws(
      () => assert.deepEqual(importersOf([...productionFiles, file]), filesOf(SERVER_SECTION)),
      assert.AssertionError,
      `${path.basename(file)}: the importing files`
    );
  }

  // Refused: every way whose calls the search cannot follow.
  const refused = {
    'default.js': `import dieAt ${from}\ndieAt('after-tool-start');\n`,
    'namespace.js': `import * as points ${from}\npoints.killPoint('after-tool-start');\n`,
    'dynamic.js': "const points = await import('../utils/killPoint.js');\n",
    'reexport.js': `export { killPoint as dieAt } ${from}\n`,
    'builder.js': `import { createKillPoint } ${from}\ncreateKillPoint()('after-tool-start');\n`,
    'mixed.js': `import dieAt, { killPoint } ${from}\ndieAt('after-tool-start');\n`
  };
  for (const [name, source] of Object.entries(refused)) {
    const file = sourceFile(name, source);
    assert.notDeepEqual(refusedImportsOf([file]), [], name);
    assert.deepEqual(
      importersOf([file]),
      [relative(file)],
      `${name} counts as a file that imports`
    );
  }
});

test('the variables that arm kill points and test tools are named in their two modules only', () => {
  const allProduction = sourceFiles(serverDir, { skip: file => file === 'server/tests' });
  const naming = pattern =>
    allProduction
      .filter(file => pattern.test(fs.readFileSync(file, 'utf8')))
      .map(file => relative(file))
      .sort(byCodeUnit);
  assert.deepEqual(naming(/IHUB_TEST_KILLPOINT/), [KILL_POINT_MODULE]);
  assert.deepEqual(naming(/IHUB_TEST_(?!KILLPOINT)/), [TEST_TOOLS_MODULE]);
  // Client and shared code never name them.
  for (const dir of ['shared', path.join('client', 'src')]) {
    const hits = sourceFiles(path.join(root, dir))
      .filter(file => /IHUB_TEST_/.test(fs.readFileSync(file, 'utf8')))
      .map(file => relative(file));
    assert.deepEqual(hits, [], dir);
  }
});

test('no other server file behaves differently under NODE_ENV=test', () => {
  // The agents browser suite runs its server with NODE_ENV=test to get the test
  // tools (tests/config/agents-server.mjs). That is only right while the value
  // switches on nothing else. Read without comments: a comment may name it.
  const reading = /NODE_ENV[^\n]*['"`]test['"`]|['"`]test['"`][^\n]*NODE_ENV/;
  const files = sourceFiles(serverDir, { skip: file => file === 'server/tests' })
    .filter(file => reading.test(code(file)))
    .map(file => relative(file))
    .sort(byCodeUnit);
  assert.deepEqual(files, [TEST_TOOLS_MODULE, KILL_POINT_MODULE].sort(byCodeUnit));
  // The detector itself.
  assert.ok(reading.test("if (process.env.NODE_ENV === 'test') return;"));
  assert.ok(reading.test("['development', 'test'].includes(config.NODE_ENV)"));
  assert.ok(!reading.test("process.env.NODE_ENV === 'production'"));
});

/**
 * The frozen files, read from the table of `workflow-legacy-frozen.test.js` as text:
 * importing that file would run its tests a second time, in this file.
 */
function frozenFiles() {
  const source = fs.readFileSync(
    path.join(serverDir, 'tests', 'workflow-legacy-frozen.test.js'),
    'utf8'
  );
  return [...source.matchAll(/'(server\/[^']+)':\s*'[0-9a-f]{64}'/g)].map(match => match[1]);
}

test('no kill point is placed in the frozen legacy workflow path', () => {
  const frozen = frozenFiles();
  assert.ok(frozen.includes('server/services/workflow/WorkflowEngine.js'), 'the table was read');
  assert.ok(frozen.length >= 40, `${frozen.length} frozen files read`);
  const inFrozen = callSites(productionFiles).filter(site => frozen.includes(site.file));
  assert.deepEqual(inFrozen, []);
  // The imports too: a frozen file does not even load the module.
  const importing = frozen.filter(file =>
    /utils\/killPoint\.js/.test(fs.readFileSync(path.join(root, file), 'utf8'))
  );
  assert.deepEqual(importing, []);
});
