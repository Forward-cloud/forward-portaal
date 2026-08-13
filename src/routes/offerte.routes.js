const crypto = require('crypto');
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth/middleware');
const { BEDRIJF, PORTAAL, eur, datumNL } = require('../lib/brieven');

const router = express.Router();

const GELDIG_DAGEN = Number(process.env.OFFERTE_GELDIG_DAGEN || 30);

const escH = (v) =>
  String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function nieuweToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/* ══════════ openbaar: geen inlog ══════════ */

// De pagina die de klant opent vanuit de e-mail.
router.get('/offerte/:token', async (req, res) => {
  const o = await prisma.offerte.findUnique({
    where: { token: req.params.token },
    include: { schade: { include: { documenten: true } } },
  });
  if (!o) return res.status(404).send(pagina({ fout: 'Deze link is niet (meer) geldig.' }));

  // Eerste keer openen vastleggen.
  const data = { openCount: { increment: 1 } };
  if (!o.geopendAt) data.geopendAt = new Date();
  await prisma.offerte.update({ where: { id: o.id }, data });

  const verlopen = o.geldigTot && new Date(o.geldigTot) < new Date() && o.status === 'open';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(pagina({ o, verlopen }));
});

// Akkoord of afwijzing.
router.post('/offerte/:token/besluit', express.json(), async (req, res) => {
  const b = req.body || {};
  const o = await prisma.offerte.findUnique({ where: { token: req.params.token } });
  if (!o) return res.status(404).json({ error: 'Deze link is niet meer geldig' });
  if (o.status !== 'open') return res.status(409).json({ error: 'Er is al een keuze gemaakt' });

  const akkoord = !!b.akkoord;
  const naam = String(b.naam || '').trim();
  if (!naam) return res.status(400).json({ error: 'Vul uw naam in' });
  if (!akkoord && !String(b.reden || '').trim()) {
    return res.status(400).json({ error: 'Laat ons weten waarom u niet akkoord gaat' });
  }

  const bijgewerkt = await prisma.offerte.update({
    where: { id: o.id },
    data: {
      status: akkoord ? 'akkoord' : 'geweigerd',
      besluitAt: new Date(),
      naam,
      reden: b.reden ? String(b.reden).trim() : null,
      ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim(),
    },
  });

  await prisma.logEntry.create({
    data: {
      text: akkoord
        ? `Offerte geaccepteerd door ${naam}`
        : `Offerte afgewezen door ${naam}${bijgewerkt.reden ? ` — ${bijgewerkt.reden}` : ''}`,
      byName: naam,
    },
  });

  res.json({ status: bijgewerkt.status });
});

/* ══════════ vanuit het portaal ══════════ */

router.get('/schades/:nummer/offertes', requireAuth, async (req, res) => {
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer }, select: { id: true } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });
  const offertes = await prisma.offerte.findMany({
    where: { schadeId: s.id },
    orderBy: { verstuurdAt: 'desc' },
  });
  res.json({
    offertes: offertes.map((o) => ({ ...o, link: `${PORTAAL}/offerte/${o.token}` })),
  });
});

// Maakt een nieuwe akkoordlink aan bij het versturen van een offerte.
router.post('/schades/:nummer/offertes', requireAuth, async (req, res) => {
  const b = req.body || {};
  const s = await prisma.schade.findUnique({
    where: { nummer: req.params.nummer },
    include: { documenten: true },
  });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const doc = b.documentId
    ? s.documenten.find((d) => d.id === b.documentId)
    : s.documenten.find((d) => d.soort === 'offerte');

  const geldig = new Date();
  geldig.setDate(geldig.getDate() + (Number(b.geldigDagen) || GELDIG_DAGEN));

  // Openstaande eerdere link vervalt.
  await prisma.offerte.updateMany({
    where: { schadeId: s.id, status: 'open' },
    data: { status: 'vervallen' },
  });

  const o = await prisma.offerte.create({
    data: {
      schadeId: s.id,
      token: nieuweToken(),
      documentId: doc ? doc.id : null,
      bedrag: doc && doc.bedrag ? doc.bedrag : s.amount || null,
      geldigTot: geldig,
    },
  });

  res.status(201).json({ offerte: { ...o, link: `${PORTAAL}/offerte/${o.token}` } });
});

// Herinnering vastleggen (de brief zelf gaat via de gewone verzendroute).
router.post('/offertes/:id/herinnerd', requireAuth, async (req, res) => {
  const o = await prisma.offerte.update({
    where: { id: req.params.id },
    data: { herinnerdAt: new Date(), herinneringen: { increment: 1 } },
  });
  res.json({ offerte: o });
});

/* ══════════ de pagina voor de klant ══════════ */

