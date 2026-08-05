const express = require('express');
const prisma = require('../db');
const { requireAuth, isDirectie } = require('../auth/middleware');
const { schadeForUser } = require('../lib/serialize');

const router = express.Router();
router.use(requireAuth);

async function log(user, text) {
  await prisma.logEntry.create({ data: { text, byUserId: user.id, byName: user.naam } });
}

router.get('/', async (req, res) => {
  const schades = await prisma.schade.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ schades: schades.map((s) => schadeForUser(s, req.user)) });
});

router.get('/:nummer', async (req, res) => {
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });
  res.json({ schade: schadeForUser(s, req.user) });
});

router.post('/', async (req, res) => {
  const { nummer, owner, email, adres, ins, amount, traject } = req.body || {};
  if (!nummer || !owner) return res.status(400).json({ error: 'Nummer en eigenaar vereist' });
  try {
    const s = await prisma.schade.create({
      data: {
        nummer: String(nummer).trim(),
        owner: String(owner).trim(),
        email: email || null,
        adres: adres || null,
        ins: ins || null,
        amount: Number(amount) || 0,
        traject: traject || 'volledig',
      },
    });
    await log(req.user, `Schade aangemaakt: ${s.nummer}`);
    res.status(201).json({ schade: schadeForUser(s, req.user) });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Schadenummer bestaat al' });
    throw e;
  }
});

router.patch('/:nummer', async (req, res) => {
  const b = req.body || {};
  const data = {};
  // Operationele velden — alle medewerkers
  ['owner', 'email', 'adres', 'ins', 'status', 'traject'].forEach((k) => {
    if (b[k] !== undefined) data[k] = b[k];
  });
  if (b.amount !== undefined) data.amount = Number(b.amount) || 0;
  if (b.step !== undefined) data.step = Number(b.step) || 1;

  // Financiële velden — ALLEEN directie (server dwingt dit af)
  if (b.fin !== undefined) {
    if (!isDirectie(req.user)) return res.status(403).json({ error: 'Alleen directie mag omzet/marge aanpassen' });
    const f = b.fin || {};
    if (f.expertiseOmzet !== undefined) data.finExpertiseOmzet = Number(f.expertiseOmzet) || 0;
    if (f.herstelOmzet !== undefined) data.finHerstelOmzet = Number(f.herstelOmzet) || 0;
    if (f.herstelInkoop !== undefined) data.finHerstelInkoop = Number(f.herstelInkoop) || 0;
    if (f.herstelUitbesteed !== undefined) data.finHerstelUitbesteed = Number(f.herstelUitbesteed) || 0;
  }

  const s = await prisma.schade.update({ where: { nummer: req.params.nummer }, data });
  res.json({ schade: schadeForUser(s, req.user) });
});

// Zichtbaarheid van een document voor de klant aan/uit
router.patch('/:nummer/documents', async (req, res) => {
  const { document, visible } = req.body || {};
  if (!document) return res.status(400).json({ error: 'document vereist' });
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });
  const dv = { ...(s.docVisible || {}) };
  dv[document] = !!visible;
  const updated = await prisma.schade.update({ where: { nummer: req.params.nummer }, data: { docVisible: dv } });
  res.json({ schade: schadeForUser(updated, req.user) });
});

module.exports = router;
