require('dotenv').config();

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.startsWith('YOUR_')) {
    console.warn("⚠️ WARNING: RESEND_API_KEY is not configured. Email will not be sent.");
    // SEC-16.1: the recipient and subject are enough to see which mail would
    // have gone out. The body is deliberately NOT logged - the verification
    // and password-reset templates embed a live single-use account-recovery
    // token in their link, so printing it here would write the same secret to
    // the log stream that the redacted request logger now keeps out of it.
    // This branch is reached whenever RESEND_API_KEY is missing or still a
    // `YOUR_*` placeholder, so it must be safe by construction rather than by
    // assuming the key is always configured.
    console.log(`[SIMULATED EMAIL] To: ${to}, Subject: ${subject}`);
    return { id: "simulated_id" };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || "onboarding@resend.dev",
      to,
      subject,
      html
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend API call failed: ${response.status} - ${errText}`);
  }

  return await response.json();
}

module.exports = sendEmail;
