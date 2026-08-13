const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth/middleware');
const { SOORTEN, AANLEIDINGEN, POLISVORMEN, soortenVoor, BIJLAGE_NAAM, stelOp, alsTekst, briefHtml, eur, datumNL } = require('../lib/brieven');
const ai = require('../lib/ai');

const router = express.Router();
router.use(requireAuth);

async function log(user, text) {
  await prisma.logEntry.create({ data: { text, byUserId: user.id, byName: user.naam } });
}

// Zoekt of maakt de akkoordlink bij een offertebrief.
async function koppelOfferte(s, soort) {
  if (soort !== 'offerte' && soort !== 'offerte_rappel') return;
  const { PORTAAL } = require('../lib/brieven');
  let o = await prisma.offerte.findFirst({
    where: { schadeId: s.id, status: 'open' },
    orderBy: { verstuurdAt: 'desc' },
  });
  if (!o && soort === 'offerte') {
    const doc = (s.documenten || []).find((d) => d.soort === 'offerte');
    const geldig = new Date();
    geldig.setDate(geldig.getDate() + Number(process.env.OFFERTE_GELDIG_DAGEN || 30));
    o = await prisma.offerte.create({
      data: {
        schadeId: s.id,
        token: require('crypto').randomBytes(24).toString('base64url'),
        documentId: doc ? doc.id : null,
        bedrag: doc && doc.bedrag ? doc.bedrag : s.amount || null,
        geldigTot: geldig,
      },
    });
  }
  if (!o) return;
  s.offerteLink = `${PORTAAL}/offerte/${o.token}`;
  s.offerteGeldigTot = o.geldigTot;
  s.offerteVerstuurdAt = o.verstuurdAt;
  s.offerteGeopendAt = o.geopendAt;
}

// Zoekt de openstaande afspraak zodat de brief ernaar kan verwijzen.
async function koppelAfspraak(s, soort) {
  if (soort !== 'afspraak_opname' && soort !== 'afspraak_herstel') return;
  const { PORTAAL } = require('../lib/brieven');
  const a = await prisma.afspraak.findFirst({
    where: { schadeId: s.id, soort: soort === 'afspraak_opname' ? 'opname' : 'herstel', status: 'open' },
    orderBy: { verstuurdAt: 'desc' },
  });
  if (!a) return;
  s.afspraakLink = `${PORTAAL}/afspraak/${a.token}`;
  s.afspraakTot = a.geldigTot;
  s.afspraakWat = [a.omschrijving, a.vakman ? `Uitgevoerd door ${a.vakman}.` : null,
    a.duur ? `Reken op ${a.duur}.` : null].filter(Boolean).join(' ');
}

async function dossier(nummer) {
  return prisma.schade.findUnique({
    where: { nummer },
    include: {
      verzekeraar: true,
      tussenpersoonRel: true,
      documenten: { orderBy: { createdAt: 'asc' } },
    },
  });
}

// Welke adressen horen bij dit soort verzending?
function ontvangers(soort, s) {
  const uit = [];
  const zet = (email, label, aan) => {
    if (email && String(email).includes('@')) {
      uit.push({ email: String(email).trim(), label, standaard: !!aan });
    }
  };

  if (soort === 'claim' || soort === 'herinnering') {
    if (s.verzekeraar) {
      zet(s.verzekeraar.email, s.verzekeraar.naam, true);
      (s.verzekeraar.contacten || []).forEach((c) =>
        zet(c.email, `${s.verzekeraar.naam} · ${c.label || 'extra'}`, false)
      );
    }
    if (s.tussenpersoonRel) {
      zet(s.tussenpersoonRel.email, `${s.tussenpersoonRel.naam} (tussenpersoon)`, true);
      (s.tussenpersoonRel.contacten || []).forEach((c) =>
        zet(c.email, `${s.tussenpersoonRel.naam} · ${c.label || 'extra'}`, false)
      );
    }
    zet(s.verzEmail, 'Adres uit het dossier', !uit.length);
  } else if (soort === 'melding_beheerder') {
    zet(s.beheerderEmail, s.opdrachtgever || 'Beheerder', true);
  } else {
    zet(s.email, s.owner || 'Klant', true);
  }
  return uit;
}

