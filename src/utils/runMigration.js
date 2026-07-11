const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function runMigration() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ ERROR: DATABASE_URL is not set in your .env file!");
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  try {
    await client.connect();
    console.log("✅ Connected to database. Running migration script...");

    const sqlPath = path.join(__dirname, '../../migration.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await client.query(sql);

    const googleSqlPath = path.join(__dirname, '../../migration_google.sql');
    if (fs.existsSync(googleSqlPath)) {
      const googleSql = fs.readFileSync(googleSqlPath, 'utf8');
      await client.query(googleSql);
      console.log("✅ Google migration completed successfully!");
    }

    const adTransactionsSqlPath = path.join(__dirname, '../../migration_ad_transactions.sql');
    if (fs.existsSync(adTransactionsSqlPath)) {
      const adTransactionsSql = fs.readFileSync(adTransactionsSqlPath, 'utf8');
      await client.query(adTransactionsSql);
      console.log("✅ Ad transactions migration completed successfully!");
    }

    console.log("✅ Database migration completed successfully!");
  } catch (err) {
    console.error("❌ Database migration failed:", err.message);
  } finally {
    await client.end();
  }
}

runMigration();
