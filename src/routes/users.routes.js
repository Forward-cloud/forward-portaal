const express = require('express');
const prisma = require('../db');
const { requireAuth, requireDirectie } = require('../auth/middleware');
const { hashPassword, tempPassword } = require('../auth/hash');
const { safeUser } = require('../lib/serialize');

const router = express.Router();
const ROLES = ['DIRECTIE', 'FINANCIEEL', 'SCHADEBEHANDELAAR', 'PLANNER'];

async function log(user, text) {
  await prisma.logEntry.create({ data: { text, byUserId: user.id, byName: user.naam } });
}

// Alle gebruikersroutes: alleen directie
router.use(requireAuth, requireDirectie);

router.get('/', async (req, res) => {
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
  res.json({ users: users.map(safeUser) });
});

router.post('/', async (req, res) => {
  const { naam, email, role } = req.body || {};
  if (!naam || !email) return res.status(400).json({ error: 'Naam en e-mail vereist' });
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Ongeldige rol' });
  const temp = tempPassword();
  try {
    const user = await prisma.user.create({
      data: {
        naam: String(naam).trim(),
        email: String(email).toLowerCase().trim(),
        role: role || 'SCHADEBEHANDELAAR',
        passwordHash: await hashPassword(temp),
      },
    });
    await log(req.user, `Gebruiker toegevoegd: ${user.naam}`);
    res.status(201).json({ user: safeUser(user), tempPassword: temp });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'E-mail bestaat al' });
    throw e;
  }
});

router.patch('/:id', async (req, res) => {
  const { naam, email, role, active } = req.body || {};
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Ongeldige rol' });
  const data = {};
  if (naam !== undefined) data.naam = String(naam).trim();
  if (email !== undefined) data.email = String(email).toLowerCase().trim();
  if (role !== undefined) data.role = role;
  if (active !== undefined) data.active = !!active;
  const user = await prisma.user.update({ where: { id: req.params.id }, data });
  await log(req.user, `Gebruiker bijgewerkt: ${user.naam}`);
  res.json({ user: safeUser(user) });
});

router.post('/:id/reset-password', async (req, res) => {
  const temp = tempPassword();
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { passwordHash: await hashPassword(temp) },
  });
  await log(req.user, `Wachtwoord gereset voor ${user.naam}`);
  res.json({ tempPassword: temp });
});

router.delete('/:id', async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Je kunt jezelf niet verwijderen' });
  const user = await prisma.user.delete({ where: { id: req.params.id } });
  await log(req.user, `Gebruiker verwijderd: ${user.naam}`);
  res.json({ ok: true });
});

module.exports = router;
