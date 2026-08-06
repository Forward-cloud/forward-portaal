const express = require('express');
const prisma = require('../db');
const { requireAuth, isDirectie } = require('../auth/middleware');
const { schadeForUser } = require('../lib/serialize');
const { VERSIE, PRESETS, BRON_STATUS, haltesVoorPreset, normaliseerHaltes, leidAfUitKaart, bronBlokkeert, positie } = require('../lib/haltes');

const router = express.Router();
router.use(requireAuth);

async function log(user, text) {
  await prisma.logEntry.create({ data: { text, byUserId: user.id, byName: user.naam } });
}

const PREFIX = 'FS';

// Volgend vrij nummer voor een jaar, afgeleid uit het hoogste bestaande nummer.
async function volgendNummer(jaar) {
  const start = `${PREFIX}-${jaar}-`;
  const laatste = await prisma.schade.findFirst({
    where: { nummer: { startsWith: start } },
    orderBy: { nummer: 'desc' },
    select: { nummer: true },
  });
  let n = 0;
  if (laatste) {
    const staart = laatste.nummer.slice(start.length);
    n = parseInt(staart, 10) || 0;
  }
  return `${start}${String(n + 1).padStart(4, '0')}`;
}

// Zoekt een relatie op naam of maakt hem aan. Lege of nietszeggende waarden geven null.
async function relatieId(naam, soort, email) {
  const n = String(naam == null ? '' : naam).trim();
  if (!n || ['-', 'nee', 'geen', 'nvt', 'n.v.t.'].includes(n.toLowerCase())) return null;
  const bestaand = await prisma.relatie.findFirst({
    where: { naam: { equals: n, mode: 'insensitive' }, soort },
  });
  if (bestaand) return bestaand.id;
  const nieuw = await prisma.relatie.create({
    data: { naam: n, soort, email: email ? String(email).trim() : null },
  });
  return nieuw.id;
}

const datum = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

/* ─────────── lijst ─────────── */
// ?archief=nee|ja|alles   ?q=zoekterm
router.get('/', async (req, res) => {
  const archief = String(req.query.archief || 'nee').toLowerCase();
  const q = String(req.query.q || '').trim();

  const where = {};
  if (archief === 'nee') where.archived = false;
  else if (archief === 'ja') where.archived = true;

  if (q) {
    where.OR = [
      { nummer: { contains: q, mode: 'insensitive' } },
      { owner: { contains: q, mode: 'insensitive' } },
      { adres: { contains: q, mode: 'insensitive' } },
      { plaats: { contains: q, mode: 'insensitive' } },
      { opdrachtnummer: { contains: q, mode: 'insensitive' } },
      { verzSchadenummer: { contains: q, mode: 'insensitive' } },
    ];
    delete where.archived; // zoeken doorzoekt altijd alles, ook archief
  }

  const schades = await prisma.schade.findMany({ where, orderBy: { createdAt: 'desc' } });
  res.json({ schades: schades.map((s) => schadeForUser(s, req.user)) });
});

router.get('/presets', (req, res) => {
  res.json({
    presets: Object.entries(PRESETS).map(([key, p]) => ({ key, label: p.label, haltes: p.haltes })),
  });
});

router.get('/:nummer', async (req, res) => {
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });
  res.json({ schade: schadeForUser(s, req.user) });
});

/* ─────────── aanmaken ─────────── */
router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.owner) return res.status(400).json({ error: 'Eigenaar is verplicht' });

  const jaar = new Date().getFullYear();
  const preset = PRESETS[b.preset] ? b.preset : 'volledig';

  for (let poging = 0; poging < 5; poging++) {
    const nummer = await volgendNummer(jaar);
    try {
      const s = await prisma.schade.create({
        data: {
          nummer,
          owner: String(b.owner).trim(),
          email: b.email || null,
          adres: b.adres || null,
          plaats: b.plaats || null,
          ins: b.ins || null,
          amount: Number(b.amount) || 0,
          preset,
          haltes: haltesVoorPreset(preset),
          traject: b.traject || 'volledig',
          opdrachtnummer: b.opdrachtnummer || null,
          opdrachtgever: b.opdrachtgever || null,
        },
      });
      await log(req.user, `Dossier aangemaakt: ${s.nummer} — ${s.owner}`);
      return res.status(201).json({ schade: schadeForUser(s, req.user) });
    } catch (e) {
      if (e.code === 'P2002') continue; // nummer net vergeven, opnieuw
      throw e;
    }
  }
  res.status(500).json({ error: 'Kon geen vrij schadenummer bepalen' });
});

