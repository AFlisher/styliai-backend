const bcrypt = require("bcrypt");
const readline = require("readline");
const db = require("../config/db");
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function createAdmin() {
  try {
    const fullName = await ask("Full Name: ");
    const email = await ask("Email: ");
    const password = await ask("Password: ");

    // Check if admin already exists
    const existing = await db.query(
      "SELECT id FROM admins WHERE email = $1",
      [email]
    );

    if (existing.rows.length > 0) {
      console.log("❌ Admin already exists.");
      rl.close();
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await db.query(
      `
      INSERT INTO admins
      (full_name, email, password_hash)
      VALUES ($1, $2, $3)
      `,
      [fullName, email, passwordHash]
    );

    console.log("✅ Admin created successfully.");

  } catch (err) {
    console.error(err);
  } finally {
    rl.close();
  }
}

createAdmin();