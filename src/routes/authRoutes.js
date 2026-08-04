const express = require('express');
const verifyIntegrity = require('../middleware/verifyIntegrity');
const interpretIntegrity = require('../middleware/interpretIntegrity');
const enforceIntegrity = require('../middleware/enforceIntegrity');
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');
// SEC-18.4: disposable-domain rejection plus an inert-until-configured CAPTCHA.
const { signupControls } = require('../services/abuse/signupControls');
const {
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  emailVerificationLimiter,
  statusPollLimiter,
  refreshLimiter,
  googleSignInLimiter,
  accountActionLimiter,
} = require('../middleware/rateLimiters');

const router = express.Router();

// SEC-18.4 (Phase 8): bot controls on the signup surface. The
// disposable-domain check is active by default; the CAPTCHA is inert until
// TURNSTILE_SECRET_KEY is set, so this changes nothing for real users today
// and is one variable away on the day a signup bonus makes registration
// volume directly monetisable.
router.post('/register', registerLimiter, signupControls(), authController.register);
router.get('/verify', emailVerificationLimiter, authController.verifyEmail);
// SEC-0.2: verifyIntegrity annotates req.integrity and never denies. Runs
// pre-auth, so its decode budget is keyed by IP rather than user id.
router.post('/login', loginLimiter, verifyIntegrity, interpretIntegrity, enforceIntegrity, authController.login);
router.post('/refresh', refreshLimiter, authController.refreshToken);
router.post('/logout', accountActionLimiter, authMiddleware, authController.logout);
// Phase 6: "sign me out of everywhere". Bumps token_version, so it also ends
// the session making the call - that is the point, and the client is expected
// to return to the login screen afterwards.
router.post('/logout-all', accountActionLimiter, authMiddleware, authController.logoutAll);
// Google sign-in gets the disposable check but NOT the CAPTCHA: the token is
// already proof of a real Google account, which inherits Google's own abuse
// controls, and a second human-check on top would be friction with no
// corresponding gain. It still produces an INSTANTLY verified account with no
// email round-trip, which is why it is not exempt from the domain check.
router.post('/google', googleSignInLimiter, signupControls({ requireCaptcha: false }), authController.googleSignIn);
router.post('/change-password', accountActionLimiter, authMiddleware, authController.changePassword);
router.post('/forgot-password', forgotPasswordLimiter, authController.forgotPassword);
router.get('/status', statusPollLimiter, authController.checkVerificationStatus);
// Named by the audit alongside registration: resend is the other way to make
// this service send mail to an address of the caller's choosing.
router.post('/resend-verification', emailVerificationLimiter, signupControls(), authController.resendVerification);

// Password reset routes (GET to display form, POST to submit new password) -
// share resetPasswordLimiter's budget, see rateLimiters.js for why.
router.get('/reset-password', resetPasswordLimiter, authController.renderResetPassword);
router.post('/reset-password', resetPasswordLimiter, express.urlencoded({ extended: true }), authController.postResetPassword);

module.exports = router;
