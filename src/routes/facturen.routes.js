const express = require('express');
const prisma = require('../db');
const { requireAuth, isDirectie } = require('../auth/middleware');
const jortt = require('../lib/jortt');
const { isTest } = require('../lib/testmodus');
const { isZakelijk } = require('../lib/haltes');

const router = express.Router();
router.use(requireAuth);

// Facturen maken we hier, jortt verstuurt ze en kent het nummer toe.
// Alleen directie mag hierbij; een schadebehandelaar hoort geen facturen
// de deur uit te doen.

function alleenDirectie(req, res, next) {
  if (req.user && req.user.role === 'OPLEIDING') {
    return res.status(403).json({
      error: 'In de opleidingsomgeving zijn geen facturen beschikbaar.',
    });
  }
  if (!isDirectie(req.user)) {
    return res.status(403).json({ error: 'Alleen directie kan facturen opstellen.' });
  }
  next();
}
router.use(alleenDirectie);

async function log(user, text, schadeId, detail) {
  await prisma.logEntry.create({
    data: {
      text,
      detail: detail || null,
      soort: 'financieel',
      schadeId: schadeId || null,
      byUserId: user.id,
      byName: user.naam,
    },
  });
}

const cent = (v) => Math.round(Number(String(v ?? '').replace(',', '.')) * 100) || 0;
const eur = (c) => `\u20ac ${((c || 0) / 100).toLocaleString('nl-NL', { minimumFractionDigits: 2 })}`;

// Bedragen staan bij ons in centen. De btw rekenen we per tarief uit, want
// arbeid aan een woning ouder dan twee jaar valt onder 9% en materiaal onder 21%.
function reken(f) {
  const regels = Array.isArray(f.regels) ? f.regels : [];
  let sub = 0;
  const btw = {};

  regels.forEach((r) => {
    const bedrag = (Number(r.aantal) || 0) * cent(r.prijs);
    const tarief = f.btwVerlegd ? 0 : Number(r.btw) || 0;
    if (f.bedragenIncl && tarief) {
      const netto = Math.round(bedrag / (1 + tarief / 100));
      sub += netto;
      btw[tarief] = (btw[tarief] || 0) + (bedrag - netto);
      return;
    }
    sub += bedrag;
    btw[tarief] = (btw[tarief] || 0) + Math.round((bedrag * tarief) / 100);
  });

  // Een korting gaat evenredig van alles af, dus ook van de btw.
  const k = f.korting || {};
  let korting = 0;
  if (k.soort === 'procent') korting = Math.round((sub * Math.min(Number(k.waarde) || 0, 100)) / 100);
  if (k.soort === 'bedrag') korting = Math.min(cent(k.waarde), sub);
  if (korting) {
    const deel = 1 - korting / sub;
    sub -= korting;
    Object.keys(btw).forEach((t) => { btw[t] = Math.round(btw[t] * deel); });
  }

  const btwBedrag = Object.values(btw).reduce((a, b) => a + b, 0);
  return { sub, btw, btwBedrag, korting, totaal: sub + btwBedrag };
}

// Jortt verstuurt niet zonder volledig adres. Bij een particulier is alleen
// een naam en een land verplicht.
function watMist(f) {
  const mist = [];
  if (!String(f.aanNaam || '').trim()) mist.push('naam van de klant');
  if ((f.aanSoort || 'bedrijf') === 'bedrijf') {
    if (!String(f.aanStraat || '').trim()) mist.push('straat en huisnummer');
    if (!String(f.aanPostcode || '').trim()) mist.push('postcode');
    if (!String(f.aanPlaats || '').trim()) mist.push('plaats');
  }
  if (!String(f.aanLand || '').trim()) mist.push('land');
  if (!String(f.aanEmail || '').trim()) mist.push('e-mailadres');
  const regels = Array.isArray(f.regels) ? f.regels : [];
  if (!regels.some((r) => r.omschrijving && cent(r.prijs))) mist.push('minstens \u00e9\u00e9n factuurregel');
  return mist;
}

