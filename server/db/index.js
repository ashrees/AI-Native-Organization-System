/**
 * Postgres connection pool. Used when DATABASE_URL is set (fresh start / production).
 */

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
const pool = connectionString
  ? new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      ssl: connectionString && connectionString.includes('sslmode=require') ? { rejectUnauthorized: true } : undefined,
    })
  : null;

module.exports = { pool };