/* ─────────── bijwerken ─────────── */
router.patch('/:nummer', async (req, res) => {
  const b = req.body || {};
  const data = {};

  ['owner', 'email', 'adres', 'plaats', 'ins', 'status', 'traject',
   'opdrachtnummer', 'opdrachtgever', 'verzSchadenummer', 'verzEmail',
   'tussenpersoon'].forEach((k) => {
    if (b[k] !== undefined) data[k] = b[k] || null;
  });

  ['verzekeraarId', 'tussenpersoonId'].forEach((k) => {
    if (b[k] !== undefined) data[k] = b[k] || null;
  });

  if (b.amount !== undefined) data.amount = Number(b.amount) || 0;
  if (b.step !== undefined) data.step = Number(b.step) || 1;

  if (b.bronDoorReden !== undefined) data.bronDoorReden = b.bronDoorReden || null;
  if (b.gefactureerd !== undefined) data.gefactureerd = !!b.gefactureerd;
  if (b.uitvoeringAt !== undefined) data.uitvoeringAt = datum(b.uitvoeringAt);
  if (b.verzIngediendAt !== undefined) data.verzIngediendAt = datum(b.verzIngediendAt);

  if (b.preset !== undefined) {
    if (!PRESETS[b.preset]) return res.status(400).json({ error: 'Onbekende voorkeuze' });
    data.preset = b.preset;
    data.haltes = haltesVoorPreset(b.preset);
  }
  if (b.haltes !== undefined) data.haltes = normaliseerHaltes(b.haltes);

  // Verzekeraarstatus — afwijzing sluit het dossier
  if (b.verzStatus !== undefined) {
    const geldig = ['geen', 'ingediend', 'akkoord', 'afgewezen', 'doorverwezen'];
    if (!geldig.includes(b.verzStatus)) return res.status(400).json({ error: 'Onbekende verzekeraarstatus' });
    data.verzStatus = b.verzStatus;
    // Indienen zet de indieningsdatum automatisch, tenzij die wordt meegegeven.
    if (b.verzStatus === 'ingediend' && b.verzIngediendAt === undefined) {
      const nu = await prisma.schade.findUnique({
        where: { nummer: req.params.nummer },
        select: { verzIngediendAt: true },
      });
      if (!nu || !nu.verzIngediendAt) {
        data.verzIngediendAt = new Date();
        data.ingediendAt = new Date();
      }
    }
    if (b.verzStatus === 'afgewezen') {
      data.status = 'afgewezen';
      data.archived = true;
      data.archivedAt = new Date();
      data.afwijzingReden = b.afwijzingReden || null;
    }
  }

  // Financiële velden — ALLEEN directie
  if (b.fin !== undefined) {
    if (!isDirectie(req.user)) return res.status(403).json({ error: 'Alleen directie mag omzet/marge aanpassen' });
    const f = b.fin || {};
    if (f.expertiseOmzet !== undefined) data.finExpertiseOmzet = Number(f.expertiseOmzet) || 0;
    if (f.herstelOmzet !== undefined) data.finHerstelOmzet = Number(f.herstelOmzet) || 0;
    if (f.herstelInkoop !== undefined) data.finHerstelInkoop = Number(f.herstelInkoop) || 0;
    if (f.herstelUitbesteed !== undefined) data.finHerstelUitbesteed = Number(f.herstelUitbesteed) || 0;
  }

  // Verandert de route? Zak dan terug naar de dichtstbijzijnde halte die nog bestaat.
  if (data.haltes !== undefined) {
    const huidig = await prisma.schade.findUnique({ where: { nummer: req.params.nummer } });
    if (!huidig) return res.status(404).json({ error: 'Dossier niet gevonden' });
    const doel = data.step !== undefined ? data.step : huidig.step;
    if (!data.haltes.includes(Number(doel))) {
      const lager = data.haltes.filter((h) => h < Number(doel));
      data.step = lager.length ? lager[lager.length - 1] : data.haltes[0];
    }
  }

  if (data.step !== undefined) {
    const huidig = await prisma.schade.findUnique({ where: { nummer: req.params.nummer } });
    if (!huidig) return res.status(404).json({ error: 'Dossier niet gevonden' });
    const blok = bronBlokkeert(
      { ...huidig, ...data, bronDoorReden: data.bronDoorReden !== undefined ? data.bronDoorReden : huidig.bronDoorReden },
      data.step
    );
    if (blok) return res.status(409).json({ error: blok, bronWaarschuwing: true });
  }

  const s = await prisma.schade.update({ where: { nummer: req.params.nummer }, data });
  res.json({ schade: schadeForUser(s, req.user) });
});

