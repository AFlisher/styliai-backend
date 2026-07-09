const bcrypt = require("bcrypt");
const db = require("../config/db");
const jwt = require("jsonwebtoken");

async function login(req, res) {
  try {
    const { email, password } = req.body;

    const result = await db.query(
      `SELECT id, email, full_name, password_hash
       FROM admins
       WHERE email = $1`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        message: "Invalid email or password."
      });
    }

    const admin = result.rows[0];

    const valid = await bcrypt.compare(
      password,
      admin.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        message: "Invalid email or password."
      });
    }

    const accessToken = jwt.sign(
      {
        sub: admin.id,
        email: admin.email,
        role: "admin"
      },
      process.env.ADMIN_JWT_SECRET,
      {
        expiresIn: "12h"
      }
    );

    res.json({
      accessToken,
      user: {
        id: admin.id,
        email: admin.email,
        fullName: admin.full_name,
        role: "admin"
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Internal server error."
    });
  }
}

module.exports = {
  login
};