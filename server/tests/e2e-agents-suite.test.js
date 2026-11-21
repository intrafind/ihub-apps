// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Rules of the agents end-to-end suite (`tests/e2e-agents/`), checked without a
 * browser:
 *
 * - no spec answers an `/api` request itself (`page.route` with `route.fulfill`):
 *   the suite exists to run the real server, and a mocked response would report a
 *   feature as working that nobody ran;
 * - every test carries `@gate`, `@matrix` or `@slow`, so the pull request job and
 *   the full run know what to pick;
 * - the spec map names only specs, paths and features that exist, and the pull
 *   request selection built from it is what `.github/workflows/e2e.yml` relies on;
 * - the overlay a run or a restart applies is laid over the seeded settings.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FEATURE_IDS,
  TAGS,
  changedPaths,
  gateArgs,
  listSpecs,
  mappedSpecs,
  readSpecMap,
  specMapProblems
} from '../../tests/config/agents-run.mjs';
import {
  mergeOverlay,
  parseOverlay,
  readBaseline,
  seedAgentsApps,
  seedAgentsUsers,
  serverEnvironment,
  writeOverlay
} from '../../tests/config/agents-contents.mjs';
import { OTHER, TOOLS_APP, USER } from '../../tests/config/agents-scenario.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUITE_DIR = path.join(root, 'tests', 'e2e-agents');

/** Source text with comments blanked out (strings and template literals kept). */
function withoutComments(source) {
  let out = '';
  let quote = null;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      out += char;
      if (char === '\\') out += source[++i] ?? '';
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
      out += char;
    } else if (char === '/' && next === '/' && source[i - 1] !== '\\') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 1;
      out += ' ';
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * The arguments of the call whose `(` is at `open`: their source texts, split at
 * the top-level commas, and the index after the closing `)`.
 */
function callArguments(source, open) {
  const args = [];
  let depth = 0;
  let quote = null;
  let start = open + 1;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) {
      depth--;
      if (depth === 0) {
        const last = source.slice(start, i).trim();
        if (last) args.push(last);
        return { args, end: i + 1 };
      }
    } else if (char === ',' && depth === 1) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  return { args, end: source.length };
}

