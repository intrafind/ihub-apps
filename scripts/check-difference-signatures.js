#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Ties the signatures of the difference list to an approving review.
 *
 * `server/tests/golden/differences.json` lists the accepted differences between
 * the recorded behaviour and today's. A row is accepted when the product owner
 * signed it (`signedBy`, `signedOn`). Those are two JSON fields any pull request
 * can edit, so this check gives them their meaning: a pull request that adds,
 * changes or removes a signature, or edits a signed row, passes only when
 *
 *   1. every signature names an owner of the difference list, as
 *      `.github/CODEOWNERS` of the TARGET branch has it (a pull request cannot
 *      appoint its own signer), and
 *   2. that owner's latest review of the pull request is an approval, given for
 *      a commit whose difference list is byte for byte the one of the head
 *      commit (an approval does not cover rows pushed after it).
 *
 * A pull request that touches no signature passes without a review.
 *
 * Usage:
 *   node scripts/check-difference-signatures.js --base origin/main --head <sha> --pr 123
 *   node scripts/check-difference-signatures.js --base main --reviews reviews.json
 *
 * Options (each also as an environment variable):
 *   --base <ref>      target branch                      DIFFERENCES_BASE_REF, origin/$GITHUB_BASE_REF
 *   --head <ref>      head commit of the pull request    DIFFERENCES_HEAD_SHA, HEAD
 *   --pr <number>     pull request number                PR_NUMBER
 *   --repo <o/name>   repository                         GITHUB_REPOSITORY
 *   --reviews <file>  reviews as the GitHub API returns them (GET /pulls/{n}/reviews),
 *                     instead of asking the API; for local runs and the self-test
 *
 * The reviews are read with the GitHub CLI (`gh`, token in GH_TOKEN). Exit code 0:
 * nothing to sign, or signed and approved. 1: a signature without the owner's
 * approval. 2: the check could not run.
 *
 * See docs/run-testing.md.
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DIFFERENCES_PATH = 'server/tests/golden/differences.json';
export const CODEOWNERS_PATH = '.github/CODEOWNERS';

/** Review states that say something about approval; a comment does not replace an approval. */
const DECIDING_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/**
 * The owners `CODEOWNERS` names for a path. The last matching line wins, as on
 * GitHub. Only what this check needs is understood: `*`, the path itself, and a
 * directory above it (`/server/tests/golden/`), each with or without a leading
 * slash. A line with any other pattern is not taken as a match, so it can never
 * appoint an owner here by accident.
 *
 * @param {string|null} text - The content of CODEOWNERS.
 * @param {string} file - A path relative to the repository root.
 * @returns {string[]} Logins without `@`, lower-case. Team owners (`@org/team`) are returned as
 *   they are; `evaluate` does not accept them, because a team cannot be matched to a review here.
 */
export function ownersOf(text, file) {
  let owners = [];
  for (const raw of (text || '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...names] = line.split(/\s+/);
    const target = pattern.replace(/^\//, '');
    const matches =
      pattern === '*' || target === file || (target.endsWith('/') && file.startsWith(target));
    if (matches) owners = names.map(name => name.replace(/^@/, '').toLowerCase());
  }
  return owners;
}

function rowsOf(text) {
  if (text === null || text === undefined || text.trim() === '') return [];
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.rows)) {
    throw new Error(`${DIFFERENCES_PATH} must be an object with a "rows" array`);
  }
  return parsed.rows;
}

const isSigned = row => Boolean(row && (row.signedBy || row.signedOn || row.state === 'signed'));

/**
 * The rows whose signature this pull request touches.
 *
 * @param {Object[]} baseRows - The rows on the target branch.
 * @param {Object[]} headRows - The rows of the pull request.
 * @returns {Array<{id: string, change: 'added'|'changed'|'removed', signedBy: string|null}>}
 */