function schoon(b) {
  const d = {};
  const tekst = [
    'aan', 'aanSoort', 'aanNaam', 'aanTav', 'aanStraat', 'aanPostcode', 'aanPlaats',
    'aanLand', 'aanExtra', 'aanKvk', 'aanEmail', 'aanhef', 'ccEmails',
    'verkooporder', 'inkooporder', 'leverMaand', 'leverTot', 'intro', 'notitie',
  ];
  tekst.forEach((k) => { if (b[k] !== undefined) d[k] = b[k] ? String(b[k]).trim() : null; });

  if (b.datum !== undefined) d.datum = b.datum ? new Date(b.datum) : new Date();
  if (b.termijn !== undefined) d.termijn = Math.max(0, Math.min(Number(b.termijn) || 14, 120));
  if (b.btwVerlegd !== undefined) d.btwVerlegd = !!b.btwVerlegd;
  if (b.bedragenIncl !== undefined) d.bedragenIncl = !!b.bedragenIncl;
  if (b.regels !== undefined) d.regels = Array.isArray(b.regels) ? b.regels : [];
  if (b.korting !== undefined) d.korting = b.korting || null;
  return d;
}

/* ─────────── lijst ─────────── */
router.get('/schades/:nummer/facturen', async (req, res) => {
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer }, select: { id: true } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const facturen = await prisma.factuur.findMany({
    where: { schadeId: s.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ facturen, jorttGekoppeld: jortt.aan() });
});

/* ─────────── testen of de koppeling werkt ───────────
   Haalt alleen je bedrijfsgegevens op. Geen factuur, geen risico. */
router.get('/jortt/test', async (req, res) => {
  if (!jortt.aan()) {
    return res.status(400).json({
      error: 'Jortt is niet gekoppeld. Zet JORTT_CLIENT_ID en JORTT_CLIENT_SECRET in Coolify.',
    });
  }
  // Eerst inloggen, dan pas de gegevens opvragen. Zo zie je meteen of het
  // aan de sleutels ligt of aan de rechten.
  let token;
  try {
    token = await jortt.tokenTest();
  } catch (e) {
    // Lukt inloggen niet, dan lopen we de rechten één voor één langs. Zo zie
    // je meteen welk vinkje in jortt ontbreekt of anders heet.
    let rechten = null;
    try { rechten = await jortt.scopeTest(); } catch (x) { rechten = null; }
    return res.status(502).json({ stap: 'inloggen', error: e.message, rechten });
  }

  // De bedrijfsgegevens zijn een extraatje. Lukt dat niet, dan werkt het
  // factureren gewoon -- jortt zet die gegevens zelf op de factuur.
  let bedrijf = null;
  let bedrijfFout = null;
  try {
    bedrijf = await jortt.bedrijf();
  } catch (e) {
    bedrijfFout = e.message;
  }

  res.json({
    ok: true,
    ingelogd: true,
    token,
    bedrijf,
    bedrijfFout,
    klaarOmTeFactureren: true,
  });
});

/* ─────────── nieuwe factuur ───────────
   Zoveel mogelijk uit het dossier halen: bij een zakelijke opdrachtgever de
   beheerder, bij een particulier de eigenaar op het schadeadres. */
