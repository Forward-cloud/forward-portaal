const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth/middleware');
const { BEDRIJF, eur, datumNL } = require('../lib/brieven');

const router = express.Router();
router.use(requireAuth);

const PRIJSVORMEN = {
  vast: 'Afgesproken aanneemsom',
  mandaat: 'Mandaat tot maximaal',
  regie: 'Plafondbedrag',
};

async function log(user, text, schadeId, soort) {
  await prisma.logEntry.create({
    data: { text, schadeId: schadeId || null, soort: soort || 'actie', byUserId: user.id, byName: user.naam },
  });
}

// Volgend bonnummer binnen het jaar: 2026-0044
async function volgendNummer() {
  const jaar = new Date().getFullYear();
  const start = `${jaar}-`;
  const laatste = await prisma.opdrachtbon.findFirst({
    where: { nummer: { startsWith: start } },
    orderBy: { nummer: 'desc' },
    select: { nummer: true },
  });
  const n = laatste ? parseInt(laatste.nummer.slice(start.length), 10) || 0 : 0;
  return `${start}${String(n + 1).padStart(4, '0')}`;
}

const cent = (v) => Math.round((Number(v) || 0) * 100);
const datum = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

/* ─────────── lijst ─────────── */
router.get('/schades/:nummer/opdrachtbonnen', async (req, res) => {
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer }, select: { id: true } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });
  const bonnen = await prisma.opdrachtbon.findMany({
    where: { schadeId: s.id },
    orderBy: { createdAt: 'desc' },
    include: { leverancier: { select: { id: true, naam: true, btwVerlegd: true, factuurwijze: true } } },
  });
  res.json({ bonnen, prijsvormen: Object.entries(PRIJSVORMEN).map(([k, v]) => ({ key: k, label: v })) });
});

/* ─────────── aanmaken ─────────── */
router.post('/schades/:nummer/opdrachtbonnen', async (req, res) => {
  const b = req.body || {};
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });
  if (!b.werk || !String(b.werk).trim()) {
    return res.status(400).json({ error: 'Omschrijf wat er moet gebeuren' });
  }

  // Btw-verlegging volgt de leverancier, tenzij je het per bon anders zet.
  let verlegd = true;
  if (b.leverancierId) {
    const lev = await prisma.relatie.findUnique({ where: { id: b.leverancierId } });
    if (lev) verlegd = lev.btwVerlegd;
  }
  if (b.btwVerlegd !== undefined) verlegd = !!b.btwVerlegd;

  const nummer = await volgendNummer();
  const bon = await prisma.opdrachtbon.create({
    data: {
      schadeId: s.id,
      nummer,
      leverancierId: b.leverancierId || null,
      werk: String(b.werk).trim(),
      uitvoerenOp: datum(b.uitvoerenOp),
      tijdvak: b.tijdvak || null,
      bedrag: cent(b.bedrag),
      prijsvorm: PRIJSVORMEN[b.prijsvorm] ? b.prijsvorm : 'vast',
      uurtarief: b.uurtarief != null ? cent(b.uurtarief) : null,
      btwVerlegd: verlegd,
      bewonerMee: b.bewonerMee !== false,
      documentIds: Array.isArray(b.documentIds) ? b.documentIds : [],
      doorNaam: req.user.naam,
    },
  });

  await log(req.user, `Opdrachtbon ${nummer} aangemaakt`, s.id, 'bon');
  res.status(201).json({ bon });
});

