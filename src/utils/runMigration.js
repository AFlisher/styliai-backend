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

    const usersWalletColumnsSqlPath = path.join(__dirname, '../../migration_users_wallet_columns.sql');
    if (fs.existsSync(usersWalletColumnsSqlPath)) {
      const usersWalletColumnsSql = fs.readFileSync(usersWalletColumnsSqlPath, 'utf8');
      await client.query(usersWalletColumnsSql);
      console.log("✅ Users wallet columns migration completed successfully!");
    }

    const adminsSqlPath = path.join(__dirname, '../../migration_admins.sql');
    if (fs.existsSync(adminsSqlPath)) {
      const adminsSql = fs.readFileSync(adminsSqlPath, 'utf8');
      await client.query(adminsSql);
      console.log("✅ Admins migration completed successfully!");
    }

    const catalogSqlPath = path.join(__dirname, '../../migration_catalog.sql');
    if (fs.existsSync(catalogSqlPath)) {
      const catalogSql = fs.readFileSync(catalogSqlPath, 'utf8');
      await client.query(catalogSql);
      console.log("✅ Catalog migration completed successfully!");
    }

    const walletLedgerSqlPath = path.join(__dirname, '../../migration_wallet_ledger.sql');
    if (fs.existsSync(walletLedgerSqlPath)) {
      const walletLedgerSql = fs.readFileSync(walletLedgerSqlPath, 'utf8');
      await client.query(walletLedgerSql);
      console.log("✅ Wallet ledger migration completed successfully!");
    }

    const adTransactionsSqlPath = path.join(__dirname, '../../migration_ad_transactions.sql');
    if (fs.existsSync(adTransactionsSqlPath)) {
      const adTransactionsSql = fs.readFileSync(adTransactionsSqlPath, 'utf8');
      await client.query(adTransactionsSql);
      console.log("✅ Ad transactions migration completed successfully!");
    }

    const walletTypeFixSqlPath = path.join(__dirname, '../../migration_fix_wallet_transaction_type.sql');
    if (fs.existsSync(walletTypeFixSqlPath)) {
      const walletTypeFixSql = fs.readFileSync(walletTypeFixSqlPath, 'utf8');
      await client.query(walletTypeFixSql);
      console.log("✅ Wallet transaction type fix migration completed successfully!");
    }

    const creditPacksSqlPath = path.join(__dirname, '../../migration_credit_packs.sql');
    if (fs.existsSync(creditPacksSqlPath)) {
      const creditPacksSql = fs.readFileSync(creditPacksSqlPath, 'utf8');
      await client.query(creditPacksSql);
      console.log("✅ Credit packs migration completed successfully!");
    }

    const favoritesSqlPath = path.join(__dirname, '../../migration_favorites.sql');
    if (fs.existsSync(favoritesSqlPath)) {
      const favoritesSql = fs.readFileSync(favoritesSqlPath, 'utf8');
      await client.query(favoritesSql);
      console.log("✅ Favorites migration completed successfully!");
    }

    const creationsSqlPath = path.join(__dirname, '../../migration_creations.sql');
    if (fs.existsSync(creationsSqlPath)) {
      const creationsSql = fs.readFileSync(creationsSqlPath, 'utf8');
      await client.query(creationsSql);
      console.log("✅ Creations migration completed successfully!");
    }

    const tagsSqlPath = path.join(__dirname, '../../migration_tags.sql');
    if (fs.existsSync(tagsSqlPath)) {
      const tagsSql = fs.readFileSync(tagsSqlPath, 'utf8');
      await client.query(tagsSql);
      console.log("✅ Tags migration completed successfully!");
    }

    const personalizationSqlPath = path.join(__dirname, '../../migration_personalization.sql');
    if (fs.existsSync(personalizationSqlPath)) {
      const personalizationSql = fs.readFileSync(personalizationSqlPath, 'utf8');
      await client.query(personalizationSql);
      console.log("✅ Personalization migration completed successfully!");
    }

    const seedTagsSqlPath = path.join(__dirname, '../../migration_seed_tags.sql');
    if (fs.existsSync(seedTagsSqlPath)) {
      const seedTagsSql = fs.readFileSync(seedTagsSqlPath, 'utf8');
      await client.query(seedTagsSql);
      console.log("✅ Seed tags migration completed successfully!");
    }

    const autoTagsSqlPath = path.join(__dirname, '../../migration_auto_tags.sql');
    if (fs.existsSync(autoTagsSqlPath)) {
      const autoTagsSql = fs.readFileSync(autoTagsSqlPath, 'utf8');
      await client.query(autoTagsSql);
      console.log("✅ Auto-tags migration completed successfully!");
    }

    console.log("✅ Database migration completed successfully!");
  } catch (err) {
    console.error("❌ Database migration failed:", err.message);
  } finally {
    await client.end();
  }
}

runMigration();
