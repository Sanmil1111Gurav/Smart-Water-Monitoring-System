const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const { requireAuth } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/validation');

const loginLimiter = createRateLimiter(5, 15 * 60 * 1000); // 5 attempts per 15 min
const otpLimiter = createRateLimiter(5, 15 * 60 * 1000);   // 5 attempts per 15 min

// Auth Config
router.get('/config', (req, res) => {
  res.json({
    isDevMode: authService.IS_DEV_MODE,
    devCredentials: null
  });
});

// Setup Status
router.get('/setup-status', async (req, res) => {
  try {
    const status = await authService.getSetupStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Server error checking setup status.' } });
  }
});

// Register Account
router.post('/register', async (req, res) => {
  try {
    const result = await authService.registerUser(req.body);
    res.status(201).json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, error: err.message || 'Server error during registration.' });
  }
});

// Login Account
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const result = await authService.loginUser(req.body);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, error: err.message || 'Server authentication error.' });
  }
});

// Forgot Password - Send OTP
router.post('/forgot-password', otpLimiter, async (req, res) => {
  try {
    const result = await authService.forgotPassword(req.body.email);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, error: err.message || 'Error processing forgot password request.' });
  }
});

// Verify OTP
router.post('/verify-otp', otpLimiter, async (req, res) => {
  try {
    const result = await authService.verifyOtp(req.body);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, error: err.message || 'Server error verifying OTP.' });
  }
});

// Reset Password
router.post('/reset-password', async (req, res) => {
  try {
    const result = await authService.resetPassword(req.body);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, error: err.message || 'Server error resetting password.' });
  }
});

// Verify Token
router.get('/verify', requireAuth, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// Change Password (Admin Authorized)
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const result = await authService.changePassword(req.user.userId, req.user.role, req.body);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, error: err.message || 'Server error updating password.' });
  }
});

module.exports = router;