router.post('/schades/:nummer/facturen', async (req, res) => {
  const s = await prisma.schade.findUnique({
    where: { nummer: req.params.nummer },
    include: {
      locaties: { orderBy: [{ hoofd: 'desc' }, { volgorde: 'asc' }] },
      verzekeraar: true,
    },
  });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const aan = String(req.body?.aan || (s.opdrachtgever ? 'beheerder' : 'klant'));
  const adr = s.locaties[0] || {};
  const zakelijk = isZakelijk(s);   // vve of bedrijf: factuur op naam van de organisatie

  let klant;
  if (aan === 'verzekeraar' && s.verzekeraar) {
    klant = { soort: 'bedrijf', naam: s.verzekeraar.naam, tav: s.verzekeraar.contactpersoon || '',
      straat: '', postcode: '', plaats: '', email: s.verzekeraar.email || '' };
  } else if (aan === 'beheerder' && s.opdrachtgever) {
    klant = { soort: 'bedrijf', naam: s.opdrachtgever, tav: s.contactpersoon || '',
      straat: '', postcode: '', plaats: '', email: s.beheerderEmail || '' };
  } else {
    klant = {
      soort: zakelijk ? 'bedrijf' : 'particulier',
      naam: s.owner,
      tav: zakelijk ? s.contactpersoon || '' : '',
      straat: zakelijk ? '' : adr.adres || s.adres || '',
      postcode: adr.postcode || s.postcode || '',
      plaats: zakelijk ? '' : adr.plaats || s.plaats || '',
      email: s.email || '',
    };
  }

  // Arbeid en materiaal apart, want die vallen onder een ander btw-tarief.
  const omzet = s.finHerstelOmzet || 0;
  const inkoop = s.finHerstelInkoop || 0;
  const expertise = s.finExpertiseOmzet || 0;
  const regels = [];
  if (omzet) {
    regels.push({
      omschrijving: `Herstelwerkzaamheden ${adr.adres || s.adres || ''} \u2014 arbeid`,
      aantal: 1, prijs: (Math.max(0, omzet - inkoop) / 100).toFixed(2), btw: 9,
    });
    if (inkoop) regels.push({ omschrijving: 'Materiaal', aantal: 1, prijs: (inkoop / 100).toFixed(2), btw: 21 });
  }
  if (expertise) {
    regels.push({
      omschrijving: 'Schade-expertise en rapportage',
      aantal: 1, prijs: (expertise / 100).toFixed(2), btw: 21,
    });
  }
  if (!regels.length) regels.push({ omschrijving: '', aantal: 1, prijs: '0', btw: 21 });

  const nu = new Date();
  const factuur = await prisma.factuur.create({
    data: {
      schadeId: s.id,
      datum: nu,
      termijn: jortt.BETAALTERMIJN,
      aan,
      aanSoort: klant.soort,
      aanNaam: klant.naam,
      aanTav: klant.tav || null,
      aanStraat: klant.straat || null,
      aanPostcode: klant.postcode || null,
      aanPlaats: klant.plaats || null,
      aanLand: 'Nederland',
      aanEmail: klant.email || null,
      aanhef: klant.soort === 'particulier'
        ? `Beste ${String(klant.naam).replace(/^(Familie|Fam\.)\s+/i, (m) => m.toLowerCase())},`
        : 'Geachte heer, mevrouw,',
      verkooporder: s.nummer,
      inkooporder: s.opdrachtnummer || null,
      leverMaand: nu.toISOString().slice(0, 7),
      regels,
      doorNaam: req.user.naam,
    },
  });

  res.status(201).json({ factuur, totalen: reken(factuur), mist: watMist(factuur) });
});

/* ─────────── bijwerken ─────────── */
router.patch('/facturen/:id', async (req, res) => {
  const nu = await prisma.factuur.findUnique({ where: { id: req.params.id } });
  if (!nu) return res.status(404).json({ error: 'Factuur niet gevonden' });
  if (nu.status !== 'concept') {
    return res.status(400).json({ error: 'Een verstuurde factuur kun je niet meer wijzigen.' });
  }

  const factuur = await prisma.factuur.update({
    where: { id: nu.id },
    data: schoon(req.body || {}),
  });
  const t = reken(factuur);

  await prisma.factuur.update({
    where: { id: factuur.id },
    data: { subtotaal: t.sub, btwBedrag: t.btwBedrag, totaal: t.totaal },
  });

  res.json({ factuur: { ...factuur, subtotaal: t.sub, btwBedrag: t.btwBedrag, totaal: t.totaal },
    totalen: t, mist: watMist(factuur) });
});

/* ─────────── versturen via jortt ───────────
   Jortt maakt het nummer, de pdf op jullie briefpapier en de mail. */