/* ─────────── voorbeeld opvragen ─────────── */
router.get('/schades/:nummer/brief', async (req, res) => {
  const soort = String(req.query.soort || 'claim');
  if (!SOORTEN[soort]) return res.status(400).json({ error: 'Onbekend soort verzending' });

  const s = await dossier(req.params.nummer);
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const gekozen = req.query.docs ? String(req.query.docs).split(',').filter(Boolean) : null;
  if (req.query.aanleiding) s.aanleiding = String(req.query.aanleiding);
  await koppelOfferte(s, soort);
  await koppelAfspraak(s, soort);
  if (soort === 'vrij') {
    s.vrijTekst = req.query.tekst || '';
    s.vrijOnderwerp = req.query.onderwerp || '';
  }
  const brief = stelOp(soort, s, s.documenten, gekozen);
  brief.contact = [req.user.naam, req.user.email].filter(Boolean).join(' \u00b7 ');

  // Bestaand concept voor dit soort verzending? Dan die tekst tonen.
  const concept = await prisma.verzending.findFirst({
    where: { schadeId: s.id, soort, status: 'concept' },
    orderBy: { createdAt: 'desc' },
  });

  const ontbreekt = [];
  if (soort === 'claim') {
    if (!s.polisnummer) ontbreekt.push('polisnummer');
    if (!s.verzekeraar && !s.tussenpersoonRel) ontbreekt.push('verzekeraar');
    if (!s.documenten.some((d) => d.soort === 'schaderapport')) ontbreekt.push('schaderapport');
    if (!s.documenten.some((d) => d.soort === 'machtiging')) ontbreekt.push('getekende machtiging');
  }
  if (soort === 'offerte' && !s.email) ontbreekt.push('e-mailadres van de klant');

  res.json({
    brief,
    dossier: {
      nummer: s.nummer, polisnummer: s.polisnummer, oorzaak: s.oorzaak, polisvorm: s.polisvorm,
      opnameAt: s.opnameAt, verzSchadenummer: s.verzSchadenummer,
    },
    tekst: concept && concept.tekst ? concept.tekst : alsTekst(brief, req.user.naam),
    concept: concept
      ? { id: concept.id, bewerkt: true, sinds: concept.createdAt, documentIds: concept.documentIds }
      : null,
    aiBeschikbaar: ai.beschikbaar(),
    herinneringen: await prisma.verzending.count({
      where: { schadeId: s.id, soort: 'herinnering', status: { not: 'concept' } },
    }),
    aanleidingen: Object.entries(AANLEIDINGEN).map(([k, v]) => ({ key: k, label: v })),
    meesturen: soort === 'afronding_eigenaar' ? [
      {
        soort: 'afronding_beheerder',
        label: 'Beheerder',
        naam: s.opdrachtgever || null,
        email: s.beheerderEmail || null,
        uitleg: 'Krijgt hetzelfde bericht dat het werk klaar is.',
        allesMee: false,
      },
    ] : soort === 'herinnering' ? [
      {
        soort: 'update_beheerder',
        label: 'Beheerder',
        naam: s.opdrachtgever || null,
        email: s.beheerderEmail || null,
        uitleg: 'Krijgt bericht dat wij de verzekeraar hebben herinnerd.',
        allesMee: false,
      },
      {
        soort: 'update_eigenaar',
        label: 'Woningeigenaar',
        naam: s.owner || null,
        email: s.email || null,
        uitleg: 'Krijgt hetzelfde bericht, met verwijzing naar het portaal.',
        allesMee: false,
      },
    ] : soort === 'claim' ? [
      {
        soort: 'melding_beheerder',
        label: 'Beheerder',
        naam: s.opdrachtgever || null,
        email: s.beheerderEmail || null,
        uitleg: 'Krijgt hetzelfde bericht met alle stukken.',
        allesMee: true,
      },
      {
        soort: 'melding_eigenaar',
        label: 'Woningeigenaar',
        naam: s.owner || null,
        email: s.email || null,
        uitleg: 'Krijgt alleen een melding met een verwijzing naar het portaal.',
        allesMee: false,
      },
    ] : [],
    ontvangers: ontvangers(soort, s),
    documenten: s.documenten.map((d) => {
      const t = BIJLAGE_NAAM[d.soort] || BIJLAGE_NAAM.overig;
      return {
        id: d.id,
        soort: d.soort,
        bestandsnaam: d.bestandsnaam,
        bedrag: d.bedrag,
        briefnaam: t.naam,
        telt: !!(t.telt && d.bedrag),
        voorstel: gekozen
          ? gekozen.indexOf(d.id) > -1
          : (SOORTEN[soort].bijlagen || []).indexOf(d.soort) > -1,
      };
    }),
    ontbreekt,
    soorten: soortenVoor(s.haltes),
    polisvormen: Object.keys(POLISVORMEN).map((k) => ({ key: k, zin: POLISVORMEN[k] })),
  });
});