/* ─────────── bijwerken ─────────── */
router.patch('/opdrachtbonnen/:id', async (req, res) => {
  const b = req.body || {};
  const data = {};
  if (b.werk !== undefined) data.werk = String(b.werk).trim();
  if (b.leverancierId !== undefined) data.leverancierId = b.leverancierId || null;
  if (b.uitvoerenOp !== undefined) data.uitvoerenOp = datum(b.uitvoerenOp);
  if (b.tijdvak !== undefined) data.tijdvak = b.tijdvak || null;
  if (b.bedrag !== undefined) data.bedrag = cent(b.bedrag);
  if (b.uurtarief !== undefined) data.uurtarief = b.uurtarief == null ? null : cent(b.uurtarief);
  if (b.prijsvorm !== undefined && PRIJSVORMEN[b.prijsvorm]) data.prijsvorm = b.prijsvorm;
  if (b.btwVerlegd !== undefined) data.btwVerlegd = !!b.btwVerlegd;
  if (b.bewonerMee !== undefined) data.bewonerMee = !!b.bewonerMee;
  if (b.documentIds !== undefined) data.documentIds = Array.isArray(b.documentIds) ? b.documentIds : [];

  if (b.status !== undefined) {
    const geldig = ['concept', 'verstuurd', 'afgemeld', 'gefactureerd'];
    if (!geldig.includes(b.status)) return res.status(400).json({ error: 'Onbekende status' });
    data.status = b.status;
    if (b.status === 'verstuurd') data.verstuurdAt = new Date();
    if (b.status === 'afgemeld') data.afgemeldAt = new Date();
  }

  const bon = await prisma.opdrachtbon.update({ where: { id: req.params.id }, data });
  res.json({ bon });
});

router.delete('/opdrachtbonnen/:id', async (req, res) => {
  const bon = await prisma.opdrachtbon.findUnique({ where: { id: req.params.id } });
  if (!bon) return res.status(404).json({ error: 'Niet gevonden' });
  if (bon.status !== 'concept') {
    return res.status(400).json({ error: 'Een verstuurde bon kun je niet verwijderen. Zet hem op afgemeld of maak een nieuwe.' });
  }
  await prisma.opdrachtbon.delete({ where: { id: bon.id } });
  res.json({ verwijderd: true });
});

/* ─────────── de bon als afdrukbare A4 ─────────── */
router.get('/opdrachtbonnen/:id/bon.html', async (req, res) => {
  const bon = await prisma.opdrachtbon.findUnique({
    where: { id: req.params.id },
    include: { leverancier: true, schade: { include: { documenten: true } } },
  });
  if (!bon) return res.status(404).send('Bon niet gevonden');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(bonHtml(bon, req.user));
});