router.post('/facturen/:id/versturen', async (req, res) => {
  const f = await prisma.factuur.findUnique({
    where: { id: req.params.id },
    include: { schade: { select: { id: true, nummer: true, test: true } } },
  });
  if (!f) return res.status(404).json({ error: 'Factuur niet gevonden' });
  if (f.status !== 'concept') return res.status(400).json({ error: 'Deze factuur is al verstuurd.' });

  const mist = watMist(f);
  if (mist.length) return res.status(400).json({ error: `Nog nodig: ${mist.join(', ')}.` });

  // Uit een testdossier gaat nooit een echte factuur de deur uit. Jortt mailt
  // hem meteen naar de klant, en dat is niet terug te draaien.
  if (isTest(f.schade)) {
    return res.status(400).json({
      error: 'Dit is een testdossier. Een factuur wordt hier niet echt verstuurd \u2014 ' +
        'gebruik Voorbeeld om te zien hoe hij eruitziet.',
    });
  }

  if (!jortt.aan()) return res.status(400).json({ error: 'Jortt is niet gekoppeld.' });

  const t = reken(f);
  const versturen = req.body?.concept !== true;

  let uit;
  try {
    uit = await jortt.zetFactuur(
      {
        ...f,
        schadeNummer: f.schade.nummer,
        regels: (f.regels || []).map((r) => ({
          omschrijving: r.omschrijving, aantal: r.aantal, prijs: cent(r.prijs), btw: r.btw,
        })),
      },
      {
        naam: f.aanNaam,
        soort: f.aanSoort,
        email: f.aanEmail,
        adres: f.aanStraat,
        postcode: f.aanPostcode,
        plaats: f.aanPlaats,
        telefoon: null,
        contactpersoon: f.aanTav,
        btwNummer: null,
      },
      versturen
    );
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  // Het nummer bestaat pas als jortt de factuur echt heeft verstuurd.
  let terug = null;
  try {
    terug = await jortt.leesFactuur(uit.jorttId);
  } catch (e) {
    terug = null;
  }

  const factuur = await prisma.factuur.update({
    where: { id: f.id },
    data: {
      jorttId: uit.jorttId,
      nummer: terug?.nummer || null,
      jorttStatus: terug?.status || null,
      status: versturen ? 'verstuurd' : 'concept',
      verstuurdAt: versturen ? new Date() : null,
      vervaltAt: terug?.vervaltAt ? new Date(terug.vervaltAt) : null,
      openstaand: terug?.openstaand ?? t.totaal,
      subtotaal: t.sub,
      btwBedrag: t.btwBedrag,
      totaal: t.totaal,
    },
  });

  if (versturen) {
    await prisma.schade.update({
      where: { id: f.schade.id },
      data: { gefactureerd: true, step: 10 },
    }).catch(() => {});
    await log(req.user,
      `Factuur ${factuur.nummer || ''} verstuurd via jortt aan ${f.aanNaam}`.replace('  ', ' '),
      f.schade.id, `${eur(t.totaal)} \u00b7 gemaild naar ${f.aanEmail}`);
  } else {
    await log(req.user, 'Factuurconcept in jortt gezet', f.schade.id, eur(t.totaal));
  }

  res.json({ factuur, totalen: t });
});

/* ─────────── status ophalen bij jortt ───────────
   Betaald of niet, en hoeveel herinneringen jortt heeft gestuurd. */
router.post('/facturen/:id/verversen', async (req, res) => {
  const f = await prisma.factuur.findUnique({ where: { id: req.params.id } });
  if (!f) return res.status(404).json({ error: 'Factuur niet gevonden' });
  if (!f.jorttId) return res.status(400).json({ error: 'Deze factuur staat nog niet in jortt.' });

  let terug;
  try {
    terug = await jortt.leesFactuur(f.jorttId);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
  if (!terug) return res.status(502).json({ error: 'Jortt gaf niets terug.' });

  const betaald = terug.openstaand === 0;
  const factuur = await prisma.factuur.update({
    where: { id: f.id },
    data: {
      nummer: terug.nummer || f.nummer,
      jorttStatus: terug.status || null,
      openstaand: terug.openstaand,
      vervaltAt: terug.vervaltAt ? new Date(terug.vervaltAt) : f.vervaltAt,
      status: betaald ? 'betaald' : f.status,
      betaaldAt: betaald && !f.betaaldAt ? new Date() : f.betaaldAt,
    },
  });

  if (betaald && !f.betaaldAt) {
    await log(req.user, `Factuur ${factuur.nummer} betaald`, f.schadeId, eur(factuur.totaal));
  }

  res.json({ factuur });
});

/* ─────────── verwijderen ───────────
   Alleen zolang hij nog niet de deur uit is. */
router.delete('/facturen/:id', async (req, res) => {
  const f = await prisma.factuur.findUnique({ where: { id: req.params.id } });
  if (!f) return res.status(404).json({ error: 'Factuur niet gevonden' });
  if (f.status !== 'concept') {
    return res.status(400).json({ error: 'Een verstuurde factuur kun je niet weggooien.' });
  }
  await prisma.factuur.delete({ where: { id: f.id } });
  res.json({ ok: true });
});

module.exports = router;
