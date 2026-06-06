/**
 * Postgres connection pool. Used when DATABASE_URL is set (fresh start / production).
 */

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
const poolMax = Math.min(20, Math.max(2, parseInt(process.env.PG_POOL_MAX || '10', 10)));

const pool = connectionString
  ? new Pool({
      connectionString,
      max: poolMax,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: Math.max(
        5000,
        parseInt(process.env.PG_CONNECTION_TIMEOUT_MS || '10000', 10)
      ),
      ssl: connectionString && connectionString.includes('sslmode=require') ? { rejectUnauthorized: true } : undefined,
    })
  : null;

if (pool) {
  pool.on('error', (err) => {
    console.error('[Postgres] Idle client error:', err.message);
  });
}

module.exports = { pool, poolMax };
