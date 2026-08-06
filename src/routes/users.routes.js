const express = require('express');
const prisma = require('../db');
const { requireAuth, requireDirectie } = require('../auth/middleware');
const { hashPassword, verifyPassword, tempPassword } = require('../auth/hash');
const { safeUser } = require('../lib/serialize');

const router = express.Router();
const ROLES = ['DIRECTIE', 'FINANCIEEL', 'SCHADEBEHANDELAAR', 'PLANNER'];
const MIN_LENGTE = 10;

async function log(user, text) {
  await prisma.logEntry.create({ data: { text, byUserId: user.id, byName: user.naam } });
}

/* ─────────── eigen wachtwoord ─────────── */
// Iedere ingelogde medewerker mag dit — geen directie nodig.
router.post('/wachtwoord', requireAuth, async (req, res) => {
  const { huidig, nieuw, herhaal } = req.body || {};

  if (!huidig || !nieuw) {
    return res.status(400).json({ error: 'Vul je huidige en je nieuwe wachtwoord in' });
  }
  if (herhaal !== undefined && nieuw !== herhaal) {
    return res.status(400).json({ error: 'De twee nieuwe wachtwoorden zijn niet gelijk' });
  }
  if (String(nieuw).length < MIN_LENGTE) {
    return res.status(400).json({ error: `Je nieuwe wachtwoord moet minstens ${MIN_LENGTE} tekens hebben` });
  }
  if (String(nieuw) === String(huidig)) {
    return res.status(400).json({ error: 'Kies een ander wachtwoord dan je huidige' });
  }

  const klopt = await verifyPassword(String(huidig), req.user.passwordHash);
  if (!klopt) return res.status(403).json({ error: 'Je huidige wachtwoord klopt niet' });

  await prisma.user.update({
    where: { id: req.user.id },
    data: { passwordHash: await hashPassword(String(nieuw)) },
  });
  await log(req.user, 'Eigen wachtwoord gewijzigd');
  res.json({ ok: true });
});

/* ─────────── vanaf hier alleen directie ─────────── */
router.use(requireAuth, requireDirectie);

router.get('/', async (req, res) => {
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
  res.json({ users: users.map(safeUser), rollen: ROLES });
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
    if (e.code === 'P2002') return res.status(409).json({ error: 'Dit e-mailadres is al in gebruik' });
    throw e;
  }
});

router.patch('/:id', async (req, res) => {
  const { naam, email, role, active } = req.body || {};
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Ongeldige rol' });

  // Voorkom dat de laatste directie zichzelf buitensluit.
  if (req.params.id === req.user.id && (role && role !== 'DIRECTIE' || active === false)) {
    const anderen = await prisma.user.count({
      where: { role: 'DIRECTIE', active: true, id: { not: req.user.id } },
    });
    if (!anderen) {
      return res.status(400).json({
        error: 'Je bent de enige actieve directie. Maak eerst iemand anders directie.',
      });
    }
  }

  const data = {};
  if (naam !== undefined) data.naam = String(naam).trim();
  if (email !== undefined) data.email = String(email).toLowerCase().trim();
  if (role !== undefined) data.role = role;
  if (active !== undefined) data.active = !!active;

  try {
    const user = await prisma.user.update({ where: { id: req.params.id }, data });
    await log(req.user, `Gebruiker bijgewerkt: ${user.naam}`);
    res.json({ user: safeUser(user) });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Dit e-mailadres is al in gebruik' });
    throw e;
  }
});

router.post('/:id/reset-password', async (req, res) => {
  const temp = tempPassword();
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { passwordHash: await hashPassword(temp) },
  });
  await log(req.user, `Wachtwoord gereset voor ${user.naam}`);
  res.json({ tempPassword: temp, naam: user.naam });
});

router.delete('/:id', async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Je kunt jezelf niet verwijderen' });
  }
  const doel = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!doel) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
  if (doel.role === 'DIRECTIE') {
    const anderen = await prisma.user.count({
      where: { role: 'DIRECTIE', active: true, id: { not: doel.id } },
    });
    if (!anderen) return res.status(400).json({ error: 'Dit is de laatste directie — verwijderen kan niet' });
  }
  await prisma.user.delete({ where: { id: doel.id } });
  await log(req.user, `Gebruiker verwijderd: ${doel.naam}`);
  res.json({ ok: true });
});

module.exports = router;
