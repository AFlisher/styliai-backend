require('dotenv').config();

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.startsWith('YOUR_')) {
    console.warn("⚠️ WARNING: RESEND_API_KEY is not configured. Email will not be sent.");
    console.log(`[SIMULATED EMAIL] To: ${to}, Subject: ${subject}`);
    console.log(`[HTML Body]:\n${html}\n`);
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