/** A string literal's text, or `null` for anything else (a variable, a template with `${}`). */
function literalText(argument) {
  const match = /^(['"`])([\s\S]*)\1$/.exec(argument || '');
  if (!match || (match[1] === '`' && match[2].includes('${'))) return null;
  return match[2];
}

/** The host of a route pattern that starts with a scheme: up to the next `/`. */
const hostOf = pattern => pattern.replace(/^https?:\/\//, '').split('/')[0];

/**
 * Where a source mocks the API: a route that is fulfilled must name another
 * origin, as a string and with its host spelled out, so the rule can be read off
 * the call. A wildcard in the host (`http://**\/*`, `http://*:5591/**`) also
 * matches the suite's own origin.
 *
 * @param {string} source
 * @returns {string[]} Problems; empty when the source mocks nothing of iHub
 */
function apiMockProblems(source) {
  const code = withoutComments(source);
  const problems = [];
  if (/\brouteFromHAR\s*\(/.test(code)) problems.push('routeFromHAR replays recorded responses');
  const covered = [];
  for (const match of code.matchAll(/\.route\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const { args, end } = callArguments(code, open);
    covered.push([open, end]);
    if (!/\.fulfill\s*\(/.test(code.slice(open, end))) continue;
    const pattern = literalText(args[0]);
    if (pattern === null) {
      problems.push(`a fulfilled route needs its URL as a plain string, not ${args[0]}`);
    } else if (
      !/^https?:\/\//.test(pattern) ||
      /\/api|localhost|127\.0\.0\.1/i.test(pattern) ||
      /[*?{[]/.test(hostOf(pattern))
    ) {
      problems.push(`the route ${pattern} answers iHub's own requests`);
    }
  }
  for (const match of code.matchAll(/\.fulfill\s*\(/g)) {
    if (!covered.some(([open, end]) => match.index > open && match.index < end)) {
      problems.push('route.fulfill outside the page.route call that names its URL');
    }
  }
  return problems;
}

/**
 * The tests of a spec that lack a tag: `test('title', { tag: '@gate' }, …)`.
 *
 * @param {string} source
 * @returns {string[]} Problems; empty when every test is tagged
 */
function tagProblems(source) {
  const code = withoutComments(source);
  const problems = [];
  for (const match of code.matchAll(/(?<![.\w])test(\.only)?\s*\(/g)) {
    const { args } = callArguments(code, match.index + match[0].length - 1);
    const title = args[0] || '(no title)';
    if (match[1]) problems.push(`${title}: test.only must not be committed`);
    const details = args.length >= 3 && args[1].startsWith('{') ? args[1] : '';
    const tagValue = /\btag\s*:\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/.exec(details)?.[1] || '';
    const tags = tagValue.match(/@[\w-]+/g) || [];
    if (tags.length === 0) problems.push(`${title}: no tag (${TAGS.join(', ')})`);
    for (const tag of tags) {
      if (!TAGS.includes(tag)) problems.push(`${title}: unknown tag ${tag}`);
    }
  }
  return problems;
}

function suiteFiles(dir = SUITE_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', 'test-results', 'playwright-report'].includes(entry.name)
        ? []
        : suiteFiles(full);
    }
    return /\.(js|mjs|cjs|ts)$/.test(entry.name) ? [full] : [];
  });
}

describe('agents e2e suite: no mocked API', () => {
  test('the rule finds a mocked API response', () => {
    const mocked = [
      `await page.route('**/api/chats', route => route.fulfill({ json: [] }));`,
      `await page.route('**/*', async route => { await route.fulfill({ status: 200 }); });`,
      `await context.route(/\\/api\\/runs/, route => route.fulfill({ body: '{}' }));`,
      `await page.route(url, route => route.fulfill({ json: {} }));`,
      'await page.route(`${BASE_URL}/api/models`, route => route.fulfill({ json: {} }));',
      `await page.route('http://127.0.0.1:5591/**', route => route.fulfill({ json: {} }));`,
      // A wildcard host is every host, the suite's own too.
      `await page.route('http://**/*', route => route.fulfill({ json: {} }));`,
      `await page.route('http://*:5591/**', route => route.fulfill({ json: {} }));`,
      `await page.route('http://**/chats/*', route => route.fulfill({ json: {} }));`,
      `await page.route('https://*.invalid/**', route => route.fulfill({ status: 204 }));`,
      `await page.route('http://{canary.invalid,127.0.0.2}:5591/**', route => route.fulfill({}));`,
      `await page.route('http://[::1]:5591/**', route => route.fulfill({ json: {} }));`,
      `await page.route('https://example.org/api/x', route => route.fulfill({ json: {} }));`,
      `const handler = route => route.fulfill({ json: {} });\nawait page.route('https://example.org/**', handler);`,
      `await page.routeFromHAR('chat.har');`
    ];
    for (const source of mocked) assert.notDeepEqual(apiMockProblems(source), [], source);
  });

  test('the rule allows what is not a mock of iHub', () => {
    const allowed = [
      // Losing or delaying a real response is not answering for the server.
      `await page.route('**/api/apps/chat/chat/*', route => route.abort());`,
      `await page.route('**/api/**', async route => { await wait(); await route.continue(); });`,
      // Another origin, which the suite must never reach for real.
      `await page.route('https://canary.invalid/**', route => route.fulfill({ status: 204 }));`,
      `await page.route('http://canary.invalid:8080/*/hook?*', route => route.fulfill({}));`,
      `// await page.route('**/api/x', route => route.fulfill({}))\nawait page.unroute('**/api/x');`,
      `/* page.route(url, r => r.fulfill()) */ const text = "route.fulfill is not allowed";`
    ];
    for (const source of allowed) assert.deepEqual(apiMockProblems(source), [], source);
  });

  test('no file of tests/e2e-agents mocks the API', () => {
    const files = suiteFiles();
    assert.ok(
      files.some(file => file.endsWith('smoke.spec.js')),
      'the suite was found'
    );
    for (const file of files) {
      assert.deepEqual(
        apiMockProblems(fs.readFileSync(file, 'utf8')),
        [],
        `${path.relative(root, file)} must run against the real server`
      );
    }
  });
});

describe('agents e2e suite: tags', () => {
  test('the rule finds an untagged test', () => {
    assert.deepEqual(tagProblems(`test('a', { tag: '@gate' }, async () => {});`), []);
    assert.deepEqual(
      tagProblems(
        `test(\n  'a, b',\n  { tag: ['@gate', '@matrix'] },\n  async ({ page }) => {}\n);`
      ),
      []
    );
    assert.deepEqual(
      tagProblems(`test.describe('x', () => {}); test.beforeEach(async () => {});`),
      []
    );
    assert.equal(tagProblems(`test('a', async () => {});`).length, 1);
    assert.equal(tagProblems(`test('a', { tag: '@nightly' }, async () => {});`).length, 1);
    assert.equal(tagProblems(`test('a', { annotation: {} }, async () => {});`).length, 1);
    assert.equal(tagProblems(`test.only('a', { tag: '@gate' }, async () => {});`).length, 1);
  });

  test('every test of tests/e2e-agents carries @gate, @matrix or @slow', () => {
    for (const spec of listSpecs(root)) {
      const source = fs.readFileSync(path.join(SUITE_DIR, spec), 'utf8');
      assert.match(withoutComments(source), /(?<![.\w])test\s*\(/, `${spec} has tests`);
      assert.deepEqual(tagProblems(source), [], spec);
    }
  });
});

describe('agents e2e suite: the spec map and the pull request selection', () => {
  const specs = ['a.spec.js', 'agent-chat.spec.js', 'chat.spec.js'];
  const map = {
    specs: [
      { paths: ['tests/config/e2e-llm-stub.mjs', 'tests/e2e-agents/helpers/'], specs: '*' },
      { paths: ['server/services/loop/'], specs: ['chat.spec.js'] }
    ],
    overlays: {}
  };

  test('the shipped map names only specs, paths and overlays that exist', () => {
    const shipped = readSpecMap(root);
    assert.deepEqual(
      specMapProblems(shipped, {
        specs: listSpecs(root),
        pathExists: mapped => fs.existsSync(path.join(root, mapped)),
        featureIds: FEATURE_IDS
      }),
      []
    );
    // The matrix exists for the transport the seeded settings do not use.
    assert.ok(FEATURE_IDS.includes('chatPostStream'), 'the feature registry was read');
    assert.ok(
      Object.values(shipped.overlays).some(overlay => overlay.features?.chatPostStream === true),
      'an overlay turns chatPostStream on'
    );
    // The tooling of the suite itself always runs every spec.
    for (const file of ['tests/config/e2e-llm-stub.mjs', 'tests/config/agents-server.mjs']) {
      assert.deepEqual(mappedSpecs([file], shipped, listSpecs(root)), listSpecs(root), file);
    }
  });

  test('a broken map is reported', () => {
    const problems = specMapProblems(
      {
        specs: [
          { paths: ['gone/'], specs: ['missing.spec.js'] },
          { paths: [], specs: [] }
        ],
        overlays: { 'Bad Name': { users: {} } }
      },
      { specs, pathExists: mapped => mapped !== 'gone/', featureIds: [] }
    );
    assert.equal(problems.length, 6, problems.join('\n'));
    assert.deepEqual(
      specMapProblems({}, { specs, pathExists: () => true, featureIds: [] }).length,
      1
    );
  });

  test('an overlay that sets a feature the server does not have is reported', () => {
    const problemsOf = overlays =>
      specMapProblems(
        { specs: [], overlays },
        { specs, pathExists: () => true, featureIds: ['chatPostStream', 'workflows'] }
      );
    assert.deepEqual(
      problemsOf({
        'chat-post-stream': { features: { chatPostStream: true } },
        both: { features: { chatPostStream: false, workflows: true }, platform: { runs: {} } },
        'platform-only': { platform: { anything: { goes: 1 } } }
      }),
      []
    );
    // A misspelled id would start the server with the seeded transport.
    assert.deepEqual(problemsOf({ misspelled: { features: { chatPoststream: true } } }), [
      'overlays.misspelled: "chatPoststream" is not a feature id of server/featureRegistry.js'
    ]);
    assert.equal(
      problemsOf({ mixed: { features: { chatPostStream: true, gone: true, other: false } } })
        .length,
      2
    );
  });

  test('a change maps to its specs', () => {
    assert.deepEqual(mappedSpecs([], map, specs), []);
    assert.deepEqual(mappedSpecs(['docs/README.md', 'server/server.js'], map, specs), []);
    assert.deepEqual(mappedSpecs(['server/services/loop/AgentLoop.js'], map, specs), [
      'chat.spec.js'
    ]);
    // A path is a file or a directory, never a name prefix.
    assert.deepEqual(mappedSpecs(['server/services/loop-other/x.js'], map, specs), []);
    assert.deepEqual(mappedSpecs(['tests/config/e2e-llm-stub.mjs.bak'], map, specs), []);
    assert.deepEqual(mappedSpecs(['tests/e2e-agents/helpers/stack.mjs'], map, specs), specs);
    // A spec that changed runs, mapped or not.
    assert.deepEqual(mappedSpecs(['tests/e2e-agents/a.spec.js'], map, specs), ['a.spec.js']);
    assert.deepEqual(mappedSpecs(['tests/e2e-agents/removed.spec.js'], map, specs), []);
  });

  test('an unreadable change maps to every spec', () => {
    assert.deepEqual(mappedSpecs(null, map, specs), specs);
  });

  describe('the change read from git', () => {
    let repo;
    const git = (...args) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=E2E',
          '-c',
          'user.email=e2e@example.com',
          '-c',
          'commit.gpgsign=false',
          // The default, pinned: a moved file is then listed under its new path only.
          '-c',
          'diff.renames=true',
          ...args
        ],
        { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
    };
    const source = Array.from({ length: 40 }, (_, line) => `export const v${line} = ${line};`);

    before(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-e2e-agents-git-'));
      git('init', '--quiet', '--initial-branch=main');
      write('server/services/loop/AgentLoop.js', `${source.join('\n')}\n`);
      write('server/services/loop/Budget.js', `${source.join('\n')}\n// budget\n`);
      write('docs/README.md', '# Docs\n');
      git('add', '.');
      git('commit', '--quiet', '-m', 'base');
      git('checkout', '--quiet', '-b', 'change');
    });
    after(() => fs.rmSync(repo, { recursive: true, force: true }));

    test('a file moved out of a mapped directory counts as a change to it', () => {
      fs.mkdirSync(path.join(repo, 'server/services/other'));
      git('mv', 'server/services/loop/AgentLoop.js', 'server/services/other/AgentLoop.js');
      fs.appendFileSync(path.join(repo, 'server/services/other/AgentLoop.js'), '// moved\n');
      git('commit', '--quiet', '-am', 'move');
      // Git itself reports the move as the new path only.
      assert.equal(
        git('diff', '--name-only', 'main', 'HEAD').trim(),
        'server/services/other/AgentLoop.js'
      );

      const changed = changedPaths('main', repo);
      assert.deepEqual([...changed].sort(), [
        'server/services/loop/AgentLoop.js',
        'server/services/other/AgentLoop.js'
      ]);
      assert.deepEqual(mappedSpecs(changed, map, specs), ['chat.spec.js']);
    });

    test('so does a move that is not committed yet, next to new files', () => {
      git('mv', 'server/services/loop/Budget.js', 'docs/Budget.js');
      write('server/new.js', 'export {};\n');
      const changed = changedPaths('HEAD', repo);
      assert.deepEqual([...changed].sort(), [
        'docs/Budget.js',
        'server/new.js',
        'server/services/loop/Budget.js'
      ]);
      assert.deepEqual(mappedSpecs(changed, map, specs), ['chat.spec.js']);
    });

    test('a revision git does not know makes the change unreadable', t => {
      t.mock.method(console, 'error', () => {});
      assert.equal(changedPaths('no-such-branch', repo), null);
    });
  });

  test('the gate selects @gate and the mapped files, never @slow', () => {
    assert.deepEqual(gateArgs([]), ['--grep', '@gate', '--grep-invert', '@slow']);
    const [, grep, , invert] = gateArgs(['chat.spec.js']);
    const selects = title => new RegExp(grep).test(title) && !new RegExp(invert).test(title);
    // Playwright matches against "<project> <file> <titles> <tags>".
    assert.equal(selects(' chromium chat.spec.js Chat sends a message @matrix'), true);
    assert.equal(selects(' chromium other.spec.js Other is quick @gate'), true);
    assert.equal(selects(' chromium other.spec.js Other is matrix only @matrix'), false);
    assert.equal(selects(' chromium agent-chat.spec.js Agent chat opens @matrix'), false);
    assert.equal(selects(' chromium chat.spec.js Chat survives an hour @slow'), false);
    assert.equal(selects(' chromium other.spec.js Other takes long @gate @slow'), false);
  });
});

describe('agents e2e suite: contents', () => {
  const contents = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-e2e-agents-'));
    fs.mkdirSync(path.join(dir, 'config'));
    fs.mkdirSync(path.join(dir, 'apps'));
    const write = (name, value) =>
      fs.writeFileSync(path.join(dir, 'config', `${name}.json`), JSON.stringify(value));
    write('platform', { runs: { a: 1, list: [1, 2] }, auth: { mode: 'local' } });
    write('features', { workflows: false });
    write('users', { users: { user_demo_admin: { id: 'user_demo_admin' } }, metadata: {} });
    return dir;
  };
  const read = (dir, name) =>
    JSON.parse(fs.readFileSync(path.join(dir, 'config', `${name}.json`), 'utf8'));

  test('an overlay merges objects and replaces everything else', () => {
    const base = { runs: { a: 1, b: { c: 2 } }, list: [1, 2], keep: true };
    assert.deepEqual(mergeOverlay(base, { runs: { b: { d: 3 } }, list: [9], off: null }), {
      runs: { a: 1, b: { c: 2, d: 3 } },
      list: [9],
      keep: true,
      off: null
    });
    assert.deepEqual(base, { runs: { a: 1, b: { c: 2 } }, list: [1, 2], keep: true });
    assert.deepEqual(mergeOverlay(base, undefined), base);
  });

  test('an overlay may only change platform.json and features.json', () => {
    assert.deepEqual(parseOverlay(undefined), {});
    assert.deepEqual(parseOverlay(''), {});
    assert.deepEqual(parseOverlay('{"features":{"chatPostStream":true}}'), {
      features: { chatPostStream: true }
    });
    assert.throws(() => parseOverlay({ users: {} }), /not "users"/);
    assert.throws(() => parseOverlay({ platform: true }), /must be a JSON object/);
    assert.throws(() => parseOverlay('[]'), /must be a JSON object/);
    assert.throws(() => parseOverlay('{'), SyntaxError);
  });

  test('each overlay is laid over the seeded settings, not over the last overlay', () => {
    const dir = contents();
    try {
      const baseline = readBaseline(dir);
      writeOverlay(dir, baseline, { platform: { runs: { a: 2 } }, features: { workflows: true } });
      assert.deepEqual(read(dir, 'platform').runs, { a: 2, list: [1, 2] });
      assert.deepEqual(read(dir, 'features'), { workflows: true });

      writeOverlay(dir, baseline, { features: { chatPostStream: true } });
      assert.deepEqual(read(dir, 'platform'), baseline.platform);
      assert.deepEqual(read(dir, 'features'), { workflows: false, chatPostStream: true });

      writeOverlay(dir, baseline, {});
      assert.deepEqual(readBaseline(dir), baseline);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the two regular users and the app with tools are seeded', () => {
    const dir = contents();
    try {
      seedAgentsUsers(dir, { passwordHash: password => `hash(${password})` });
      seedAgentsApps(dir);
      const { users } = read(dir, 'users');
      assert.deepEqual(Object.keys(users), ['user_demo_admin', USER.id, OTHER.id]);
      for (const user of [USER, OTHER]) {
        assert.equal(users[user.id].username, user.username);
        assert.deepEqual(users[user.id].internalGroups, ['users']);
        // Local auth checks `<user id>:<password>`.
        assert.equal(users[user.id].passwordHash, `hash(${user.id}:${user.password})`);
      }
      assert.deepEqual([USER.username, OTHER.username], ['e2e-user', 'e2e-other']);
      const app = JSON.parse(fs.readFileSync(path.join(dir, 'apps', `${TOOLS_APP}.json`), 'utf8'));
      assert.equal(app.preferredModel, 'e2e-stub-tools');
      // iHub's own tools and the counter tools of the suite.
      assert.deepEqual(app.integrations, { ihub: {}, 'e2e-counter': {} });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the server is started as a test server with the test tools and never with a kill point', () => {
    const settings = {
      contentsDir: 'contents-e2e-agents',
      serverPort: 3501,
      counterUrl: 'counter-address'
    };
    const inherited = {
      PATH: '/usr/bin',
      NODE_ENV: 'development',
      JWT_SECRET: 'kept',
      // Left in the shell by a developer who ran a fault test by hand.
      IHUB_TEST_KILLPOINT: 'e2e-counter-after-write',
      IHUB_TEST_KILLPOINT_FILE: 'reached-file',
      IHUB_TEST_TOOLS: '0'
    };
    const env = serverEnvironment(inherited, settings);
    assert.deepEqual(env, {
      PATH: '/usr/bin',
      JWT_SECRET: 'kept',
      NODE_ENV: 'test',
      IHUB_TEST_TOOLS: '1',
      IHUB_TEST_COUNTER_URL: 'counter-address',
      // Set, and empty: a value in a `.env` file cannot arm one either.
      IHUB_TEST_KILLPOINT: '',
      WORKERS: '1',
      CONTENTS_DIR: 'contents-e2e-agents',
      HOST: '127.0.0.1',
      PORT: '3501'
    });
    assert.deepEqual(
      Object.entries(env).filter(([key]) => key.startsWith('IHUB_TEST_KILLPOINT')),
      [['IHUB_TEST_KILLPOINT', '']]
    );
    // The caller's environment is not changed.
    assert.equal(inherited.IHUB_TEST_KILLPOINT, 'e2e-counter-after-write');
  });

  test('agents-server.mjs starts its server with that environment and no other', () => {
    const source = fs.readFileSync(path.join(root, 'tests', 'config', 'agents-server.mjs'), 'utf8');
    assert.match(source, /env: serverEnv\(\)/);
    assert.match(source, /serverEnvironment\(process\.env,/);
    // The Vite client is the only other process it starts.
    assert.equal(source.split('spawn(').length - 1, 2);
  });
});
