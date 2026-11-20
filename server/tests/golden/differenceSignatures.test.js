// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `scripts/check-difference-signatures.js`: a signature in the difference list
 * stands only with the approving review of the list's owner.
 *
 * The second half runs the script in a scratch repository, with the reviews
 * read from a file instead of the GitHub API: a branch that adds `signedBy`
 * fails without the owner's approval and passes with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CODEOWNERS_PATH,
  DIFFERENCES_PATH,
  GOLDENS_PATH,
  evaluate,
  latestReviews,
  ownersOf,
  rowsOf,
  signatureChanges
} from '../../../scripts/check-difference-signatures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/check-difference-signatures.js');

const proposed = (id = 'tool-error-text', extra = {}) => ({
  id,
  title: 'The text of a tool error names the tool',
  state: 'proposed',
  decision: 'Accepted.',
  goldens: ['chat/one-tool.json'],
  parts: ['envelopes'],
  pr: 'tool-runner',
  signedBy: null,
  signedOn: null,
  ...extra
});
const signed = (id, extra = {}) =>
  proposed(id, { state: 'signed', signedBy: 'Intradmin', signedOn: '2026-11-20', ...extra });
const review = (login, state, commit, at) => ({
  user: { login },
  state,
  commit_id: commit,
  submitted_at: at
});

test('the owner of the difference list is read from CODEOWNERS; the last matching line wins', () => {
  const text = [
    '# owners',
    '* @everyone',
    `/${DIFFERENCES_PATH} @Someone   # replaced below`,
    'docs/ @writer',
    `/${DIFFERENCES_PATH} @Intradmin @Deputy`
  ].join('\n');
  assert.deepEqual(ownersOf(text, DIFFERENCES_PATH), ['intradmin', 'deputy']);
  assert.deepEqual(ownersOf('docs/ @writer', DIFFERENCES_PATH), []);
  assert.deepEqual(ownersOf(null, DIFFERENCES_PATH), []);
  assert.deepEqual(ownersOf('* @everyone', DIFFERENCES_PATH), ['everyone']);
  // A directory above the file matches; any other pattern is not understood and matches nothing.
  assert.deepEqual(ownersOf('/server/tests/golden/ @Dir', DIFFERENCES_PATH), ['dir']);
  assert.deepEqual(ownersOf('server/tests/ @Dir', DIFFERENCES_PATH), ['dir']);
  assert.deepEqual(ownersOf('/server/tests/gold @Dir', DIFFERENCES_PATH), []);
  assert.deepEqual(
    ownersOf('*.json @Glob\n/server/**/differences.json @Glob', DIFFERENCES_PATH),
    []
  );
});

test('the CODEOWNERS file of this repository names both owners of the difference list', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, CODEOWNERS_PATH), 'utf8');
  assert.deepEqual(ownersOf(text, DIFFERENCES_PATH), ['manzked', 'intradmin']);
  // Whoever could edit the check or this file could appoint another signer.
  assert.deepEqual(ownersOf(text, 'scripts/check-difference-signatures.js'), [
    'manzked',
    'intradmin'
  ]);
  assert.deepEqual(ownersOf(text, CODEOWNERS_PATH), ['manzked', 'intradmin']);
  // The job runs the pull request's own copy of the workflow and of the difference list test:
  // whoever could edit those could switch the gate off, so they have the same owner.
  for (const file of [
    '.github/workflows/e2e.yml',
    'server/tests/golden/differenceList.js',
    'server/tests/golden/differenceList.test.js'
  ]) {
    assert.deepEqual(ownersOf(text, file), ['manzked', 'intradmin'], `${file} has the owner`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, file)), `${file} exists`);
  }
  // The goldens themselves have no owner: a row, not a review of every file, accepts a change.
  assert.deepEqual(ownersOf(text, `${GOLDENS_PATH}/harness/chat-turn-plain.json`), []);
});

test('the job that runs the check is in the workflow the owner owns', () => {
  const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/e2e.yml'), 'utf8');
  assert.match(workflow, /run: node scripts\/check-difference-signatures\.js\n/);
  assert.match(workflow, /run: node --test server\/tests\/golden\/differenceList\.test\.js\n/);
  assert.match(workflow, /GOLDEN_REQUIRE_BASE: '1'/);
});

