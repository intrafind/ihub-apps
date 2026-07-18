/**
 * DDL for the minimal schema PostgresProvider needs. This is a distinct,
 * much smaller concern from server/migrations/ (which versions the *content*
 * of JSON config files) — this only versions the *database schema* itself.
 */
export const CONFIG_KV_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS config_kv (
  path TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/**
 * Ensures the tables PostgresProvider depends on exist. Idempotent —
 * safe to call on every server startup when DATABASE_URL is set.
 *
 * @param {import('pg').Pool} pool
 */
export async function ensureSchema(pool) {
  await pool.query(CONFIG_KV_TABLE_SQL);
}
