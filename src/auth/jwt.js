const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../env');

const MAX_AGE_SECONDS = 60 * 60 * 8; // 8 uur

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: MAX_AGE_SECONDS });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { signToken, verifyToken, MAX_AGE_SECONDS };