/* ─────────── brief als afdrukbare A4 ─────────── */
router.get('/schades/:nummer/brief.html', async (req, res) => {
  const soort = String(req.query.soort || 'claim');
  if (!SOORTEN[soort]) return res.status(400).send('Onbekend soort verzending');

  const s = await dossier(req.params.nummer);
  if (!s) return res.status(404).send('Dossier niet gevonden');

  const gekozen = req.query.docs ? String(req.query.docs).split(',').filter(Boolean) : null;
  if (req.query.aanleiding) s.aanleiding = String(req.query.aanleiding);
  await koppelOfferte(s, soort);
  await koppelAfspraak(s, soort);
  const brief = stelOp(soort, s, s.documenten, gekozen);
  brief.contact = [req.query.namens || req.user.naam, req.user.email].filter(Boolean).join(' \u00b7 ');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const ik = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { handtekening: true, functie: true },
  });
  res.send(briefHtml(
    brief,
    req.query.namens || req.user.naam,
    req.query.functie || (ik && ik.functie) || '',
    ik && ik.handtekening
  ));
});

/* ─────────── concept bewaren ─────────── */
router.post('/schades/:nummer/brief/concept', async (req, res) => {
  const b = req.body || {};
  const soort = SOORTEN[b.soort] ? b.soort : 'claim';
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer }, select: { id: true } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const bestaand = await prisma.verzending.findFirst({
    where: { schadeId: s.id, soort, status: 'concept' },
  });

  const data = {
    onderwerp: String(b.onderwerp || '').slice(0, 300),
    tekst: String(b.tekst || ''),
    documentIds: Array.isArray(b.documentIds) ? b.documentIds : [],
    naar: Array.isArray(b.naar) ? b.naar : [],
    doorNaam: req.user.naam,
  };

  const concept = bestaand
    ? await prisma.verzending.update({ where: { id: bestaand.id }, data })
    : await prisma.verzending.create({ data: { ...data, schadeId: s.id, soort, status: 'concept' } });

  res.json({ concept: { id: concept.id, sinds: concept.createdAt } });
});

router.delete('/schades/:nummer/brief/concept', async (req, res) => {
  const soort = SOORTEN[req.query.soort] ? req.query.soort : 'claim';
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer }, select: { id: true } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });
  // Een weigering sluit het dossier meteen.
  if (soort === 'weigering') {
    await prisma.schade.update({
      where: { id: s.id },
      data: { status: 'geweigerd', archived: true, archivedAt: new Date(), weigerAt: new Date() },
    });
  }

  await prisma.verzending.deleteMany({ where: { schadeId: s.id, soort, status: 'concept' } });
  res.json({ ok: true });
});