/* ─────────── bronherstel ─────────── */
router.post('/:nummer/bron', async (req, res) => {
  const { status, opmerking } = req.body || {};
  if (!BRON_STATUS[status]) return res.status(400).json({ error: 'Onbekende bronstatus' });
  if (status === 'onvoldoende' && !(opmerking && String(opmerking).trim())) {
    return res.status(400).json({ error: 'Beschrijf wat er niet goed is aan het bronherstel' });
  }
  const data = {
    bronStatus: status,
    bronOpmerking: opmerking ? String(opmerking).trim() : null,
    bronHersteldAt: status === 'hersteld' ? new Date() : null,
  };
  if (status !== 'onvoldoende') data.bronDoorReden = null;

  const s = await prisma.schade.update({ where: { nummer: req.params.nummer }, data });
  await log(req.user, `Bron ${BRON_STATUS[status].toLowerCase()}: ${s.nummer}` + (data.bronOpmerking ? ` — ${data.bronOpmerking}` : ''));
  res.json({ schade: schadeForUser(s, req.user) });
});

/* ─────────── wachtstand ─────────── */
router.post('/:nummer/wacht', async (req, res) => {
  const { reden, tot } = req.body || {};
  if (!reden || !String(reden).trim()) {
    return res.status(400).json({ error: 'Geef een reden op, zodat je collega weet waarom dit stilligt' });
  }
  const s = await prisma.schade.update({
    where: { nummer: req.params.nummer },
    data: { wachtReden: String(reden).trim(), wachtTot: datum(tot) },
  });
  await log(req.user, `In de wacht: ${s.nummer} — ${s.wachtReden}`);
  res.json({ schade: schadeForUser(s, req.user) });
});

router.delete('/:nummer/wacht', async (req, res) => {
  const s = await prisma.schade.update({
    where: { nummer: req.params.nummer },
    data: { wachtReden: null, wachtTot: null },
  });
  await log(req.user, `Weer opgepakt: ${s.nummer}`);
  res.json({ schade: schadeForUser(s, req.user) });
});

/* ─────────── archief ─────────── */
router.post('/:nummer/archief', async (req, res) => {
  const s = await prisma.schade.update({
    where: { nummer: req.params.nummer },
    data: { archived: true, archivedAt: new Date() },
  });
  await log(req.user, `Gearchiveerd: ${s.nummer}`);
  res.json({ schade: schadeForUser(s, req.user) });
});

router.delete('/:nummer/archief', async (req, res) => {
  const s = await prisma.schade.update({
    where: { nummer: req.params.nummer },
    data: { archived: false, archivedAt: null },
  });
  await log(req.user, `Uit archief gehaald: ${s.nummer}`);
  res.json({ schade: schadeForUser(s, req.user) });
});

/* ─────────── documentzichtbaarheid ─────────── */
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