export function signatureChanges(baseRows, headRows) {
  const base = new Map(baseRows.map(row => [row.id, row]));
  const head = new Map(headRows.map(row => [row.id, row]));
  const changes = [];
  for (const [id, row] of head) {
    const before = base.get(id);
    if (isSigned(row)) {
      if (!isSigned(before)) changes.push({ id, change: 'added', signedBy: row.signedBy ?? null });
      // Any edit of a signed row: the signature would otherwise cover text the signer never saw.
      else if (JSON.stringify(before) !== JSON.stringify(row)) {
        changes.push({ id, change: 'changed', signedBy: row.signedBy ?? null });
      }
    } else if (isSigned(before)) {
      changes.push({ id, change: 'removed', signedBy: before.signedBy ?? null });
    }
  }
  for (const [id, before] of base) {
    if (!head.has(id) && isSigned(before)) {
      changes.push({ id, change: 'removed', signedBy: before.signedBy ?? null });
    }
  }
  return changes;
}

/**
 * The latest deciding review of each reviewer.
 *
 * @param {Object[]} reviews - As `GET /repos/{owner}/{repo}/pulls/{n}/reviews` returns them.
 * @returns {Map<string, Object>} Lower-case login → review.
 */
export function latestReviews(reviews) {
  const latest = new Map();
  const sorted = [...reviews]
    .filter(review => DECIDING_STATES.has(review?.state) && review?.user?.login)
    .sort((a, b) => String(a.submitted_at || '').localeCompare(String(b.submitted_at || '')));
  for (const review of sorted) latest.set(review.user.login.toLowerCase(), review);
  return latest;
}

/**
 * Decide whether the signatures of a pull request stand.
 *
 * @param {Object} params
 * @param {ReturnType<typeof signatureChanges>} params.changes
 * @param {string[]} params.owners - Owners of the difference list on the target branch.
 * @param {Object[]} params.reviews - The reviews of the pull request.
 * @param {(commit: string) => boolean} params.listUnchangedSince - Whether the difference list at
 *   that commit equals the one at the head commit.
 * @returns {{ok: boolean, problems: string[], approvedBy: string|null}}
 */
export function evaluate({ changes, owners, reviews, listUnchangedSince }) {
  if (changes.length === 0) return { ok: true, problems: [], approvedBy: null };
  const problems = [];
  const people = owners.filter(owner => !owner.includes('/'));
  if (people.length === 0) {
    problems.push(
      `${CODEOWNERS_PATH} of the target branch names no person as owner of ${DIFFERENCES_PATH}. ` +
        'A signature needs an owner who can approve.'
    );
    return { ok: false, problems, approvedBy: null };
  }
  for (const change of changes) {
    if (change.change === 'removed') continue;
    const signer = String(change.signedBy || '').toLowerCase();
    if (!people.includes(signer)) {
      problems.push(
        `Row "${change.id}" is signed by "${change.signedBy}", who is not an owner of the ` +
          `difference list (${people.join(', ')}).`
      );
    }
  }

  const latest = latestReviews(reviews);
  const approving = people.find(owner => {
    const review = latest.get(owner);
    return review?.state === 'APPROVED' && listUnchangedSince(review.commit_id);
  });
  if (!approving) {
    const list = changes.map(change => `"${change.id}" (signature ${change.change})`).join(', ');
    const seen = people
      .map(owner => {
        const review = latest.get(owner);
        if (!review) return `${owner}: no review`;
        if (review.state !== 'APPROVED') return `${owner}: latest review is ${review.state}`;
        return `${owner}: approved ${String(review.commit_id).slice(0, 12)}, before the difference list took its current form`;
      })
      .join('; ');
    problems.push(
      `This pull request touches the signature of ${list}, and no owner of the difference list ` +
        `has approved it in its current form (${seen}). A signature is valid only with the approving ` +
        'review of an owner; the author of a pull request cannot approve it.'
    );
  }
  return { ok: problems.length === 0, problems, approvedBy: approving ?? null };
}

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024
    });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

const show = (commit, file) => git(['show', `${commit}:${file}`], { allowFailure: true });

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--(base|head|pr|repo|reviews)(?:=(.*))?$/.exec(argv[i]);
    if (!match) throw new Error(`Unknown option: ${argv[i]}`);
    options[match[1]] = match[2] ?? argv[++i];
    if (options[match[1]] === undefined) throw new Error(`--${match[1]} needs a value`);
  }
  return options;
}

