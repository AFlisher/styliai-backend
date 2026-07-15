const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

/**
 * Builds the pg SSL options. Exported for tests.
 *
 * DATABASE_CA_CERT may hold either the CA certificate PEM itself or a path
 * to a PEM file (e.g. the CA download from the Supabase dashboard). When
 * present, the server certificate is fully verified - this is the intended
 * production configuration (audit finding #1). Without it, production falls
 * back to encrypted-but-unverified TLS (previous behavior) and logs a
 * warning on boot so the gap can't go unnoticed.
 */
function buildSslConfig(env = process.env) {
  const caSetting = env.DATABASE_CA_CERT;

  if (caSetting && caSetting.trim()) {
    const ca = caSetting.includes('-----BEGIN')
      ? caSetting
      : fs.readFileSync(caSetting.trim(), 'utf8');
    return { ca, rejectUnauthorized: true };
  }

  if (env.NODE_ENV === 'production') {
    console.warn(
      '[db] WARNING: DATABASE_CA_CERT is not set - the Postgres TLS certificate is NOT being verified. ' +
      'Download your provider\'s CA certificate and set DATABASE_CA_CERT to enable full verification.'
    );
    return { rejectUnauthorized: false };
  }

  return false;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: buildSslConfig()
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  buildSslConfig
};