const escH = (v) =>
  String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function bonHtml(bon, ik) {
  const s = bon.schade;
  const lev = bon.leverancier;
  const excl = bon.bedrag / 100;
  const btw = excl * 0.21;
  const bedrag = bon.btwVerlegd ? excl : excl + btw;
  const titel = PRIJSVORMEN[bon.prijsvorm] || PRIJSVORMEN.vast;
  const contact = s.contactpersoon || ik.naam;
  const tel = ik.telefoon || '';

  const werkregels = String(bon.werk)
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => `<li>${escH(r.replace(/^[-•]\s*/, ''))}</li>`)
    .join('');

  const bijlagen = (bon.documentIds || [])
    .map((id) => s.documenten.find((d) => d.id === id))
    .filter(Boolean);

  const uitleg = {
    vast: 'Dit is een vaste prijs voor het hierboven omschreven werk. Meerwerk vergoeden wij alleen na schriftelijke opdracht van ons.',
    mandaat: 'U voert het werk uit tot dit bedrag en factureert de werkelijk gemaakte kosten. Dreigt het bedrag te worden overschreden, stop dan en bel ons eerst. Wat boven het mandaat uitkomt zonder onze schriftelijke opdracht, vergoeden wij niet.',
    regie: `Uurtarief ${bon.uurtarief ? eur(bon.uurtarief / 100) : 'volgens afspraak'} exclusief btw, materiaal tegen inkoop plus opslag. Specificeer op uw factuur de gewerkte uren per dag en de gebruikte materialen. Boven het plafondbedrag werkt u niet door zonder onze schriftelijke opdracht.`,
  }[bon.prijsvorm];

  const bewoner = bon.bewonerMee && s.bewonerSoort !== 'leeg'
    ? `<div class="toegang"><svg viewBox="0 0 24 24" fill="none"><path d="M15 7a4 4 0 11-8 0 4 4 0 018 0zM5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        <div><div class="t">Toegang tot de woning</div><div class="s">${escH(s.owner || 'De bewoner')}, ${
          s.bewonerSoort === 'huurder' ? 'huurder' : 'eigenaar en bewoner'
        }, is aanwezig.${s.telefoon ? ` Bereikbaar op <b>${escH(s.telefoon)}</b>.` : ''}<br>Bel bij verhindering eerst ons en niet de bewoner.</div></div></div>`
    : `<div class="toegang"><svg viewBox="0 0 24 24" fill="none"><path d="M7 10V8a5 5 0 0110 0v2M5 10h14v10H5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
        <div><div class="t">Toegang tot de woning</div><div class="s">Neem vooraf contact met ons op over de toegang${
          tel ? `: <b>${escH(tel)}</b>` : ''
        }.</div></div></div>`;

  return `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<title>Opdrachtbon ${escH(bon.nummer)}</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&family=Inter:wght@400;450;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{--navy:#151F35;--teal:#009BA8;--teal-soft:#E0F4F6;--teal-ink:#006670;--text:#16202F;
    --muted:#677589;--muted-2:#97A2B2;--line:#E4E9EF;--canvas:#F7F9FA;--amber-soft:#FAF0DA;--amber-ink:#8A5A0B}
  *{box-sizing:border-box}html,body{margin:0;padding:0}
  body{background:#EDF1F4;font-family:'Inter',sans-serif;color:var(--text);line-height:1.55;font-size:9.5pt}
  .vel{width:210mm;min-height:297mm;margin:18px auto;background:#fff;padding:16mm 18mm 24mm;
    position:relative;box-shadow:0 10px 34px rgba(21,31,53,.11)}
  .hoofd{display:flex;justify-content:space-between;gap:18mm;margin-bottom:10mm}
  .afz{font-size:7.5pt;color:var(--muted-2);line-height:1.7;text-align:right}
  .afz .naam{color:var(--navy);font-weight:600;font-size:8pt}
  .merk{font-family:'Poppins',sans-serif;font-weight:600;font-size:15pt;color:var(--navy);letter-spacing:.02em}
  .merk span{display:block;font-size:7pt;font-weight:500;color:var(--teal);letter-spacing:.32em;margin-top:1px}
  .titelrij{display:flex;justify-content:space-between;align-items:flex-end;gap:14mm;
    padding-bottom:4mm;margin-bottom:7mm;border-bottom:2px solid var(--navy)}
  .eyebrow{font-size:7.5pt;font-weight:600;color:var(--teal);letter-spacing:.09em;text-transform:uppercase;margin-bottom:2mm}
  h1{font-family:'Poppins',sans-serif;font-weight:600;font-size:16pt;color:var(--navy);margin:0}
  .aanadres{font-size:9pt;color:var(--muted);margin-top:1.5mm;line-height:1.5}
  .bonnr{text-align:right}
  .bonnr .l{font-size:7pt;color:var(--muted-2);letter-spacing:.06em;text-transform:uppercase}
  .bonnr .v{font-family:'JetBrains Mono',monospace;font-size:15pt;color:var(--navy);letter-spacing:-.03em}
  .bonnr .d{font-size:8pt;color:var(--muted);margin-top:1mm}
  .kenm{display:flex;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:4mm;margin-bottom:6mm}
  .k{flex:1 1 40mm;min-width:36mm;padding-right:5mm}
  .k .lab{font-size:7pt;color:var(--muted-2);letter-spacing:.06em;text-transform:uppercase}
  .k .val{font-size:9pt;color:var(--navy);font-weight:500}
  .k .val small{display:block;font-weight:400;color:var(--muted);font-size:8pt}
  .k .val.mono{font-family:'JetBrains Mono',monospace;font-size:8.5pt}
  h2{font-family:'Poppins',sans-serif;font-size:10.5pt;color:var(--navy);margin:0 0 3mm}
  .werk{background:var(--canvas);border-radius:3mm;padding:4.5mm 5.5mm;margin-bottom:6mm;font-size:9pt}
  .werk ul{margin:0;padding-left:5mm}.werk li{padding:.7mm 0}
  .toegang{display:flex;gap:3.5mm;background:var(--teal-soft);border-radius:3mm;padding:4mm 5mm;margin-bottom:6mm}
  .toegang svg{width:5mm;height:5mm;color:var(--teal-ink);flex:none;margin-top:.4mm}
  .toegang .t{font-size:9pt;font-weight:600;color:var(--navy);margin-bottom:1mm}
  .toegang .s{font-size:8.5pt;color:var(--teal-ink);line-height:1.55}
  .bedrag{border-top:1.6pt solid var(--navy);padding-top:3mm;display:flex;justify-content:space-between;align-items:baseline}
  .bedrag .l{font-size:9.5pt;font-weight:600;color:var(--navy)}
  .bedrag .v{font-family:'Poppins',sans-serif;font-size:14pt;font-weight:600;color:var(--navy);font-variant-numeric:tabular-nums}
  .btwsplit{display:flex;justify-content:space-between;font-size:8.5pt;color:var(--muted);padding:1mm 0}
  .prijsuitleg{font-size:8.5pt;color:var(--muted);line-height:1.5;margin-top:2.5mm;padding-left:3.5mm;border-left:2px solid var(--line)}
  .btwregel{font-size:8pt;color:var(--muted);margin:3mm 0 6mm;line-height:1.5}
  .btwregel b{color:var(--navy);font-family:'JetBrains Mono',monospace;font-size:7.5pt}
  .bijlagen{border-left:2.5pt solid var(--teal);padding:.5mm 0 .5mm 4.5mm;margin-bottom:6mm}
  .bijlagen .kop{font-size:7pt;font-weight:600;color:var(--muted-2);letter-spacing:.06em;text-transform:uppercase;margin-bottom:1.5mm}
  .bijlagen ul{margin:0;padding:0;list-style:none;font-size:8.5pt}
  .bijlagen li{padding:1mm 0 1mm 6mm;position:relative}
  .bijlagen .vk{position:absolute;left:0;top:1.6mm;width:4mm;height:4mm;border-radius:50%;background:var(--teal);
    color:#fff;display:flex;align-items:center;justify-content:center}
  .bijlagen .vk svg{width:2.5mm;height:2.5mm}
  .eisen{border:1px solid var(--line);border-radius:3.5mm;overflow:hidden;margin-bottom:6mm}
  .eisen-kop{background:var(--navy);color:#fff;padding:3mm 5.5mm;font-family:'Poppins',sans-serif;font-size:9.5pt;font-weight:600}
  .eis{display:flex;gap:3.5mm;padding:3.2mm 5.5mm;border-bottom:1px solid var(--line)}
  .eis:last-child{border-bottom:none}
  .eis-ic{width:8mm;height:8mm;border-radius:2.2mm;flex:none;display:flex;align-items:center;justify-content:center;
    background:var(--teal-soft);color:var(--teal-ink)}
  .eis-ic.amber{background:var(--amber-soft);color:var(--amber-ink)}
  .eis-ic svg{width:4.4mm;height:4.4mm}
  .eis .t{font-size:9pt;font-weight:600;color:var(--navy)}
  .eis .s{font-size:8.5pt;color:var(--muted);line-height:1.45}
  .eis .s b{color:var(--navy);font-family:'JetBrains Mono',monospace;font-size:8pt}
  .slot{font-size:8.5pt;color:var(--muted);line-height:1.55;margin-bottom:6mm}
  .contactrij{display:flex;gap:5mm;flex-wrap:wrap;font-size:8.5pt;color:var(--muted);
    background:var(--canvas);border-radius:3mm;padding:3.5mm 5mm;margin-bottom:6mm}
  .contactrij b{color:var(--navy)}
  .ondertekenaar{padding-top:2mm;border-top:1px solid var(--line);display:inline-block;min-width:55mm;margin-top:4mm}
  .ondertekenaar .naam{font-weight:600;color:var(--navy);font-size:9.5pt}
  .ondertekenaar .functie{color:var(--muted);font-size:8.5pt}
  .voet{position:absolute;left:18mm;right:18mm;bottom:11mm;padding-top:3mm;border-top:1px solid var(--line);
    font-size:7pt;color:var(--muted-2);display:flex;justify-content:space-between}
  .knoppen{width:210mm;margin:0 auto 14px;display:flex;gap:8px;justify-content:flex-end}
  .knoppen button{font-family:'Inter',sans-serif;font-size:13px;padding:10px 18px;border-radius:10px;
    border:none;cursor:pointer;background:var(--teal);color:#fff;font-weight:500}
  @media print{body{background:#fff}.vel{margin:0;box-shadow:none;width:auto;min-height:auto}.knoppen{display:none}
    @page{size:A4;margin:0}}
</style></head><body>
<div class="knoppen"><button onclick="window.print()">Opslaan als pdf</button></div>
<div class="vel">
  <div class="hoofd">
    <div class="merk">FORWARD<span>SCHADEHERSTEL</span></div>
    <div class="afz"><div class="naam">${escH(BEDRIJF.naam)}</div>${escH(BEDRIJF.adres)}<br>
      ${escH(BEDRIJF.postcode)} ${escH(BEDRIJF.plaats)}<br><br>facturen@forwardschadeherstel.nl<br>
      ${escH(BEDRIJF.web)}<br><br>KvK ${escH(BEDRIJF.kvk)}<br>Btw ${escH(BEDRIJF.btw)}</div>
  </div>

  <div class="titelrij">
    <div><div class="eyebrow">Opdrachtbon</div><h1>${escH(lev ? lev.naam : 'Onderaannemer')}</h1>
      ${lev && lev.adres ? `<div class="aanadres">${escH(lev.adres)}<br>${escH([lev.postcode, lev.plaats].filter(Boolean).join(' '))}</div>` : ''}</div>
    <div class="bonnr"><div class="l">Bonnummer</div><div class="v">${escH(bon.nummer)}</div>
      <div class="d">${escH(BEDRIJF.plaats)}, ${escH(datumNL(bon.createdAt))}</div></div>
  </div>

  <div class="kenm">
    <div class="k"><div class="lab">Werkadres</div><div class="val">${escH(s.adres || '')}<small>${escH([s.postcode, s.plaats].filter(Boolean).join(' '))}</small></div></div>
    <div class="k"><div class="lab">Uitvoeren op</div><div class="val">${bon.uitvoerenOp ? escH(datumNL(bon.uitvoerenOp)) : 'in overleg'}${bon.tijdvak ? `<small>${escH(bon.tijdvak)}</small>` : ''}</div></div>
    <div class="k"><div class="lab">Ons dossier</div><div class="val mono">${escH(s.nummer)}</div></div>
    <div class="k"><div class="lab">Uw contactpersoon</div><div class="val">${escH(contact)}${tel ? `<small>${escH(tel)}</small>` : ''}</div></div>
  </div>

  <h2>Uit te voeren werk</h2>
  <div class="werk"><ul>${werkregels}</ul></div>

  ${bewoner}

  <div class="bedrag"><span class="l">${titel}</span><span class="v">${escH(eur(bedrag))}</span></div>
  ${!bon.btwVerlegd ? `<div class="btwsplit"><span>Bedrag exclusief btw</span><span>${escH(eur(excl))}</span></div>
    <div class="btwsplit"><span>Btw 21%</span><span>${escH(eur(btw))}</span></div>` : ''}
  <div class="prijsuitleg">${escH(uitleg)}</div>
  <div class="btwregel">${bon.btwVerlegd
    ? `Bedrag exclusief btw. Op deze opdracht is de <b>verleggingsregeling</b> van toepassing: breng geen btw in rekening en vermeld op uw factuur &ldquo;btw verlegd&rdquo; met ons btw-nummer <b>${escH(BEDRIJF.btw)}</b>.`
    : 'Bedrag inclusief btw. De verleggingsregeling is op deze opdracht niet van toepassing; breng de btw op de gebruikelijke wijze in rekening.'}</div>

  ${bijlagen.length ? `<div class="bijlagen"><div class="kop">Bijlagen bij deze bon &mdash; ${bijlagen.length} stuk${bijlagen.length > 1 ? 's' : ''}</div><ul>${
    bijlagen.map((d) => `<li><span class="vk"><svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span style="font-weight:500;color:var(--navy)">${escH(d.bestandsnaam)}</span></li>`).join('')
  }</ul></div>` : ''}

  <div class="eisen">
    <div class="eisen-kop">Zo verwerken wij uw factuur zonder vertraging</div>
    <div class="eis"><div class="eis-ic"><svg viewBox="0 0 24 24" fill="none"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></div>
      <div><div class="t">Vermeld bonnummer en uitvoeringsdatum</div><div class="s">Zet <b>${escH(bon.nummer)}</b> en de dag waarop het werk is gedaan op de factuur. Zonder bonnummer kunnen wij hem niet koppelen.</div></div></div>
    <div class="eis"><div class="eis-ic"><svg viewBox="0 0 24 24" fill="none"><path d="M16.5 8.5A5.2 5.2 0 108 15M4.5 11h7M4.5 14h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div>
      <div><div class="t">${bon.btwVerlegd ? 'Factureer zonder btw' : 'Vermeld de btw apart'}</div><div class="s">${
        bon.btwVerlegd ? `Verleggingsregeling: vermeld &ldquo;btw verlegd&rdquo; en ons btw-nummer <b>${escH(BEDRIJF.btw)}</b>.`
                       : 'Bedrag exclusief btw, het btw-tarief en het btw-bedrag, plus uw eigen btw-nummer.'
      }</div></div></div>
    ${bon.prijsvorm !== 'vast' ? `<div class="eis"><div class="eis-ic amber"><svg viewBox="0 0 24 24" fill="none"><path d="M8 6h11M8 12h11M8 18h11M4 6h.01M4 12h.01M4 18h.01" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg></div>
      <div><div class="t">Specificeer wat u heeft gedaan</div><div class="s">${
        bon.prijsvorm === 'regie' ? 'Gewerkte uren per dag, uurtarief en gebruikte materialen apart op de factuur.'
                                  : 'Een korte opgave van de werkelijk uitgevoerde werkzaamheden en de kosten daarvan.'
      }</div></div></div>` : ''}
    <div class="eis"><div class="eis-ic amber"><svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4.5" width="18" height="15" rx="2.4" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3.4" stroke="currentColor" stroke-width="1.8"/></svg></div>
      <div><div class="t">Meld het werk af via het portaal, met foto&rsquo;s</div><div class="s">Foto&rsquo;s van het opgeleverde werk hebben wij nodig voordat wij betalen. Zonder afmelding blijft de factuur liggen.</div></div></div>
    <div class="eis"><div class="eis-ic"><svg viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M4 7l8 6 8-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div>
      <div><div class="t">Stuur de factuur digitaal</div><div class="s">Naar <b>facturen@forwardschadeherstel.nl</b> &middot; ${escH(BEDRIJF.naam)}, ${escH(BEDRIJF.adres)}, ${escH(BEDRIJF.postcode)} ${escH(BEDRIJF.plaats)}.</div></div></div>
    <div class="eis"><div class="eis-ic"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5V12l3 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div>
      <div><div class="t">Betaling binnen 30 dagen</div><div class="s">Gerekend vanaf ontvangst van een complete factuur met afmelding.</div></div></div>
  </div>

  <div class="slot">${bon.prijsvorm === 'mandaat'
    ? 'Wijkt het werk af van deze bon of dreigt het mandaat te worden overschreden, bel ons dan eerst. '
    : 'Wijkt het werk af van deze bon, neem dan eerst contact met ons op. '}Meerwerk zonder schriftelijke opdracht kunnen wij niet vergoeden. Op deze opdracht zijn onze algemene voorwaarden van toepassing.</div>

  <div class="contactrij"><span>Vragen over dit werk? <b>${escH(contact)}</b></span>
    ${tel ? `<span><b>${escH(tel)}</b></span>` : ''}<span><b>${escH(ik.email)}</b></span></div>

  <div class="ondertekenaar"><div class="naam">${escH(contact)}</div>
    <div class="functie">${escH(BEDRIJF.handelsnaam)}</div></div>

  <div class="voet"><span>${escH(BEDRIJF.naam)} &middot; ${escH(BEDRIJF.adres)} &middot; ${escH(BEDRIJF.postcode)} ${escH(BEDRIJF.plaats)}</span>
    <span>KvK ${escH(BEDRIJF.kvk)} &middot; Btw ${escH(BEDRIJF.btw)}</span></div>
</div></body></html>`;
}

module.exports = router;
