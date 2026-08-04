const express = require('express');
const verifyIntegrity = require('../middleware/verifyIntegrity');
const interpretIntegrity = require('../middleware/interpretIntegrity');
const enforceIntegrity = require('../middleware/enforceIntegrity');
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');
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

router.post('/register', registerLimiter, authController.register);
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
router.post('/google', googleSignInLimiter, authController.googleSignIn);
router.post('/change-password', accountActionLimiter, authMiddleware, authController.changePassword);
router.post('/forgot-password', forgotPasswordLimiter, authController.forgotPassword);
router.get('/status', statusPollLimiter, authController.checkVerificationStatus);
router.post('/resend-verification', emailVerificationLimiter, authController.resendVerification);

// Password reset routes (GET to display form, POST to submit new password) -
// share resetPasswordLimiter's budget, see rateLimiters.js for why.
router.get('/reset-password', resetPasswordLimiter, authController.renderResetPassword);
router.post('/reset-password', resetPasswordLimiter, express.urlencoded({ extended: true }), authController.postResetPassword);

module.exports = router;
