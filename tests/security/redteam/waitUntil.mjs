// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Polls `check` until it is true: once, and again after `delayMs` for as many as `attempts` times
 * in all. A check that throws counts as false (a server that is not listening yet). Written as
 * recursion because each attempt must wait for the one before.
 *
 * @param {() => Promise<boolean>} check
 * @param {{attempts: number, delayMs?: number}} options
 * @returns {Promise<boolean>} whether the check ever passed
 */
export async function waitUntil(check, { attempts, delayMs = 1000 }) {
  const passed = await Promise.resolve()
    .then(check)
    .catch(() => false);
  if (passed) return true;
  if (attempts <= 1) return false;
  await new Promise(resolve => setTimeout(resolve, delayMs));
  return waitUntil(check, { attempts: attempts - 1, delayMs });
}
