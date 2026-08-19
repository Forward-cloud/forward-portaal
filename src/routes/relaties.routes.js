const express = require('express');
const prisma = require('../db');
const { requireAuth, requireDirectie } = require('../auth/middleware');
const cat = require('../lib/categorieen');

const router = express.Router();
router.use(requireAuth);

const SOORTEN = ['VERZEKERAAR', 'TUSSENPERSOON', 'ONDERAANNEMER', 'LEVERANCIER'];

function schoon(b) {
  const d = {};
  ['naam', 'email', 'telefoon', 'adres', 'postcode', 'plaats', 'website', 'contactpersoon', 'notitie',
   'postAdres', 'postPostcode', 'postPlaats', 'kvk', 'btwNummer', 'iban']
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
  // Waar deze leverancier voor gebeld wordt. Zonder vakgebied verschijnt hij
  // niet bij het maken van een opdrachtbon of prijsaanvraag.
  if (b.vakken !== undefined) {
    // Oude namen worden omgezet, eigen categorieën krijgen een nette sleutel.
    d.vakken = Array.from(new Set(
      (Array.isArray(b.vakken) ? b.vakken : [])
        .map((v) => cat.normaliseer(v))
        .filter((v) => cat.geldig(v))
    )).slice(0, 20);
  }
  if (b.btwVerlegd !== undefined) d.btwVerlegd = !!b.btwVerlegd;
  return { data: d };
}

/* De lijst met categorieën: de vaste lijst plus alles wat er in de praktijk
   al bij een relatie is gezet. Zo verschijnt een eigen categorie vanzelf bij
   de volgende partij die je toevoegt. */
router.get('/categorieen', async (req, res) => {
  const relaties = await prisma.relatie.findMany({ select: { vakken: true } });
  const gebruikt = new Set();
  relaties.forEach((r) => (r.vakken || []).forEach((v) => gebruikt.add(cat.normaliseer(v))));

  const vast = Object.keys(cat.CATEGORIEEN).map((k) => ({ key: k, label: cat.CATEGORIEEN[k], vast: true }));
  const eigen = Array.from(gebruikt)
    .filter((k) => !cat.CATEGORIEEN[k] && cat.geldig(k))
    .sort()
    .map((k) => ({ key: k, label: cat.label(k), vast: false }));

  res.json({ categorieen: vast.concat(eigen) });
});

// ?soort=VERZEKERAAR|TUSSENPERSOON   ?q=zoekterm   ?alle=1 (ook inactieve)
router.get('/', async (req, res) => {
  const where = {};
  const gevraagd = String(req.query.soort || '').toUpperCase().split(',').map((x) => x.trim()).filter(Boolean);
  const geldig = gevraagd.filter((x) => SOORTEN.includes(x));
  if (geldig.length === 1) where.soort = geldig[0];
  else if (geldig.length > 1) where.soort = { in: geldig };
  if (!req.query.alle) where.actief = true;
  const q = String(req.query.q || '').trim();
  if (q) {
    where.OR = [
      { naam: { contains: q, mode: 'insensitive' } },
      { contactpersoon: { contains: q, mode: 'insensitive' } },
      { plaats: { contains: q, mode: 'insensitive' } },
    ];
  }
  const relaties = await prisma.relatie.findMany({
    where,
    orderBy: [{ geblokkeerd: 'asc' }, { naam: 'asc' }],
  });
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

/* ─────────── blokkeren ───────────
   Een geblokkeerde partij blijft in het adresboek staan — je wilt de
   geschiedenis houden — maar krijgt geen opdrachten meer. Alleen directie. */
router.post('/:id/blokkade', requireDirectie, async (req, res) => {
  const r = await prisma.relatie.findUnique({ where: { id: req.params.id } });
  if (!r) return res.status(404).json({ error: 'Relatie niet gevonden' });

  const aan = req.body?.geblokkeerd !== false;
  const reden = String(req.body?.reden || '').trim();
  if (aan && !reden) {
    return res.status(400).json({ error: 'Leg vast waarom deze partij geen opdrachten meer krijgt' });
  }

  const uit = await prisma.relatie.update({
    where: { id: r.id },
    data: aan
      ? { geblokkeerd: true, blokkadeReden: reden,
          geblokkeerdAt: new Date(), geblokkeerdDoor: req.user.naam }
      : { geblokkeerd: false, blokkadeReden: null, geblokkeerdAt: null, geblokkeerdDoor: null },
  });

  await prisma.logEntry.create({
    data: {
      text: aan ? `${r.naam} geblokkeerd voor nieuwe opdrachten`
                : `Blokkade opgeheven voor ${r.naam}`,
      detail: aan ? reden : null,
      soort: 'relatie', intern: true,
      byUserId: req.user.id, byName: req.user.naam,
    },
  });

  res.json({ relatie: uit });
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
