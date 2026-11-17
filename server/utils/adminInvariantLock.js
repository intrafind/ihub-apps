// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One lock around every write that can take administrator access away.
 *
 * The lockout guards (`adminGuards.js`) each run under their own file's lock
 * and read the other two files (platform.json, users.json, groups.json)
 * unlocked. Two concurrent admin actions on different files could therefore
 * each pass against the other's old file and together leave no administrator:
 * a platform save that turns off local sign-in while another admin removes the
 * admin group from the only OIDC administrator, for example.
 *
 * Holding this lock around the whole read-check-write of each guarded writer
 * serializes them. It has two layers: a queue in this process, then a lease
 * file (`contents/config/.admin-invariants.lock`, `withFileLock`) that every
 * cluster worker sharing `contents/` honours, the same mechanism that guards
 * each config file's own writes. Lock order is always this lock first, then
 * the file's own lock (inside `configStore.updateJson`); nothing takes this
 * lock while holding a file lock, so the two cannot deadlock. It is reentrant
 * within one async call chain, and the lease is taken once per chain.
 *
 * Reach: the workers of one installation on one volume. Separate
 * installations (pods) that do not share `contents/` are not coordinated;
 * see docs/AUTHENTICATION_QUICK_START.md.
 *
 * @module server/utils/adminInvariantLock
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { getContentsPath } from './contentsPath.js';
import { withFileLock } from './fileLock.js';

const held = new AsyncLocalStorage();
let tail = Promise.resolve();

/**
 * How long a guarded write waits for another worker's before it fails
 * (`LockTimeoutError`; it never runs unguarded). The sections are a read, a
 * check and a write of one config file, so a wait this long means a holder is
 * stuck; a crashed holder's lease ages out after `staleMs`.
 */
const LOCK_OPTIONS = Object.freeze({
  timeoutMs: 30_000,
  staleMs: 15_000,
  component: 'AdminInvariantLock'
});

/** The lease file all workers of this installation take. */
function lockPath() {
  return path.join(getContentsPath(), 'config', '.admin-invariants.lock');
}

/**
 * Run `fn` as the only guarded admin write of this installation: in this
 * process (a queue) and across the cluster workers sharing `contents/` (a
 * lease file).
 *
 * @template T
 * @param {() => Promise<T>} fn - The read-check-write (an `updateJson` / `updatePlatform` call)
 * @returns {Promise<T>} What `fn` returns
 *
 * @example
 * await withAdminInvariantLock(() =>
 *   configStore.updateJson('config/users.json', async users => {
 *     await assertUserChangeKeepsAdmin(req.user, before, users, { userId, action: 'update' });
 *     return users;
 *   })
 * );
 */
export function withAdminInvariantLock(fn) {
  if (held.getStore()) return fn();
  const run = tail.then(() => held.run(true, () => withFileLock(lockPath(), fn, LOCK_OPTIONS)));
  tail = run.catch(() => {
    /* a failed write is reported to its caller, not to the next in line */
  });
  return run;
}

export default withAdminInvariantLock;