test('rowsOf refuses a list whose rows cannot be told apart', () => {
  const list = rows => JSON.stringify({ rows });
  assert.deepEqual(rowsOf(null), []);
  assert.deepEqual(rowsOf(''), []);
  assert.equal(rowsOf(list([proposed('a'), signed('b')])).length, 2);
  // A signed row and an unsigned one with the same id: the map by id would keep only the last.
  assert.throws(
    () => rowsOf(list([signed('x'), proposed('x')])),
    /differences\.json of the pull request: the id "x" is used twice \(row 2\)/
  );
  const { id: _id, ...withoutId } = signed('x');
  assert.throws(() => rowsOf(list([withoutId, proposed('y')])), /row 1 has no id/);
  assert.throws(() => rowsOf(list([proposed('y'), { ...withoutId, id: ' ' }])), /row 2 has no id/);
  assert.throws(() => rowsOf(list([proposed('y'), { ...withoutId, id: 7 }])), /row 2 has no id/);
  assert.throws(() => rowsOf(list([null])), /row 1 is not an object/);
  assert.throws(() => rowsOf(list([['x']])), /row 1 is not an object/);
  assert.throws(() => rowsOf('{"rows": {}}', 'the target branch'), /of the target branch must be/);
  assert.throws(() => rowsOf('{'), /is not JSON/);
});

test('signatureChanges: added, changed, removed; an unsigned row can change freely', () => {
  assert.deepEqual(signatureChanges([], [proposed('a')]), []);
  assert.deepEqual(signatureChanges([proposed('a')], [proposed('a', { title: 'reworded' })]), []);
  assert.deepEqual(signatureChanges([proposed('a')], [signed('a')]), [
    { id: 'a', change: 'added', signedBy: 'Intradmin' }
  ]);
  assert.deepEqual(signatureChanges([], [signed('new')]), [
    { id: 'new', change: 'added', signedBy: 'Intradmin' }
  ]);
  assert.deepEqual(signatureChanges([signed('a')], [signed('a')]), []);
  assert.deepEqual(signatureChanges([signed('a')], [signed('a', { signedBy: 'Other' })]), [
    { id: 'a', change: 'changed', signedBy: 'Other' }
  ]);
  // The text under a signature changed: the signer never saw it.
  assert.deepEqual(signatureChanges([signed('a')], [signed('a', { decision: 'Wider.' })]), [
    { id: 'a', change: 'changed', signedBy: 'Intradmin' }
  ]);
  assert.deepEqual(signatureChanges([signed('a')], [proposed('a')]), [
    { id: 'a', change: 'removed', signedBy: 'Intradmin' }
  ]);
  assert.deepEqual(signatureChanges([signed('a')], []), [
    { id: 'a', change: 'removed', signedBy: 'Intradmin' }
  ]);
  // Half a signature is a signature.
  assert.equal(signatureChanges([], [proposed('a', { signedBy: 'Intradmin' })]).length, 1);
});

test('latestReviews keeps the last deciding review of each person', () => {
  const latest = latestReviews([
    review('Intradmin', 'APPROVED', 'c1', '2026-11-20T10:00:00Z'),
    review('Intradmin', 'COMMENTED', 'c2', '2026-11-20T12:00:00Z'),
    review('Other', 'CHANGES_REQUESTED', 'c1', '2026-11-20T09:00:00Z'),
    review('Other', 'APPROVED', 'c2', '2026-11-20T11:00:00Z')
  ]);
  assert.equal(latest.get('intradmin').commit_id, 'c1', 'a later comment does not replace it');
  assert.equal(latest.get('other').state, 'APPROVED');
});

