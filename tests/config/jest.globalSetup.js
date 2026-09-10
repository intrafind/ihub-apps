/**
 * Pin the test-run timezone.
 *
 * Several units are specified in the *viewer's local* calendar — chat history
 * buckets ("a chat from 23:50 last night is Yesterday at 00:10"), date
 * formatting — and their tests build instants with the local-time
 * `new Date(y, m, d, …)` constructor. In a container whose clock is UTC, local
 * and UTC are the same clock, so those assertions cannot tell a local-time
 * implementation from a UTC one: replacing `startOfLocalDay` with a
 * `Date.UTC` equivalent left the whole suite green.
 *
 * Fixing the zone to one with a non-zero offset (and a DST transition) makes
 * the existing boundary assertions discriminate. It runs before the workers
 * are forked, so they inherit it.
 */
export default async function globalSetup() {
  process.env.TZ = process.env.TZ || 'Europe/Berlin';
}
