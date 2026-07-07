function renderVerificationPage({ success, title, subtitle }) {
  const brandGradient = "linear-gradient(135deg, #A855F7, #E735F6)";
  const statusColor = success ? "#10B981" : "#EF4444";
  const iconClass = success ? "fa-regular fa-circle-check" : "fa-solid fa-circle-exclamation";
  
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>StyliAI — Account Status</title>
    <!-- Google Fonts -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@600;800;900&family=Inter:wght@400;600&display=swap" rel="stylesheet">
    <!-- FontAwesome for Premium Icons -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
      /* Reset & Font Setup */
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }
      :root {
        --bg-color: #05050A;
        --text-primary: #FFFFFF;
        --text-secondary: #8A8A9D;
        --purple-solid: #A855F7;
        --pink-solid: #E735F6;
        --success-color: #10B981;
        --error-color: #EF4444;
      }
      body {
        background-color: var(--bg-color);
        color: var(--text-primary);
        font-family: 'Inter', sans-serif;
        min-height: 100vh;
        display: flex;
        justify-content: center;
        align-items: center;
        overflow: hidden;
        position: relative;
      }
      /* Background Grid and Glowing Spheres */
      .background-grid {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-image: 
          linear-gradient(rgba(255, 255, 255, 0.015) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255, 255, 255, 0.015) 1px, transparent 1px);
        background-size: 40px 40px;
        background-position: center;
        z-index: 1;
      }
      .background-glow {
        position: absolute;
        width: 400px;
        height: 400px;
        border-radius: 50%;
        filter: blur(140px);
        opacity: 0.55;
        z-index: 2;
        pointer-events: none;
      }
      .background-glow.top-left {
        background: var(--purple-solid);
        top: -10%;
        left: -10%;
      }
      .background-glow.bottom-right {
        background: var(--pink-solid);
        bottom: -10%;
        right: -10%;
      }
      /* Container and Card */
      .container {
        position: relative;
        z-index: 10;
        width: 100%;
        max-width: 460px;
        padding: 24px;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      .logo-wrapper {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 32px;
        animation: fadeInDown 0.8s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .logo-icon {
        font-size: 28px;
        background: linear-gradient(135deg, var(--purple-solid), var(--pink-solid));
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      .logo-text {
        font-family: 'Outfit', sans-serif;
        font-size: 30px;
        font-weight: 900;
        letter-spacing: -0.5px;
      }
      .verify-card {
        width: 100%;
        border-radius: 28px;
        padding: 40px 32px;
        text-align: center;
        background: rgba(13, 13, 24, 0.65);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.06);
        box-shadow: 
          0 24px 60px rgba(0, 0, 0, 0.8),
          inset 0 1px 0 rgba(255, 255, 255, 0.08);
        animation: scaleIn 0.8s cubic-bezier(0.16, 1, 0.3, 1);
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      /* Icon Indicator */
      .status-indicator {
        position: relative;
        width: 100px;
        height: 100px;
        display: flex;
        justify-content: center;
        align-items: center;
        margin-bottom: 24px;
      }
      .center-icon {
        width: 80px;
        height: 80px;
        border-radius: 50%;
        background: ${statusColor};
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 5;
      }
      .center-icon i {
        font-size: 36px;
        color: white;
      }
      .title {
        font-family: 'Outfit', sans-serif;
        font-size: 26px;
        font-weight: 800;
        letter-spacing: -0.5px;
        margin-bottom: 12px;
        color: ${statusColor};
      }
      .subtitle {
        color: var(--text-secondary);
        font-size: 15px;
        line-height: 1.5;
      }
      /* Animations */
      @keyframes fadeInDown {
        from { opacity: 0; transform: translateY(-20px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes scaleIn {
        from { opacity: 0; transform: scale(0.95); }
        to { opacity: 1; transform: scale(1); }
      }
    </style>
  </head>
  <body>
    <div class="background-grid"></div>
    <div class="background-glow top-left"></div>
    <div class="background-glow bottom-right"></div>
    <main class="container">
      <div class="logo-wrapper">
        <i class="fa-solid fa-wand-magic-sparkles logo-icon"></i>
        <span class="logo-text">StyliAI</span>
      </div>
      <div class="verify-card">
        <div class="status-indicator">
          <div class="center-icon">
            <i class="${iconClass}"></i>
          </div>
        </div>
        <h1 class="title">${title}</h1>
        <p class="subtitle">${subtitle}</p>
      </div>
    </main>
  </body>
</html>`;
}

function renderResetPasswordPage({ token, error }) {
  const brandGradient = "linear-gradient(135deg, #A855F7, #E735F6)";
  
  let contentHtml = "";
  
  if (error) {
    contentHtml = `
      <div class="status-indicator error">
        <div class="center-icon error-icon">
          <i class="fa-solid fa-circle-exclamation"></i>
        </div>
      </div>
      <h1 class="title error-title">Verification Failed</h1>
      <p class="subtitle">${error}</p>
    `;
  } else {
    contentHtml = `
      <div class="status-indicator">
        <div class="center-icon">
          <i class="fa-solid fa-lock-open"></i>
        </div>
      </div>
      <h1 class="title">Reset Password</h1>
      <p class="subtitle" style="margin-bottom: 24px;">Please enter your new password below.</p>
      
      <form action="/api/auth/reset-password" method="POST" class="reset-form">
        <input type="hidden" name="token" value="${token}" />
        <div class="input-group">
          <label for="password">New Password</label>
          <input type="password" id="password" name="password" required minlength="8" placeholder="••••••••" />
          <span class="hint">Must contain at least 8 characters, one uppercase, one lowercase, one number, and one special character.</span>
        </div>
        <button type="submit" class="btn">Reset Password</button>
      </form>
    `;
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>StyliAI — Reset Password</title>
    <!-- Google Fonts -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@600;800;900&family=Inter:wght@400;600&display=swap" rel="stylesheet">
    <!-- FontAwesome for Premium Icons -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }
      :root {
        --bg-color: #05050A;
        --text-primary: #FFFFFF;
        --text-secondary: #8A8A9D;
        --purple-solid: #A855F7;
        --pink-solid: #E735F6;
        --success-color: #10B981;
        --error-color: #EF4444;
      }
      body {
        background-color: var(--bg-color);
        color: var(--text-primary);
        font-family: 'Inter', sans-serif;
        min-height: 100vh;
        display: flex;
        justify-content: center;
        align-items: center;
        overflow: hidden;
        position: relative;
      }
      .background-grid {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-image: 
          linear-gradient(rgba(255, 255, 255, 0.015) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255, 255, 255, 0.015) 1px, transparent 1px);
        background-size: 40px 40px;
        background-position: center;
        z-index: 1;
      }
      .background-glow {
        position: absolute;
        width: 400px;
        height: 400px;
        border-radius: 50%;
        filter: blur(140px);
        opacity: 0.55;
        z-index: 2;
        pointer-events: none;
      }
      .background-glow.top-left {
        background: var(--purple-solid);
        top: -10%;
        left: -10%;
      }
      .background-glow.bottom-right {
        background: var(--pink-solid);
        bottom: -10%;
        right: -10%;
      }
      .container {
        position: relative;
        z-index: 10;
        width: 100%;
        max-width: 460px;
        padding: 24px;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      .logo-wrapper {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 32px;
      }
      .logo-icon {
        font-size: 28px;
        background: linear-gradient(135deg, var(--purple-solid), var(--pink-solid));
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      .logo-text {
        font-family: 'Outfit', sans-serif;
        font-size: 30px;
        font-weight: 900;
        letter-spacing: -0.5px;
      }
      .verify-card {
        width: 100%;
        border-radius: 28px;
        padding: 40px 32px;
        text-align: center;
        background: rgba(13, 13, 24, 0.65);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.06);
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.8);
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      .status-indicator {
        position: relative;
        width: 100px;
        height: 100px;
        display: flex;
        justify-content: center;
        align-items: center;
        margin-bottom: 24px;
      }
      .center-icon {
        width: 80px;
        height: 80px;
        border-radius: 50%;
        background: linear-gradient(135deg, var(--purple-solid), var(--pink-solid));
        box-shadow: 0 8px 24px rgba(168, 85, 247, 0.35);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 5;
      }
      .center-icon i {
        font-size: 36px;
        color: white;
      }
      .center-icon.error-icon {
        background: var(--error-color);
        box-shadow: 0 8px 24px rgba(239, 68, 68, 0.35);
      }
      .title {
        font-family: 'Outfit', sans-serif;
        font-size: 26px;
        font-weight: 800;
        letter-spacing: -0.5px;
        margin-bottom: 12px;
      }
      .error-title {
        color: var(--error-color);
      }
      .subtitle {
        color: var(--text-secondary);
        font-size: 15px;
        line-height: 1.5;
      }
      /* Form Design */
      .reset-form {
        width: 100%;
        display: flex;
        flex-direction: column;
        gap: 20px;
        text-align: left;
      }
      .input-group {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      label {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-primary);
      }
      input {
        width: 100%;
        height: 56px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        padding: 0 16px;
        color: white;
        font-size: 16px;
        outline: none;
        transition: all 0.3s;
      }
      input:focus {
        border-color: var(--purple-solid);
        background: rgba(255, 255, 255, 0.08);
      }
      .hint {
        font-size: 11px;
        color: var(--text-secondary);
        line-height: 1.4;
      }
      .btn {
        width: 100%;
        height: 56px;
        border-radius: 16px;
        background: linear-gradient(135deg, var(--purple-solid), var(--pink-solid));
        color: white;
        font-size: 16px;
        font-weight: 700;
        border: none;
        cursor: pointer;
        transition: all 0.3s;
        box-shadow: 0 8px 24px rgba(168, 85, 247, 0.35);
      }
      .btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 12px 28px rgba(168, 85, 247, 0.5);
      }
      .btn:active {
        transform: translateY(0);
      }
    </style>
  </head>
  <body>
    <div class="background-grid"></div>
    <div class="background-glow top-left"></div>
    <div class="background-glow bottom-right"></div>
    <main class="container">
      <div class="logo-wrapper">
        <i class="fa-solid fa-wand-magic-sparkles logo-icon"></i>
        <span class="logo-text">StyliAI</span>
      </div>
      <div class="verify-card">
        ${contentHtml}
      </div>
    </main>
  </body>
</html>`;
}

module.exports = {
  renderVerificationPage,
  renderResetPasswordPage
};