test('evaluate: the rules of a valid signature', () => {
  const owners = ['intradmin'];
  const added = [{ id: 'a', change: 'added', signedBy: 'Intradmin' }];
  const unchanged = () => null;
  const verdict = (overrides = {}) =>
    evaluate({ changes: added, owners, reviews: [], changedSince: unchanged, ...overrides });

  assert.equal(verdict({ changes: [] }).ok, true, 'nothing to sign needs no review');
  assert.match(verdict().problems.join('\n'), /intradmin: no review/);
  assert.equal(
    verdict({ reviews: [review('Somebody', 'APPROVED', 'c1', '1')] }).ok,
    false,
    'the approval of someone else is not the owner’s'
  );
  const approved = [review('Intradmin', 'APPROVED', 'c1', '1')];
  assert.deepEqual(verdict({ reviews: approved }), {
    ok: true,
    problems: [],
    approvedBy: 'intradmin'
  });
  const stale = verdict({
    reviews: approved,
    changedSince: commit => `something changed after ${commit}`
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.approvedBy, null);
  assert.match(stale.problems.join('\n'), /intradmin: approved c1, but something changed after c1/);
  assert.match(
    verdict({
      reviews: [...approved, review('Intradmin', 'CHANGES_REQUESTED', 'c2', '2')]
    }).problems.join('\n'),
    /latest review is CHANGES_REQUESTED/
  );
  assert.match(
    verdict({ reviews: [review('Intradmin', 'DISMISSED', 'c1', '1')] }).problems.join('\n'),
    /latest review is DISMISSED/
  );
  // Signed in someone else's name, or in the author's own: not an owner.
  assert.match(
    verdict({
      changes: [{ id: 'a', change: 'added', signedBy: 'agent' }],
      reviews: approved
    }).problems.join('\n'),
    /signed by "agent", who is not an owner/
  );
  assert.match(verdict({ owners: [] }).problems.join('\n'), /names no person as owner/);
  assert.match(verdict({ owners: ['org/team'] }).problems.join('\n'), /names no person as owner/);
  // Removing a signature needs the owner as well, but names no signer.
  assert.equal(
    verdict({ changes: [{ id: 'a', change: 'removed', signedBy: 'Intradmin' }], reviews: approved })
      .ok,
    true
  );
});

/** A scratch repository: `main` has the list with a proposed row, `sign` is the pull request. */
function scratchRepository(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-golden-signatures-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  const write = (file, value) => {
    const absolute = path.join(dir, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(
      absolute,
      typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`
    );
  };
  const commit = message => {
    git('add', '.');
    git('commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write(CODEOWNERS_PATH, `/${DIFFERENCES_PATH} @Intradmin\n`);
  write(DIFFERENCES_PATH, { rows: [proposed('tool-error-text')] });
  commit('the difference list');
  git('checkout', '--quiet', '-b', 'sign');
  const run = (reviews, ...args) => {
    const reviewsFile = path.join(dir, '..', `${path.basename(dir)}-reviews.json`);
    fs.writeFileSync(reviewsFile, JSON.stringify(reviews));
    t.after(() => fs.rmSync(reviewsFile, { force: true }));
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--base', 'main', '--reviews', reviewsFile, ...args],
      { cwd: dir, encoding: 'utf8' }
    );
    return { status: result.status, output: result.stdout + result.stderr };
  };
  return { dir, git, write, commit, run };
}

test('scratch branch: a pull request without a signature passes without any review', t => {
  const repo = scratchRepository(t);
  repo.write(DIFFERENCES_PATH, { rows: [proposed('tool-error-text'), proposed('second')] });
  repo.commit('propose a second row');
  const { status, output } = repo.run([]);
  assert.equal(status, 0, output);
  assert.match(output, /touches no signature/);
});

test('scratch branch: a signedBy added without the owner’s approval fails the check', t => {
  const repo = scratchRepository(t);
  repo.write(DIFFERENCES_PATH, { rows: [signed('tool-error-text')] });
  const head = repo.commit('sign the row');

  const none = repo.run([]);
  assert.equal(none.status, 1, none.output);
  assert.match(none.output, /row "tool-error-text": signature added/);
  assert.match(none.output, /no owner of the difference list has approved it/);

  const someoneElse = repo.run([review('colleague', 'APPROVED', head, '2026-11-20T10:00:00Z')]);
  assert.equal(someoneElse.status, 1, someoneElse.output);

  const owner = repo.run([review('Intradmin', 'APPROVED', head, '2026-11-20T10:00:00Z')]);
  assert.equal(owner.status, 0, owner.output);
  assert.match(owner.output, /approved by intradmin/);
});

test('scratch branch: an approval does not cover a signature pushed after it', t => {
  const repo = scratchRepository(t);
  repo.write('README.md', 'unrelated\n');
  const approvedCommit = repo.commit('something else');
  repo.write(DIFFERENCES_PATH, { rows: [signed('tool-error-text')] });
  const head = repo.commit('sign the row after the approval');
  const approval = [review('Intradmin', 'APPROVED', approvedCommit, '2026-11-20T10:00:00Z')];

  const early = repo.run(approval);
  assert.equal(early.status, 1, early.output);
  assert.match(
    early.output,
    /approved [0-9a-f]{12}, but the difference list changed after that commit/
  );

  // A later commit that leaves the list alone keeps the approval valid.
  const again = [review('Intradmin', 'APPROVED', head, '2026-11-20T11:00:00Z')];
  repo.write('README.md', 'unrelated, again\n');
  repo.commit('something else again');
  assert.equal(repo.run(again).status, 0);
  // An id that is no commit of this repository approves nothing.
  const unknown = repo.run([review('Intradmin', 'APPROVED', 'f'.repeat(40), '1')]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.output, /that commit is not part of this pull request any more/);
  assert.equal(repo.run([review('Intradmin', 'APPROVED', '--all', '1')]).status, 1);
});

test('scratch branch: an approval does not cover a golden recorded again after it', t => {
  const repo = scratchRepository(t);
  const golden = `${GOLDENS_PATH}/chat/one-tool.json`;
  const record = (systemPromptHash, toolSchema = 'v2') => ({
    case: 'one-tool',
    modelRequests: [{ roles: ['system', 'user'], systemPromptHash, tools: [toolSchema] }],
    envelopes: []
  });
  // The golden exists on the target branch.
  repo.git('checkout', '--quiet', 'main');
  repo.write(golden, record('hash-1', 'v1'));
  repo.commit('the golden');
  repo.git('checkout', '--quiet', '-b', 'refactor');

  // C1: a harmless change of the tool schema, with its row, signed. The owner approves C1.
  repo.write(golden, record('hash-1'));
  repo.write(DIFFERENCES_PATH, {
    rows: [signed('tool-error-text', { goldens: ['chat/one-tool.json'], parts: ['modelRequests'] })]
  });
  const reviewed = repo.commit('change the tool schema, sign the row');
  const approval = [review('Intradmin', 'APPROVED', reviewed, '2026-11-20T10:00:00Z')];
  const atReview = repo.run(approval);
  assert.equal(atReview.status, 0, atReview.output);

  // C2: the same golden is recorded again with another system prompt, under the same part.
  // The difference list is untouched, so the row still names the golden and the part.
  repo.write(golden, record('hash-2'));
  const head = repo.commit('record the golden again');
  assert.equal(
    repo.git('diff', '--name-only', reviewed, head),
    golden,
    'only the golden changed after the approval'
  );
  const after = repo.run(approval);
  assert.equal(after.status, 1, after.output);
  assert.match(after.output, /row "tool-error-text": signature added/);
  assert.match(
    after.output,
    /approved [0-9a-f]{12}, but the goldens \(server\/tests\/golden\/__goldens__\) changed after that commit/
  );

  // A golden that is added or deleted after the approval is not what the owner saw either.
  repo.write(golden, record('hash-1'));
  repo.write(`${GOLDENS_PATH}/chat/renamed.json`, record('hash-2'));
  repo.commit('restore the golden, record the change under a new name');
  assert.equal(repo.run(approval).status, 1);

  // The owner approves the head commit: the signature stands again, and keeps standing while
  // neither the list nor a golden changes.
  const headNow = repo.git('rev-parse', 'HEAD');
  const again = [...approval, review('Intradmin', 'APPROVED', headNow, '2026-11-20T12:00:00Z')];
  assert.equal(repo.run(again).status, 0);
  repo.write('README.md', 'unrelated\n');
  repo.commit('something else');
  assert.equal(repo.run(again).status, 0);
});

test('scratch branch: a signed row hidden behind a second row with its id stops the check', t => {
  const repo = scratchRepository(t);
  repo.write(DIFFERENCES_PATH, { rows: [signed('tool-schema'), proposed('tool-schema')] });
  repo.commit('a signed and a proposed row with one id');
  const twice = repo.run([]);
  assert.equal(twice.status, 2, twice.output);
  assert.match(twice.output, /the id "tool-schema" is used twice \(row 2\)/);
  assert.doesNotMatch(twice.output, /touches no signature/);

  const { id: _id, ...withoutId } = signed('x');
  repo.write(DIFFERENCES_PATH, { rows: [withoutId, { ...proposed('y'), id: undefined }] });
  repo.commit('two rows without an id');
  const noId = repo.run([]);
  assert.equal(noId.status, 2, noId.output);
  assert.match(noId.output, /of the pull request: row 1 has no id/);
  assert.doesNotMatch(noId.output, /touches no signature/);
});

test('scratch branch: a pull request cannot appoint its own signer', t => {
  const repo = scratchRepository(t);
  repo.write(CODEOWNERS_PATH, `/${DIFFERENCES_PATH} @agent\n`);
  repo.write(DIFFERENCES_PATH, {
    rows: [signed('tool-error-text', { signedBy: 'agent' })]
  });
  const head = repo.commit('name another owner and sign as that owner');
  const { status, output } = repo.run([review('agent', 'APPROVED', head, '2026-11-20T10:00:00Z')]);
  assert.equal(status, 1, output);
  assert.match(
    output,
    /signed by "agent", who is not an owner of the difference list \(intradmin\)/
  );
});

test('scratch branch: the pull request that introduces the list uses the owner it adds', t => {
  const repo = scratchRepository(t);
  // A target branch without CODEOWNERS and without a list.
  repo.git('checkout', '--quiet', '--orphan', 'bare-main');
  repo.git('rm', '--quiet', '-rf', '.');
  repo.write('README.md', 'nothing yet\n');
  repo.commit('a repository without the list');
  repo.git('checkout', '--quiet', '-b', 'introduce');
  repo.write(CODEOWNERS_PATH, `/${DIFFERENCES_PATH} @Intradmin\n`);
  repo.write(DIFFERENCES_PATH, { rows: [signed('first')] });
  const head = repo.commit('introduce the list, signed');
  const reviewsFile = path.join(repo.dir, '..', `${path.basename(repo.dir)}-intro.json`);
  t.after(() => fs.rmSync(reviewsFile, { force: true }));
  const run = reviews => {
    fs.writeFileSync(reviewsFile, JSON.stringify(reviews));
    return spawnSync(process.execPath, [SCRIPT, '--base', 'bare-main', '--reviews', reviewsFile], {
      cwd: repo.dir,
      encoding: 'utf8'
    });
  };
  assert.equal(run([]).status, 1);
  const approved = run([review('Intradmin', 'APPROVED', head, '2026-11-20T10:00:00Z')]);
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  assert.match(approved.stdout, /using the owner this pull request adds/);
});

test('scratch branch: a list without an owner on the target branch cannot be signed by naming one', t => {
  const repo = scratchRepository(t);
  // The target branch has the list, and a CODEOWNERS file that names nobody for it.
  repo.git('checkout', '--quiet', 'main');
  repo.write(CODEOWNERS_PATH, 'docs/ @writer\n');
  repo.commit('the owner line is gone');
  repo.git('checkout', '--quiet', '-b', 'self-appointed');
  repo.write(CODEOWNERS_PATH, `/${DIFFERENCES_PATH} @agent\n`);
  repo.write(DIFFERENCES_PATH, { rows: [signed('tool-error-text', { signedBy: 'agent' })] });
  const head = repo.commit('name an owner and sign as that owner');
  const { status, output } = repo.run([review('agent', 'APPROVED', head, '2026-11-20T10:00:00Z')]);
  assert.equal(status, 1, output);
  assert.match(output, /names no person as owner/);
});

test('the check says so when it cannot run', t => {
  const repo = scratchRepository(t);
  const noBase = spawnSync(process.execPath, [SCRIPT, '--base', 'no-such-branch'], {
    cwd: repo.dir,
    encoding: 'utf8'
  });
  assert.equal(noBase.status, 2);
  assert.match(noBase.stderr, /No common commit/);
  repo.write(DIFFERENCES_PATH, { rows: [signed('tool-error-text')] });
  repo.commit('sign');
  const noReviews = spawnSync(process.execPath, [SCRIPT, '--base', 'main'], {
    cwd: repo.dir,
    encoding: 'utf8',
    env: { ...process.env, PR_NUMBER: '', GITHUB_REPOSITORY: '' }
  });
  assert.equal(noReviews.status, 2);
  assert.match(noReviews.stderr, /the reviews are needed/);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--bogus'], { cwd: repo.dir }).status, 2);
});
