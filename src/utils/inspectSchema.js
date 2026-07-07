const { Client } = require('pg');
require('dotenv').config();

async function inspectSchema() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ ERROR: DATABASE_URL is not set in your .env file!");
    process.exit(1);
  }

  console.log("Connecting to PostgreSQL to inspect schema...");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  try {
    await client.connect();
    console.log("✅ Successfully connected to database.");

    // Query list of tables in public schema
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    console.log("\n--- Active Tables in 'public' Schema ---");
    if (tablesRes.rows.length === 0) {
      console.log("No tables found in public schema.");
    } else {
      for (const row of tablesRes.rows) {
        console.log(`- ${row.table_name}`);
        // For each table, query its columns
        const columnsRes = await client.query(`
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position;
        `, [row.table_name]);
        
        for (const col of columnsRes.rows) {
          console.log(`    * ${col.column_name} (${col.data_type}, Nullable: ${col.is_nullable})`);
        }
      }
    }
    console.log("---------------------------------------\n");

  } catch (err) {
    console.error("❌ Failed to inspect schema:", err.message);
  } finally {
    await client.end();
  }
}

inspectSchema();