function pagina({ o, verlopen, fout }) {
  const kop = `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offerte ${o ? escH(o.schade.nummer) : ''} &middot; Forward Schadeherstel</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&family=Inter:wght@400;450;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{--navy:#151F35;--teal:#009BA8;--teal-2:#00B6C4;--teal-soft:#E0F4F6;--teal-ink:#006670;
    --canvas:#F3F6F8;--surface:#fff;--line:#E4E9EF;--text:#16202F;--muted:#677589;--muted-2:#97A2B2;
    --green:#1E9E63;--green-soft:#E1F4EA;--red:#D84A4A;--red-soft:#FBE9E9;--amber:#C77E00;--amber-soft:#FAF0DA}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{background:var(--canvas);font-family:'Inter',system-ui,sans-serif;color:var(--text);
    line-height:1.55;-webkit-font-smoothing:antialiased;padding:24px 16px 60px}
  .vel{max-width:600px;margin:0 auto}
  .kaart{background:var(--surface);border-radius:16px;padding:26px 26px 28px;
    box-shadow:0 1px 2px rgba(21,31,53,.05),0 8px 28px rgba(21,31,53,.07);margin-bottom:14px}
  .merk{font-family:'Poppins',sans-serif;font-weight:600;font-size:19px;color:var(--navy);letter-spacing:.02em}
  .merk span{display:block;font-size:9.5px;font-weight:500;color:var(--teal);letter-spacing:.34em;margin-top:2px}
  .eyebrow{font-size:11px;font-weight:600;color:var(--teal);letter-spacing:.09em;text-transform:uppercase;
    margin:26px 0 6px}
  h1{font-family:'Poppins',sans-serif;font-weight:600;font-size:22px;color:var(--navy);margin:0 0 4px;line-height:1.3}
  .sub{color:var(--muted);font-size:14px}
  .feiten{border-top:1px solid var(--line);border-bottom:1px solid var(--line);
    padding:14px 0;margin:20px 0;display:flex;flex-wrap:wrap;gap:16px}
  .f{flex:1 1 150px}
  .f .l{font-size:10.5px;color:var(--muted-2);letter-spacing:.06em;text-transform:uppercase;margin-bottom:2px}
  .f .v{font-size:14.5px;font-weight:500;color:var(--navy)}
  .f .v.mono{font-family:'JetBrains Mono',monospace;font-size:13.5px;letter-spacing:-.02em}
  .bedrag{background:var(--canvas);border-radius:12px;padding:16px 18px;margin:18px 0;
    display:flex;justify-content:space-between;align-items:baseline;gap:12px}
  .bedrag .l{font-size:13.5px;color:var(--muted)}
  .bedrag .v{font-family:'Poppins',sans-serif;font-size:24px;font-weight:600;color:var(--navy);
    font-variant-numeric:tabular-nums}
  a.doc{display:flex;align-items:center;gap:10px;padding:13px 15px;border:1px solid var(--line);
    border-radius:12px;text-decoration:none;color:var(--text);transition:.15s;margin-bottom:18px}
  a.doc:hover{border-color:var(--teal);background:rgba(0,155,168,.03)}
  a.doc svg{width:19px;height:19px;color:var(--teal);flex:none}
  a.doc .t{font-size:14px;font-weight:500}
  a.doc .s{font-size:12px;color:var(--muted)}
  .knoppen{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}
  button{font-family:inherit;font-size:15px;font-weight:500;padding:14px 22px;border-radius:12px;
    border:none;cursor:pointer;flex:1 1 180px;min-height:50px;transition:.15s}
  .ja{background:var(--teal);color:#fff}
  .ja:hover{background:var(--teal-ink)}
  .nee{background:var(--surface);color:var(--text);border:1px solid var(--line)}
  .nee:hover{border-color:var(--red);color:var(--red)}
  label{display:block;font-size:12.5px;color:var(--muted);margin:14px 0 5px}
  input,textarea{width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:11px;
    font-family:inherit;font-size:15px;background:var(--surface);color:var(--text)}
  textarea{min-height:88px;resize:vertical}
  .melding{padding:14px 16px;border-radius:12px;font-size:14px;margin-bottom:18px}
  .melding.ok{background:var(--green-soft);color:#12704A}
  .melding.let{background:var(--amber-soft);color:#8A5A0B}
  .melding.err{background:var(--red-soft);color:var(--red)}
  .voet{text-align:center;font-size:12px;color:var(--muted-2);padding-top:6px;line-height:1.7}
  .klein{font-size:12px;color:var(--muted);margin-top:12px}
</style></head><body><div class="vel">`;

  const voet = `<div class="voet">${escH(BEDRIJF.naam)} &middot; ${escH(BEDRIJF.adres)}, ${escH(BEDRIJF.postcode)} ${escH(BEDRIJF.plaats)}<br>
    ${escH(BEDRIJF.email)} &middot; KvK ${escH(BEDRIJF.kvk)}</div></div></body></html>`;

  const merk = `<div class="merk">FORWARD<span>SCHADEHERSTEL</span></div>`;

  if (fout) {
    return kop + `<div class="kaart">${merk}<div class="eyebrow">Offerte</div>
      <h1>Link niet geldig</h1><p class="sub">${escH(fout)} Neem gerust contact met ons op.</p></div>` + voet;
  }

  const s = o.schade;
  const waar = [s.adres, s.plaats].filter(Boolean).join(', ');
  const klaar = o.status !== 'open';

  let blok = '';
  if (o.status === 'akkoord') {
    blok = `<div class="melding ok"><b>U bent akkoord gegaan</b> op ${escH(datumNL(o.besluitAt))}${
      o.naam ? `, namens ${escH(o.naam)}` : ''
    }. Wij nemen contact met u op om het herstel in te plannen.</div>`;
  } else if (o.status === 'geweigerd') {
    blok = `<div class="melding let"><b>U bent niet akkoord gegaan</b> op ${escH(datumNL(o.besluitAt))}.${
      o.reden ? ` U gaf aan: ${escH(o.reden)}` : ''
    } Wij nemen contact met u op.</div>`;
  } else if (o.status === 'vervallen') {
    blok = `<div class="melding let">Deze offerte is vervangen door een nieuwe versie. Neem contact met ons op.</div>`;
  } else if (verlopen) {
    blok = `<div class="melding let">De geldigheidstermijn van deze offerte is verstreken. Neem contact met ons op voor een nieuwe.</div>`;
  }

  const doc = o.documentId
    ? `<a class="doc" href="/api/offerte/${escH(o.token)}/document" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" fill="none"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
        <span><span class="t">Offerte bekijken</span><span class="s">Opent als pdf in een nieuw tabblad</span></span></a>`
    : '';

  const keuze = klaar || verlopen ? '' : `
    <div class="knoppen">
      <button class="ja" onclick="kies(true)">Akkoord met de offerte</button>
      <button class="nee" onclick="kies(false)">Niet akkoord</button>
    </div>
    <div class="klein">Uw keuze wordt met datum en tijd vastgelegd bij het dossier.</div>
    <div id="vak"></div>`;

  return kop + `<div class="kaart">
    ${merk}
    <div class="eyebrow">Offerte herstel</div>
    <h1>${escH(waar)}</h1>
    <div class="sub">${escH(s.owner || '')}</div>

    ${blok}

    <div class="feiten">
      <div class="f"><div class="l">Dossiernummer</div><div class="v mono">${escH(s.nummer)}</div></div>
      ${o.geldigTot ? `<div class="f"><div class="l">Geldig tot</div><div class="v">${escH(datumNL(o.geldigTot))}</div></div>` : ''}
    </div>

    ${o.bedrag ? `<div class="bedrag"><span class="l">Herstelkosten inclusief btw</span><span class="v">${escH(eur(o.bedrag))}</span></div>` : ''}

    ${doc}
    ${keuze}
  </div>

  <script>
    var gekozen = null;
    function kies(ja){
      gekozen = ja;
      document.getElementById('vak').innerHTML =
        (ja ? '' : '<label>Waarom gaat u niet akkoord?</label><textarea id="reden" placeholder="Bijvoorbeeld: ik wil eerst een tweede offerte"></textarea>') +
        '<label>Uw naam</label><input id="naam" placeholder="Voor- en achternaam" autocomplete="name">' +
        '<div class="knoppen"><button class="' + (ja ? 'ja' : 'nee') + '" onclick="verstuur()">' +
        (ja ? 'Bevestig akkoord' : 'Bevestig afwijzing') + '</button></div><div id="fout"></div>';
      document.getElementById('naam').focus();
    }
    function verstuur(){
      var naam = (document.getElementById('naam') || {}).value || '';
      var reden = (document.getElementById('reden') || {}).value || '';
      fetch('/api/offerte/${escH(o.token)}/besluit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ akkoord: gekozen, naam: naam, reden: reden })
      }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
        .then(function(res){
          if (!res.ok) { document.getElementById('fout').innerHTML =
            '<div class="melding err" style="margin-top:14px">' + (res.j.error || 'Er ging iets mis') + '</div>'; return; }
          location.reload();
        });
    }
  </script>` + voet;
}

// De offerte-pdf, bereikbaar via de token.
router.get('/offerte/:token/document', async (req, res) => {
  const o = await prisma.offerte.findUnique({ where: { token: req.params.token } });
  if (!o || !o.documentId) return res.status(404).send('Niet gevonden');
  const doc = await prisma.document.findUnique({ where: { id: o.documentId } });
  if (!doc) return res.status(404).send('Niet gevonden');
  const fs = require('fs');
  const path = require('path');
  const bestand = path.join(process.env.UPLOAD_DIR || '/data/uploads', doc.opslagnaam);
  if (!fs.existsSync(bestand)) return res.status(404).send('Bestand niet gevonden');
  res.setHeader('Content-Type', doc.mime);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.bestandsnaam)}"`);
  fs.createReadStream(bestand).pipe(res);
});

module.exports = router;
