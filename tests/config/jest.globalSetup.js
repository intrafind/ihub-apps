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
 *
 * The override is `IHUB_TEST_TZ`, deliberately not `TZ`. Deferring to `TZ`
 * hands the decision to whatever set it, and the single most common value a
 * base image or a CI workflow sets it to is `UTC` — the exact condition
 * described above, where local and UTC are the same clock and the assertions
 * stop discriminating. Nothing would fail; the suite would simply go back to
 * passing for a UTC implementation. An override nobody sets by accident keeps
 * the zone deliberate while still leaving it changeable.
 */
export default async function globalSetup() {
  process.env.TZ = process.env.IHUB_TEST_TZ || 'Europe/Berlin';
}