/**
 * The reviews of a pull request, read with the GitHub CLI (`gh`, present on
 * every GitHub runner; it takes the token from GH_TOKEN and knows the host of a
 * GitHub Enterprise installation).
 */
function fetchReviews({ repo, pr }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(String(pr))) {
    throw new Error(`Not a repository and pull request number: "${repo}" #${pr}`);
  }
  let output;
  try {
    output = execFileSync(
      'gh',
      [
        'api',
        '--paginate',
        `repos/${repo}/pulls/${pr}/reviews?per_page=100`,
        '--jq',
        '.[] | {state, commit_id, submitted_at, user: {login: .user.login}}'
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (error) {
    throw new Error(
      `The reviews of #${pr} could not be read with gh: ${String(error.stderr || error.message).trim()}`
    );
  }
  return output
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = process.env;
  const baseRef =
    options.base ||
    env.DIFFERENCES_BASE_REF ||
    (env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : null);
  const headRef = options.head || env.DIFFERENCES_HEAD_SHA || 'HEAD';
  if (!baseRef) throw new Error('No target branch: pass --base <ref>');

  const head = git(['rev-parse', '--verify', `${headRef}^{commit}`], {
    allowFailure: true
  })?.trim();
  if (!head) throw new Error(`The head commit "${headRef}" is not in this checkout`);
  const base = git(['merge-base', baseRef, head], { allowFailure: true })?.trim();
  if (!base) {
    throw new Error(
      `No common commit of "${baseRef}" and ${head.slice(0, 12)}: the checkout needs the history ` +
        'of the target branch (fetch-depth: 0)'
    );
  }

  const headList = show(head, DIFFERENCES_PATH);
  const changes = signatureChanges(rowsOf(show(base, DIFFERENCES_PATH)), rowsOf(headList));
  if (changes.length === 0) {
    console.log('[difference signatures] this pull request touches no signature');
    return 0;
  }

  // The owner is read from the target branch: a pull request cannot appoint its own signer.
  // The one exception is the pull request that introduces the difference list itself, when
  // the target branch has neither the list nor an owner for it.
  const baseList = show(base, DIFFERENCES_PATH);
  let owners = ownersOf(show(base, CODEOWNERS_PATH), DIFFERENCES_PATH);
  if (owners.length === 0 && baseList === null) {
    owners = ownersOf(show(head, CODEOWNERS_PATH), DIFFERENCES_PATH);
    if (owners.length > 0) {
      console.log(
        `[difference signatures] the target branch has no difference list and no owner for it ` +
          'yet; using the owner this pull request adds'
      );
    }
  }

  let reviews;
  if (options.reviews) {
    reviews = JSON.parse(fs.readFileSync(options.reviews, 'utf8'));
  } else {
    const pr = options.pr || env.PR_NUMBER;
    const repo = options.repo || env.GITHUB_REPOSITORY;
    if (!pr || !repo) {
      throw new Error(
        'A signature changed and the reviews are needed: pass --pr and --repo, or --reviews <file>'
      );
    }
    reviews = fetchReviews({ repo, pr });
  }

  const listUnchangedSince = commit => {
    // The id comes from the API: only a commit id is handed to git, and only one this checkout has
    // (a commit that was force-pushed away approves nothing).
    if (!/^[0-9a-f]{7,64}$/i.test(String(commit || ''))) return false;
    const known = git(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`], {
      allowFailure: true
    });
    return known !== null && show(commit, DIFFERENCES_PATH) === headList;
  };

  const verdict = evaluate({ changes, owners, reviews, listUnchangedSince });
  for (const change of changes) {
    console.log(`[difference signatures] row "${change.id}": signature ${change.change}`);
  }
  if (verdict.ok) {
    console.log(`[difference signatures] approved by ${verdict.approvedBy}`);
    return 0;
  }
  for (const problem of verdict.problems) console.error(`[difference signatures] ${problem}`);
  return 1;
}

// Run only as a script: the self-test imports the functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`[difference signatures] ${error.message}`);
    process.exit(2);
  }
}
