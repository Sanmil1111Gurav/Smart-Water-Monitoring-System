const jwt = require('jsonwebtoken');
const { ROLES, ERROR_CODES } = require('../utils/constants');

const JWT_SECRET = process.env.JWT_SECRET || 'smartwater_jwt_secret_key_2026';

/**
 * Authentication Middleware: Verifies Bearer JWT Token
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: {
        code: ERROR_CODES.UNAUTHORIZED,
        message: 'Unauthorized. Authentication token required.'
      }
    });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      error: {
        code: ERROR_CODES.UNAUTHORIZED,
        message: 'Unauthorized. Invalid or expired authentication token.'
      }
    });
  }
}

/**
 * Role Authorization Middleware: Enforces Admin or Developer Role
 */
function requireAdmin(req, res, next) {
  if (!req.user || (req.user.role !== ROLES.ADMIN && req.user.role !== ROLES.DEVELOPER)) {
    return res.status(403).json({
      success: false,
      error: {
        code: ERROR_CODES.FORBIDDEN,
        message: 'Forbidden. Admin authorization required for this action.'
      }
    });
  }
  next();
}

module.exports = {
  requireAuth,
  requireAdmin,
  JWT_SECRET
};
