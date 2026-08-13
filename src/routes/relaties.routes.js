const express = require('express');
const prisma = require('../db');
const { requireAuth, requireDirectie } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

const SOORTEN = ['VERZEKERAAR', 'TUSSENPERSOON', 'ONDERAANNEMER'];

function schoon(b) {
  const d = {};
  ['naam', 'email', 'telefoon', 'adres', 'postcode', 'plaats', 'website', 'contactpersoon', 'notitie']
    .forEach((k) => { if (b[k] !== undefined) d[k] = b[k] ? String(b[k]).trim() : null; });
  if (b.soort !== undefined) {
    const s = String(b.soort).toUpperCase();
    if (!SOORTEN.includes(s)) return { fout: 'Kies verzekeraar of tussenpersoon' };
    d.soort = s;
  }
  if (b.contacten !== undefined) {
    // Vrije lijst met extra e-mailadressen: [{ label, email }]
    var lijst = Array.isArray(b.contacten) ? b.contacten : [];
    d.contacten = lijst
      .map(function (c) {
        return {
          label: String((c && c.label) || '').trim().slice(0, 60),
          email: String((c && c.email) || '').trim().slice(0, 160),
        };
      })
      .filter(function (c) { return c.email; })
      .slice(0, 12);
  }
  if (b.factuurwijze !== undefined) {
    const w = String(b.factuurwijze);
    if (!['per_klus', 'verzamel'].includes(w)) return { fout: 'Kies per klus of verzamelfactuur' };
    d.factuurwijze = w;
  }
  if (b.reactietermijn !== undefined) {
    const n = Number(b.reactietermijn);
    d.reactietermijn = Number.isFinite(n) && n > 0 ? Math.round(n) : 7;
  }
  if (b.actief !== undefined) d.actief = !!b.actief;
  return { data: d };
}

// ?soort=VERZEKERAAR|TUSSENPERSOON   ?q=zoekterm   ?alle=1 (ook inactieve)
router.get('/', async (req, res) => {
  const where = {};
  const soort = String(req.query.soort || '').toUpperCase();
  if (SOORTEN.includes(soort)) where.soort = soort;
  if (!req.query.alle) where.actief = true;
  const q = String(req.query.q || '').trim();
  if (q) {
    where.OR = [
      { naam: { contains: q, mode: 'insensitive' } },
      { contactpersoon: { contains: q, mode: 'insensitive' } },
      { plaats: { contains: q, mode: 'insensitive' } },
    ];
  }
  const relaties = await prisma.relatie.findMany({ where, orderBy: { naam: 'asc' } });
  res.json({ relaties });
});

router.get('/:id', async (req, res) => {
  const r = await prisma.relatie.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { schadesAlsVerzekeraar: true, schadesAlsTussenpersoon: true } } },
  });
  if (!r) return res.status(404).json({ error: 'Niet gevonden' });
  res.json({ relatie: r });
});

router.post('/', requireDirectie, async (req, res) => {
  const { data, fout } = schoon(req.body || {});
  if (fout) return res.status(400).json({ error: fout });
  if (!data.naam) return res.status(400).json({ error: 'Naam is verplicht' });
  if (!data.soort) data.soort = 'VERZEKERAAR';
  try {
    const r = await prisma.relatie.create({ data });
    res.status(201).json({ relatie: r });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Deze naam bestaat al in deze lijst' });
    throw e;
  }
});

router.patch('/:id', requireDirectie, async (req, res) => {
  const { data, fout } = schoon(req.body || {});
  if (fout) return res.status(400).json({ error: fout });
  try {
    const r = await prisma.relatie.update({ where: { id: req.params.id }, data });
    res.json({ relatie: r });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Deze naam bestaat al in deze lijst' });
    throw e;
  }
});

// Niet verwijderen zolang er dossiers aan hangen — dan alleen op inactief zetten.
router.delete('/:id', requireDirectie, async (req, res) => {
  const r = await prisma.relatie.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { schadesAlsVerzekeraar: true, schadesAlsTussenpersoon: true } } },
  });
  if (!r) return res.status(404).json({ error: 'Niet gevonden' });
  const inGebruik = r._count.schadesAlsVerzekeraar + r._count.schadesAlsTussenpersoon;
  if (inGebruik > 0) {
    const uit = await prisma.relatie.update({ where: { id: r.id }, data: { actief: false } });
    return res.json({
      relatie: uit,
      melding: `${r.naam} hangt aan ${inGebruik} dossier(s) en is daarom op inactief gezet in plaats van verwijderd.`,
    });
  }
  await prisma.relatie.delete({ where: { id: r.id } });
  res.json({ verwijderd: true });
});

module.exports = router;
