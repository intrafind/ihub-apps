// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The inventory of kill points (`server/utils/killPoint.js`).
 *
 * A kill point is test code inside the product. Three things keep it from
 * spreading unseen:
 *
 * 1. Every call site is listed in `server/tests/faults/KILLPOINTS.md`, and
 *    every listed one exists. A kill point that was added without a line in
 *    the list fails here.
 * 2. A call site names its kill point as a plain string, so that the list can
 *    be compared at all.
 * 3. The names of the variables that arm a kill point and the test tools
 *    appear in two server files only: the two modules that read them. No other
 *    code can switch them on, and a search of a build for the names finds
 *    exactly those files.
 * 4. The same two modules are the only server files that ask whether
 *    `NODE_ENV` is `test`. A server started for a test differs from another
 *    one by the kill point and the test tools, and by nothing else.
 *
 * No kill point is placed in the frozen legacy workflow path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { byCodeUnit } from './golden/byCodeUnit.js';
import { FIXTURE_SECTION, SERVER_SECTION, documentedKillPoints } from './faults/killpoints.mjs';
import { KILL_POINT_NAME } from '../utils/killPoint.js';

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

/** Every call `killPoint(…)` in a text: the literal name, or null when it is not a plain string. */
function callsIn(text) {
  return [...text.matchAll(/\bkillPoint\s*\(\s*([^)]*)\)/g)].map(match => {
    const literal = /^(['"])([^'"`$]+)\1$/.exec(match[1].trim());
    return literal ? literal[2] : null;
  });
}

function callSites(files) {
  const sites = [];
  for (const file of files) {
    for (const name of callsIn(code(file))) sites.push({ file: relative(file), name });
  }
  return sites;
}

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
});

test('an undocumented kill point fails the comparison', () => {
  // What the first test would compare had somebody added a call without a row.
  const withNew = [...sitesOf(productionFiles), 'after-tool-start in server/services/x.js'].sort(
    byCodeUnit
  );
  assert.notDeepEqual(withNew, rowsOf(SERVER_SECTION));
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
