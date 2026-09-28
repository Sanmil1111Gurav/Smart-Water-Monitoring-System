const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDb } = require('../database');
const { sendUserEmail, sendPasswordResetOTP } = require('./emailService');
const { isValidEmail, validatePasswordComplexity } = require('../middleware/validation');
const { JWT_SECRET } = require('../middleware/auth');
const { ROLES, ERROR_CODES } = require('../utils/constants');

const IS_DEV_MODE = process.env.NODE_ENV !== 'production' && process.env.DEVELOPMENT !== 'false';

/**
 * Get system setup status
 */
async function getSetupStatus() {
  const db = getDb();
  const countRow = await db.get('SELECT COUNT(*) as count FROM users');
  return {
    isInitialSetup: countRow.count === 0,
    initialSetupRequired: countRow.count === 0,
    userCount: countRow.count,
    isDevMode: IS_DEV_MODE
  };
}

/**
 * User Registration
 */
async function registerUser({ name, username, email, password, confirmPassword }) {
  if (!name || !name.trim()) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Please enter your name.' };
  }
  if (!username || !username.trim()) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Please enter a username.' };
  }
  if (!email || !isValidEmail(email)) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Please enter a valid email address.' };
  }
  if (!password) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Please enter a password.' };
  }
  if (password !== confirmPassword) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Passwords do not match.' };
  }

  const passVal = validatePasswordComplexity(password);
  if (!passVal.valid) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: passVal.message };
  }

  const db = getDb();

  const existingUsername = await db.get('SELECT id FROM users WHERE username = ?', [username.trim()]);
  if (existingUsername) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Username is already taken.' };
  }

  const existingEmail = await db.get('SELECT id FROM users WHERE email = ?', [email.trim()]);
  if (existingEmail) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'An account with this email already exists.' };
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const userRole = ROLES.USER;

  await db.run(
    'INSERT INTO users (name, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [name.trim(), email.trim(), username.trim(), passwordHash, userRole]
  );

  return {
    success: true,
    message: 'Account created successfully! You can now sign in with your credentials.'
  };
}

/**
 * User / Admin Login
 */
