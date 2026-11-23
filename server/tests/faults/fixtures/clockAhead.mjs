// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Starts a server whose clock is ahead: `node --import clockAhead.mjs server.js`
 * with `FAULTS_CLOCK_AHEAD_MS=<ms>`. The harness uses it for
 * `stack.restart({ clockAheadMs })`.
 *
 * Some rules of the server wait for real time before they act: a chat whose
 * turn claimed it less than two minutes ago is presumed alive, for example. A
 * fault test must not sleep through such a wait. It starts the next server with
 * the clock ahead instead, which is the same as "the person came back later".
 *
 * Only `Date.now()` and `new Date()` without arguments are moved. Timers and
 * `performance.now()` keep their pace, so nothing in the server runs faster.
 * The file is loaded only by the harness; no server code knows about it.
 */

const ahead = Number(process.env.FAULTS_CLOCK_AHEAD_MS);

if (Number.isFinite(ahead) && ahead > 0) {
  const RealDate = Date;
  // Taken now: code that saves `Date.now` and writes it back later would
  // otherwise make the real `Date.now` this very function.
  const realNow = RealDate.now.bind(RealDate);
  const now = () => realNow() + ahead;
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget);
    },
    // `Date()` without `new` returns the time as text.
    apply(target) {
      return new target(now()).toString();
    },
    get(target, property, receiver) {
      return property === 'now' ? now : Reflect.get(target, property, receiver);
    }
  });
}