/* ─────────── import vanuit de schadekaart ─────────── */
// Body: { rijen: [...], drooploop: true|false }
// Bestaat er al een dossier met hetzelfde opdrachtnummer, dan wordt het bijgewerkt.
router.post('/import', async (req, res) => {
  if (!isDirectie(req.user)) return res.status(403).json({ error: 'Alleen directie mag importeren' });

  const rijen = Array.isArray(req.body && req.body.rijen) ? req.body.rijen : [];
  if (!rijen.length) return res.status(400).json({ error: 'Geen regels ontvangen' });
  const droogloop = !!(req.body && req.body.droogloop);

  // Oudste eerst, zodat de nummering chronologisch loopt.
  const gesorteerd = rijen.slice().sort((a, b) => {
    const da = datum(a.ingediendAt), db = datum(b.ingediendAt);
    if (da && db) return da - db;
    if (da) return -1;
    if (db) return 1;
    return 0;
  });

  const resultaat = { versie: VERSIE, nieuw: 0, bijgewerkt: 0, overgeslagen: 0, regels: [] };

  for (const r of gesorteerd) {
    const owner = String(r.owner || '').trim();
    const adres = String(r.adres || '').trim();
    if (!owner && !adres) {
      resultaat.overgeslagen++;
      resultaat.regels.push({ adres, status: 'overgeslagen', reden: 'geen opdrachtgever of adres' });
      continue;
    }

    const afgeleid = leidAfUitKaart(r);
    const ing = datum(r.ingediendAt);
    const jaar = ing ? ing.getFullYear() : new Date().getFullYear();

    const velden = {
      owner: owner || adres,
      adres: adres || null,
      plaats: r.plaats || null,
      ins: r.ins || null,
      amount: Math.round(Number(r.amount) || 0),
      opdrachtnummer: r.opdrachtnummer ? String(r.opdrachtnummer).trim() : null,
      opdrachtgever: r.opdrachtgever || null,
      verzEmail: r.verzEmail || null,
      tussenpersoon: r.tussenpersoon || null,
      verzSchadenummer: r.verzSchadenummer ? String(r.verzSchadenummer).trim() : null,
      verzIngediendAt: ing,
      ingediendAt: ing,
      uitvoeringAt: datum(r.uitvoeringAt),
      gefactureerd: afgeleid.step >= 9,
      preset: afgeleid.preset,
      haltes: afgeleid.haltes,
      step: afgeleid.step,
      verzStatus: afgeleid.verzStatus,
      bronStatus: afgeleid.bronStatus,
      traject: afgeleid.preset === 'expertise' ? 'expertise' : 'volledig',
    };

    // Verzekeraar en tussenpersoon koppelen aan de adreslijst (aanmaken als ze nog niet bestaan)
    if (!droogloop) {
      velden.verzekeraarId = await relatieId(r.ins, 'VERZEKERAAR');
      velden.tussenpersoonId = await relatieId(r.tussenpersoon, 'TUSSENPERSOON', r.verzEmail);
    }

    const bestaand = velden.opdrachtnummer
      ? await prisma.schade.findFirst({ where: { opdrachtnummer: velden.opdrachtnummer } })
      : null;

    if (bestaand) {
      if (!droogloop) await prisma.schade.update({ where: { id: bestaand.id }, data: velden });
      resultaat.bijgewerkt++;
      resultaat.regels.push({ nummer: bestaand.nummer, adres, status: 'bijgewerkt', halte: afgeleid.step, preset: afgeleid.preset, positie: afgeleid.haltes.indexOf(afgeleid.step) + 1, totaal: afgeleid.haltes.length });
      continue;
    }

    const nummer = droogloop ? `${PREFIX}-${jaar}-????` : await volgendNummer(jaar);
    if (!droogloop) {
      await prisma.schade.create({ data: { nummer, ...velden } });
    }
    resultaat.nieuw++;
    resultaat.regels.push({ nummer, adres, status: 'nieuw', halte: afgeleid.step, preset: afgeleid.preset, positie: afgeleid.haltes.indexOf(afgeleid.step) + 1, totaal: afgeleid.haltes.length });
  }

  if (!droogloop) {
    await log(req.user, `Import schadekaart: ${resultaat.nieuw} nieuw, ${resultaat.bijgewerkt} bijgewerkt`);
  }
  res.json(resultaat);
});

module.exports = router;
