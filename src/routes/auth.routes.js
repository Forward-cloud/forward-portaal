const express = require('express');
const prisma = require('../db');
const { verifyPassword } = require('../auth/hash');
const { signToken, MAX_AGE_SECONDS } = require('../auth/jwt');
const { requireAuth } = require('../auth/middleware');
const { safeUser } = require('../lib/serialize');
const { COOKIE_SECURE } = require('../env');

const router = express.Router();

function setAuthCookie(res, user) {
  const token = signToken({ sub: user.id, role: user.role });
  res.cookie('token', token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SECURE ? 'none' : 'lax',
    maxAge: MAX_AGE_SECONDS * 1000,
    path: '/',
  });
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'E-mail en wachtwoord vereist' });
  const user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase().trim() } });
  const okPass = user && (await verifyPassword(password, user.passwordHash));
  if (!user || !okPass || !user.active) {
    return res.status(401).json({ error: 'Onjuiste inloggegevens' });
  }
  setAuthCookie(res, user);
  res.json({ user: safeUser(user) });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token', { path: '/' });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: safeUser(req.user) });
});

module.exports = router;