async function loginUser({ username, password }) {
  if (!username || !password) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Username and password are required.' };
  }

  const db = getDb();
  const user = await db.get('SELECT * FROM users WHERE username = ? OR email = ?', [username.trim(), username.trim()]);
  if (!user) {
    throw { status: 401, code: ERROR_CODES.UNAUTHORIZED, message: 'Invalid email or password.' };
  }

  const passwordMatch = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatch) {
    throw { status: 401, code: ERROR_CODES.UNAUTHORIZED, message: 'Invalid email or password.' };
  }

  const token = jwt.sign(
    { userId: user.id, username: user.username, name: user.name || user.username, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  return {
    success: true,
    token,
    user: { id: user.id, username: user.username, name: user.name || user.username, email: user.email, role: user.role }
  };
}

/**
 * Forgot Password Flow - Generate & Email 6-Digit OTP
 */
async function forgotPassword(email) {
  if (!email || !isValidEmail(email)) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Please enter a valid email address.' };
  }

  const db = getDb();
  const user = await db.get('SELECT id, username, email FROM users WHERE email = ?', [email.trim()]);

  if (user) {
    const randomBuf = crypto.randomBytes(4);
    const otpNum = (randomBuf.readUInt32BE(0) % 900000) + 100000;
    const otp = otpNum.toString();

    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 mins

    await db.run(
      'UPDATE users SET reset_otp_hash = ?, reset_otp_expires_at = ?, reset_otp_attempts = 0, reset_otp_verified = 0 WHERE id = ?',
      [otpHash, expiresAt, user.id]
    );

    const emailSubject = 'SmartWater System - Password Reset OTP';
    const emailText = `Hello ${user.username},\n\nWe received a request to reset your Smart Water Monitoring System password.\n\nYour password reset OTP is:\n${otp}\n\nThis OTP expires in 10 minutes.\n\nIf you did not request this, you can safely ignore this email.`;
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; background-color: #ffffff;">
        <h2 style="color: #0284c7; margin-bottom: 16px;">Password Reset OTP</h2>
        <p style="color: #334155; font-size: 15px;">Hello <strong>${user.username}</strong>,</p>
        <p style="color: #334155; font-size: 15px;">We received a request to reset your Smart Water Monitoring System password.</p>
        <div style="margin: 24px 0; text-align: center; background-color: #f1f5f9; padding: 16px; border-radius: 8px; letter-spacing: 6px;">
          <span style="font-size: 32px; font-weight: bold; color: #0284c7;">${otp}</span>
        </div>
        <p style="color: #64748b; font-size: 14px;">This OTP is valid for <strong>10 minutes</strong>. Do not share this code with anyone.</p>
      </div>
    `;

    const emailResult = await sendPasswordResetOTP({
      userId: user.id,
      userEmail: user.email,
      username: user.username,
      otp
    });

    if (!emailResult.success) {
      console.error(`❌ Password reset OTP email delivery failed for ${user.email}`);
      throw { status: 500, code: ERROR_CODES.INTERNAL_ERROR, message: "We couldn't send the reset instructions right now. Please try again later." };
    }
  }

  // Generic success message to prevent user enumeration
  return {
    success: true,
    message: 'If an account exists for this email, a 6-digit OTP has been sent.'
  };
}

/**
 * Verify OTP
 */
async function verifyOtp({ email, otp }) {
  if (!email || !isValidEmail(email)) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Please enter a valid email address.' };
  }
  if (!otp || typeof otp !== 'string' || !/^\d{6}$/.test(otp.trim())) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Please enter a valid 6-digit OTP.' };
  }

  const otpHash = crypto.createHash('sha256').update(otp.trim()).digest('hex');
  const db = getDb();

  const user = await db.get(
    'SELECT id, reset_otp_hash, reset_otp_expires_at, reset_otp_attempts, reset_otp_verified FROM users WHERE email = ?',
    [email.trim()]
  );

  if (!user || !user.reset_otp_hash) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Invalid or expired OTP. Please request a new code.' };
  }

  if (user.reset_otp_attempts >= 5) {
    await db.run('UPDATE users SET reset_otp_hash = NULL WHERE id = ?', [user.id]);
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Maximum verification attempts exceeded. Please request a new OTP.' };
  }

  if (!user.reset_otp_expires_at || new Date(user.reset_otp_expires_at).getTime() < Date.now()) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'OTP has expired. Please request a new code.' };
  }

  if (user.reset_otp_hash !== otpHash) {
    await db.run('UPDATE users SET reset_otp_attempts = reset_otp_attempts + 1 WHERE id = ?', [user.id]);
    const remaining = 5 - (user.reset_otp_attempts + 1);
    throw {
      status: 400,
      code: ERROR_CODES.INVALID_INPUT,
      message: `Invalid OTP code. ${remaining > 0 ? `${remaining} attempt(s) remaining.` : 'Please request a new code.'}`
    };
  }

  await db.run('UPDATE users SET reset_otp_verified = 1 WHERE id = ?', [user.id]);

  return { success: true, message: 'OTP verified successfully! You can now set your new password.' };
}

/**
 * Reset Password via Verified OTP
 */
async function resetPassword({ email, otp, token, newPassword, confirmPassword }) {
  if (!newPassword) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Please enter a new password.' };
  }
  if (newPassword !== confirmPassword) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Passwords do not match.' };
  }

  const passVal = validatePasswordComplexity(newPassword);
  if (!passVal.valid) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: passVal.message };
  }

  const db = getDb();
  let targetUserId = null;

  if (email && otp) {
    const otpHash = crypto.createHash('sha256').update(otp.trim()).digest('hex');
    const user = await db.get(
      'SELECT id, reset_otp_hash, reset_otp_expires_at, reset_otp_verified FROM users WHERE email = ?',
      [email.trim()]
    );

    if (!user || !user.reset_otp_hash || user.reset_otp_hash !== otpHash || !user.reset_otp_verified) {
      throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Invalid, unverified, or expired OTP session. Please request a new code.' };
    }

    if (new Date(user.reset_otp_expires_at).getTime() < Date.now()) {
      throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'OTP has expired. Please request a new code.' };
    }

    targetUserId = user.id;
  } else if (token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await db.get(
      'SELECT id, reset_token_expires_at, reset_token_used FROM users WHERE reset_token_hash = ?',
      [tokenHash]
    );

    if (!user || user.reset_token_used) {
      throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Invalid or expired password reset token.' };
    }

    if (new Date(user.reset_token_expires_at).getTime() < Date.now()) {
      throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Password reset token has expired. Please request a new link.' };
    }

    targetUserId = user.id;
  } else {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'OTP or reset token is required.' };
  }

  const newPasswordHash = await bcrypt.hash(newPassword, 10);
  const nowIso = new Date().toISOString();

  await db.run(
    `UPDATE users 
     SET password_hash = ?, 
         reset_token_used = 1, 
         reset_otp_hash = NULL, 
         reset_otp_expires_at = NULL, 
         reset_otp_verified = 0, 
         updated_at = ? 
     WHERE id = ?`,
    [newPasswordHash, nowIso, targetUserId]
  );

  return { success: true, message: 'Password reset successfully! You can now sign in with your new password.' };
}

/**
 * Change Password (Admin Authorized)
 */
async function changePassword(userId, userRole, { currentPassword, newPassword, confirmPassword }) {
  if (userRole !== ROLES.ADMIN && userRole !== ROLES.DEVELOPER) {
    throw { status: 403, code: ERROR_CODES.FORBIDDEN, message: 'Forbidden. Admin authorization required to change password.' };
  }

  if (!currentPassword || !newPassword || !confirmPassword) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'All password fields are required.' };
  }

  if (newPassword !== confirmPassword) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'New passwords do not match.' };
  }

  const passVal = validatePasswordComplexity(newPassword);
  if (!passVal.valid) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: passVal.message };
  }

  const db = getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) {
    throw { status: 404, code: ERROR_CODES.NOT_FOUND, message: 'User account not found.' };
  }

  if (user.role !== ROLES.ADMIN && user.role !== ROLES.DEVELOPER) {
    throw { status: 403, code: ERROR_CODES.FORBIDDEN, message: 'Forbidden. Admin authorization required to change password.' };
  }

  const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
  if (!isMatch) {
    throw { status: 400, code: ERROR_CODES.INVALID_INPUT, message: 'Incorrect current password.' };
  }

  const newPasswordHash = await bcrypt.hash(newPassword, 10);
  const nowIso = new Date().toISOString();

  await db.run(
    'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
    [newPasswordHash, nowIso, user.id]
  );

  return { success: true, message: 'Password updated successfully!' };
}

module.exports = {
  getSetupStatus,
  registerUser,
  loginUser,
  forgotPassword,
  verifyOtp,
  resetPassword,
  changePassword,
  IS_DEV_MODE
};
