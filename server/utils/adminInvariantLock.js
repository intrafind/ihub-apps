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
 * serializes them in this process. Lock order is always this lock first, then
 * the file's own lock (inside `configStore.updateJson`); nothing takes this
 * lock while holding a file lock, so the two cannot deadlock. It is reentrant
 * within one async call chain.
 *
 * Known limitation: it is per process. Several workers or pods writing at the
 * same moment can still skew; that needs two admins acting within
 * milliseconds and is documented in docs/AUTHENTICATION_QUICK_START.md.
 *
 * @module server/utils/adminInvariantLock
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const held = new AsyncLocalStorage();
let tail = Promise.resolve();

/**
 * Run `fn` as the only guarded admin write in this process.
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
  const run = tail.then(() => held.run(true, fn));
  tail = run.catch(() => {
    /* a failed write is reported to its caller, not to the next in line */
  });
  return run;
}

export default withAdminInvariantLock;