/* ─────────── tekst laten bijwerken ─────────── */
router.post('/schades/:nummer/brief/bijwerken', async (req, res) => {
  const b = req.body || {};
  const aanwijzing = String(b.aanwijzing || '').trim();
  const tekst = String(b.tekst || '').trim();
  if (!aanwijzing) return res.status(400).json({ error: 'Schrijf op wat je anders wilt' });
  if (!tekst) return res.status(400).json({ error: 'Er is geen brieftekst om aan te passen' });

  const s = await dossier(req.params.nummer);
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  // Alleen feiten die al vaststaan; de AI mag niets bedenken.
  const feiten = [
    `Dossier: ${s.nummer}`,
    s.adres ? `Adres: ${[s.adres, s.plaats].filter(Boolean).join(', ')}` : null,
    s.owner ? `Klant of VvE: ${s.owner}` : null,
    s.opdrachtgever ? `Opdrachtgever: ${s.opdrachtgever}` : null,
    s.verzekeraar ? `Verzekeraar: ${s.verzekeraar.naam}` : null,
    s.polisnummer ? `Polisnummer: ${s.polisnummer}` : null,
    s.verzSchadenummer ? `Schadenummer verzekeraar: ${s.verzSchadenummer}` : null,
    s.oorzaak ? `Oorzaak volgens schaderapport: ${s.oorzaak}` : null,
    s.opnameAt || s.createdAt ? `Datum opname: ${datumNL(s.opnameAt || s.createdAt)}` : null,
    s.amount ? `Schadebedrag: ${eur(s.amount)}` : null,
  ].filter(Boolean).join('\n');

  try {
    const nieuw = await ai.herschrijf({ tekst, aanwijzing, context: feiten });
    await log(req.user, `Brieftekst bijgewerkt bij ${s.nummer}: "${aanwijzing.slice(0, 80)}"`);
    res.json({ tekst: nieuw });
  } catch (e) {
    if (e.code === 'GEEN_SLEUTEL') {
      return res.status(503).json({
        error: 'Er is nog geen AI-sleutel ingesteld. Zet ANTHROPIC_API_KEY in Coolify en deploy opnieuw.',
      });
    }
    res.status(502).json({ error: e.message });
  }
});

/* ─────────── vrij bericht laten opstellen ─────────── */
router.post('/schades/:nummer/bericht', async (req, res) => {
  const b = req.body || {};
  const notitie = String(b.notitie || '').trim();
  if (!notitie) return res.status(400).json({ error: 'Schrijf op wat je wilt zeggen' });

  const s = await dossier(req.params.nummer);
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const feiten = [
    `Dossier: ${s.nummer}`,
    s.adres ? `Adres: ${[s.adres, s.plaats].filter(Boolean).join(', ')}` : null,
    s.owner ? `Klant of VvE: ${s.owner}` : null,
    s.opdrachtgever ? `Opdrachtgever: ${s.opdrachtgever}` : null,
    s.verzekeraar ? `Verzekeraar: ${s.verzekeraar.naam}` : null,
    s.polisnummer ? `Polisnummer: ${s.polisnummer}` : null,
    s.verzSchadenummer ? `Schadenummer verzekeraar: ${s.verzSchadenummer}` : null,
  ].filter(Boolean).join('\n');

  try {
    const uit = await ai.opstellen({ notitie, ontvanger: b.ontvanger || 'de ontvanger', context: feiten });
    res.json(uit);
  } catch (e) {
    if (e.code === 'GEEN_SLEUTEL') {
      return res.status(503).json({
        error: 'Er is nog geen AI-sleutel ingesteld. Zet ANTHROPIC_API_KEY in Coolify en deploy opnieuw.',
      });
    }
    res.status(502).json({ error: e.message });
  }
});

/* ─────────── een verstuurd bericht teruglezen ─────────── */
router.get('/verzendingen/:id/brief.html', async (req, res) => {
  const v = await prisma.verzending.findUnique({
    where: { id: req.params.id },
    include: { schade: { include: { verzekeraar: true, tussenpersoonRel: true, documenten: true } } },
  });
  if (!v) return res.status(404).send('Bericht niet gevonden');

  const s = v.schade;
  s.vrijTekst = v.tekst;
  s.vrijOnderwerp = v.onderwerp;
  const brief = stelOp(v.soort, s, s.documenten, v.documentIds);
  brief.onderwerp = v.onderwerp || brief.onderwerp;
  brief.titel = v.onderwerp || brief.titel;
  brief.contact = v.doorNaam || '';

  const ik = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { handtekening: true, functie: true },
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(briefHtml(brief, v.doorNaam || req.user.naam, (ik && ik.functie) || '', ik && ik.handtekening));
});

