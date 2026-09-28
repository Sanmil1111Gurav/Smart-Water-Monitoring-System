const { ERROR_CODES } = require('../utils/constants');

/**
 * Standard RFC 5322 Email Validation Helper
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[a-zA-Z0-9._%+-]+@([a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,}$/;
  return emailRegex.test(email.trim());
}

/**
 * Password Complexity Validator
 */
function validatePasswordComplexity(password) {
  if (!password || password.length < 8) {
    return { valid: false, message: 'Password must be at least 8 characters long.' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one uppercase letter.' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one lowercase letter.' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one number.' };
  }
  return { valid: true };
}

/**
 * Strict Threshold Values Validation Helper
 * Must satisfy: 0 <= Low < Full <= Overflow <= 100
 */
function validateThresholdValues(low, full, overflow) {
  if (isNaN(low) || isNaN(full) || isNaN(overflow)) {
    return { valid: false, message: 'All threshold values must be numeric numbers.' };
  }
  if (low < 0 || low > 100 || full < 0 || full > 100 || overflow < 0 || overflow > 100) {
    return { valid: false, message: 'Value must be between 0 and 100%.' };
  }
  if (low >= full || full > overflow) {
    return { valid: false, message: 'Thresholds must follow: Low < Full ≤ Emergency.' };
  }
  return { valid: true };
}

/**
 * In-Memory Rate Limiter Middleware for Auth & OTP endpoints
 */
const rateLimitMap = new Map();

function createRateLimiter(maxRequests = 10, windowMs = 15 * 60 * 1000) {
  return (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'global';
    const key = `${req.path}_${ip}`;
    const now = Date.now();

    const record = rateLimitMap.get(key) || { count: 0, resetTime: now + windowMs };

    if (now > record.resetTime) {
      record.count = 1;
      record.resetTime = now + windowMs;
    } else {
      record.count++;
    }

    rateLimitMap.set(key, record);

    if (record.count > maxRequests) {
      return res.status(429).json({
        success: false,
        error: {
          code: ERROR_CODES.TOO_MANY_REQUESTS,
          message: 'Too many requests. Please try again later.'
        }
      });
    }

    next();
  };
}

module.exports = {
  isValidEmail,
  validatePasswordComplexity,
  validateThresholdValues,
  createRateLimiter
};
