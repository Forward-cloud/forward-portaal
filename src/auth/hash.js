const bcrypt = require('bcryptjs');

const ROUNDS = 12;

async function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

// Kort, leesbaar tijdelijk wachtwoord voor nieuwe/gereset accounts
function tempPassword() {
  return 'FWD-' + Math.floor(1000 + Math.random() * 9000);
}

module.exports = { hashPassword, verifyPassword, tempPassword };