/* ─────────── verzenden ─────────── */
router.post('/schades/:nummer/verzenden', async (req, res) => {
  const b = req.body || {};
  const soort = SOORTEN[b.soort] ? b.soort : 'claim';
  const naar = Array.isArray(b.naar) ? b.naar.filter((e) => String(e).includes('@')) : [];
  if (!naar.length) return res.status(400).json({ error: 'Kies minstens één ontvanger' });

  const s = await dossier(req.params.nummer);
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  // Past deze brief wel bij de route van dit dossier?
  const passend = soortenVoor(s.haltes).map((x) => x.key);
  if (soort !== 'vrij' && !passend.includes(soort)) {
    return res.status(400).json({
      error: `Deze brief hoort niet bij de route van dit dossier. Pas de route aan of kies een andere brief.`,
    });
  }

  await koppelOfferte(s, soort);
  if (soort === 'offerte_rappel') {
    await prisma.offerte.updateMany({
      where: { schadeId: s.id, status: 'open' },
      data: { herinnerdAt: new Date(), herinneringen: { increment: 1 } },
    });
  }

  const bijlagen = Array.isArray(b.documentIds) ? b.documentIds : [];

  const verzending = await prisma.verzending.create({
    data: {
      schadeId: s.id,
      soort,
      naar,
      onderwerp: String(b.onderwerp || '').slice(0, 300),
      tekst: String(b.tekst || ''),
      documentIds: bijlagen,
      status: 'klaar',
      doorNaam: req.user.naam,
    },
  });

  // Meesturen: beheerder en eigenaar krijgen elk hun eigen bericht.
  const kopieen = Array.isArray(b.kopieen) ? b.kopieen : [];
  const extra = [];
  for (const k of kopieen) {
    const kSoort = SOORTEN[k.soort] ? k.soort : null;
    const kNaar = Array.isArray(k.naar) ? k.naar.filter((e) => String(e).includes('@')) : [];
    if (!kSoort || !kNaar.length) continue;

    const kDocs = Array.isArray(k.documentIds) ? k.documentIds : [];
    if (b.aanleiding) s.aanleiding = String(b.aanleiding);
    const kBrief = stelOp(kSoort, s, s.documenten, kDocs);
    const rij = await prisma.verzending.create({
      data: {
        schadeId: s.id,
        soort: kSoort,
        naar: kNaar,
        onderwerp: k.onderwerp || kBrief.onderwerp,
        tekst: k.tekst || alsTekst(kBrief, req.user.naam),
        documentIds: kDocs,
        status: 'klaar',
        doorNaam: req.user.naam,
      },
    });
    extra.push(rij);
  }

  // Bij een claim schuift het dossier mee naar 'ingediend'.
  if (soort === 'claim') {
    const data = { verzStatus: 'ingediend' };
    if (!s.verzIngediendAt) {
      data.verzIngediendAt = new Date();
      data.ingediendAt = new Date();
    }
    const haltes = Array.isArray(s.haltes) ? s.haltes : [];
    if (haltes.includes(5) && s.step < 5) data.step = 5;
    await prisma.schade.update({ where: { id: s.id }, data });
  }

  await prisma.verzending.deleteMany({ where: { schadeId: s.id, soort, status: 'concept' } });
  await log(req.user, `${SOORTEN[soort].label}: ${s.nummer} naar ${naar.join(', ')}`);
  for (const e of extra) {
    await log(req.user, `${SOORTEN[e.soort].label}: ${s.nummer} naar ${e.naar.join(', ')}`);
  }
  res.status(201).json({ verzending, kopieen: extra.length });
});

/* ─────────── verzendhistorie ─────────── */
router.get('/schades/:nummer/verzendingen', async (req, res) => {
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer }, select: { id: true } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });
  const verzendingen = await prisma.verzending.findMany({
    where: { schadeId: s.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ verzendingen });
});

module.exports = router;
