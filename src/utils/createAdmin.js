const bcrypt = require("bcrypt");
const readline = require("readline");
const db = require("../config/db");
const { ADMIN_ROLES, DEFAULT_ADMIN_ROLE } = require("../config/adminRoutePolicy");
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

    // SEC-15.4: least privilege by default. An unrecognised or blank answer
    // yields `viewer`, never the most powerful tier - getting this prompt wrong
    // must under-grant, not over-grant.
    console.log("\nRoles:");
    console.log("  viewer     - read-only analytics");
    console.log("  editor     - catalog authoring (styles, categories, tags, uploads)");
    console.log("  superadmin - everything, including balances and pricing");
    const roleAnswer = (await ask(`Role [${DEFAULT_ADMIN_ROLE}]: `)).trim().toLowerCase();
    const role = ADMIN_ROLES.includes(roleAnswer) ? roleAnswer : DEFAULT_ADMIN_ROLE;
    if (roleAnswer && role !== roleAnswer) {
      console.log(`⚠️  "${roleAnswer}" is not a valid role - defaulting to ${DEFAULT_ADMIN_ROLE}.`);
    }

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
      (full_name, email, password_hash, role)
      VALUES ($1, $2, $3, $4)
      `,
      [fullName, email, passwordHash, role]
    );

    console.log(`✅ Admin created successfully with role: ${role}`);

  } catch (err) {
    console.error(err);
  } finally {
    rl.close();
  }
}

createAdmin();