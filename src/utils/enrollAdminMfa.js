require("dotenv").config();

const readline = require("readline");
const db = require("../config/db");
const adminMfaService = require("../services/adminMfaService");
const adminAuditModel = require("../models/adminAuditModel");

/**
 * SEC-15.2: enrolls an admin account in TOTP multi-factor authentication.
 *
 *     node src/utils/enrollAdminMfa.js
 *
 * A CLI rather than an authenticated endpoint because there is no admin
 * management UI, and adding one is outside this finding. It follows the same
 * interactive-readline shape as createAdmin.js.
 *
 * The important property is CONFIRM BEFORE ENABLE: the account is only switched
 * to mfa_enabled after the operator has typed a live code generated from the
 * new secret. Enabling first and verifying later would let a mistyped or
 * unscanned secret lock the admin out - and with no admin password-reset flow
 * in this codebase, the way back would be a recovery code or direct database
 * access.
 *
 * Roll out ONE admin at a time, and confirm they can log in before enrolling
 * the next, so a working account always remains.
 */

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function formatRecoveryCode(code) {
  return `${code.slice(0, 8)}-${code.slice(8)}`;
}

async function enrollAdminMfa() {
  try {
    const email = (await ask("Admin email: ")).trim().toLowerCase();

    const result = await db.query(
      "SELECT id, email, full_name, mfa_enabled FROM admins WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0) {
      console.log("❌ No admin found with that email.");
      return;
    }

    const admin = result.rows[0];

    if (admin.mfa_enabled) {
      const confirm = (await ask(
        "⚠️  This admin already has MFA enabled. Re-enrolling replaces the existing\n" +
          "   secret and invalidates all current recovery codes. Continue? (yes/no): "
      )).trim().toLowerCase();
      if (confirm !== "yes") {
        console.log("Aborted. Nothing was changed.");
        return;
      }
    }

    const { secret, otpauthUrl } = adminMfaService.generateEnrollment(admin.email);

    console.log("\n──────────────────────────────────────────────────────────────");
    console.log("Add this account to your authenticator app.");
    console.log("\nEnrollment URI (paste into the app, or render as a QR code):");
    console.log("  " + otpauthUrl);
    console.log("\nOr enter the secret manually:");
    console.log("  " + secret.replace(/(.{4})/g, "$1 ").trim());
    console.log("──────────────────────────────────────────────────────────────\n");

    // Confirm before enable. The secret is not stored until a code derived from
    // it verifies, so an abort here leaves the account exactly as it was.
    const code = (await ask("Enter the current 6-digit code to confirm: ")).trim();

    const confirmed = adminMfaService.matchTimestep(code, secret) !== null;
    if (!confirmed) {
      console.log(
        "\n❌ That code did not match. Nothing was saved - the account is unchanged.\n" +
          "   Check the device clock and try again."
      );
      return;
    }

    await adminMfaService.enableMfa(admin.id, secret);
    const codes = await adminMfaService.issueRecoveryCodes(admin.id);

    // SEC-15.1: enrollment is a privileged change to an admin account and
    // belongs in the audit trail. The secret is never part of the payload.
    await adminAuditModel.record({
      adminId: admin.id,
      adminEmail: admin.email,
      action: "CLI enrollAdminMfa",
      targetType: "admins",
      targetId: admin.id,
      before: { mfaEnabled: admin.mfa_enabled },
      after: { mfaEnabled: true, recoveryCodesIssued: codes.length },
      ip: null,
      requestUrl: null,
      statusCode: null,
    });

    console.log("\n✅ MFA enabled for " + admin.email);
    console.log("\n──────────────────────────────────────────────────────────────");
    console.log("RECOVERY CODES - shown once, and never again.");
    console.log("Store them offline. Each works exactly once, in place of a");
    console.log("TOTP code, and they are the only way in if the device is lost.");
    console.log("──────────────────────────────────────────────────────────────");
    for (const code of codes) {
      console.log("  " + formatRecoveryCode(code));
    }
    console.log("──────────────────────────────────────────────────────────────");
    console.log("\nNow verify login from the dashboard BEFORE enrolling anyone else.");
  } catch (err) {
    console.error("❌ Enrollment failed:", err.message);
    process.exitCode = 1;
  } finally {
    rl.close();
    // The pool keeps the process alive otherwise.
    await db.pool.end().catch(() => {});
  }
}

enrollAdminMfa();
