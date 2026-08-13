const crypto = require('crypto');
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth/middleware');
const { BEDRIJF, PORTAAL, datumNL } = require('../lib/brieven');

const router = express.Router();

const SOORTEN = { opname: 'Schade-opname', herstel: 'Herstelwerkzaamheden' };
const GELDIG_DAGEN = Number(process.env.AFSPRAAK_GELDIG_DAGEN || 14);

const escH = (v) =>
  String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const datum = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

function langeDatum(d) {
  return new Date(d).toLocaleDateString('nl-NL', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
}

/* ══════ openbaar: de klant kiest ══════ */

router.get('/afspraak/:token', async (req, res) => {
  const a = await prisma.afspraak.findUnique({
    where: { token: req.params.token },
    include: { schade: true },
  });
  if (!a) return res.status(404).send(pagina({ fout: 'Deze link is niet (meer) geldig.' }));

  const data = { openCount: { increment: 1 } };
  if (!a.geopendAt) data.geopendAt = new Date();
  await prisma.afspraak.update({ where: { id: a.id }, data });

  const verlopen = a.geldigTot && new Date(a.geldigTot) < new Date() && a.status === 'open';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(pagina({ a, verlopen }));
});

router.post('/afspraak/:token/kies', express.json(), async (req, res) => {
  const b = req.body || {};
  const a = await prisma.afspraak.findUnique({ where: { token: req.params.token } });
  if (!a) return res.status(404).json({ error: 'Deze link is niet meer geldig' });
  if (a.status !== 'open') return res.status(409).json({ error: 'Er is al een keuze gemaakt' });

  const naam = String(b.naam || '').trim();
  if (!naam) return res.status(400).json({ error: 'Vul uw naam in' });

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .toString().split(',')[0].trim();

  let bij;
  if (b.geen) {
    if (!String(b.reden || '').trim()) {
      return res.status(400).json({ error: 'Laat ons weten waarom geen van de momenten schikt' });
    }
    bij = await prisma.afspraak.update({
      where: { id: a.id },
      data: { status: 'geweigerd', besluitAt: new Date(), naam, reden: String(b.reden).trim(), ip },
    });
  } else {
    const opties = Array.isArray(a.opties) ? a.opties : [];
    const keuze = opties[Number(b.index)];
    if (!keuze) return res.status(400).json({ error: 'Kies een van de momenten' });
    bij = await prisma.afspraak.update({
      where: { id: a.id },
      data: {
        status: 'gekozen', besluitAt: new Date(), naam, ip,
        gekozenDatum: datum(keuze.datum), gekozenTijd: keuze.tijdvak || null,
      },
    });
  }

  await prisma.logEntry.create({
    data: {
      text: b.geen
        ? `Geen van de voorgestelde momenten schikt — ${naam}`
        : `Afspraak gekozen door ${naam}: ${langeDatum(bij.gekozenDatum)}${bij.gekozenTijd ? ', ' + bij.gekozenTijd : ''}`,
      schadeId: a.schadeId, soort: 'afspraak', byName: naam,
    },
  });

  res.json({ status: bij.status });
});

/* ══════ vanuit het portaal ══════ */

router.get('/schades/:nummer/afspraken', requireAuth, async (req, res) => {
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer }, select: { id: true } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });
  const afspraken = await prisma.afspraak.findMany({
    where: { schadeId: s.id },
    orderBy: { verstuurdAt: 'desc' },
  });
  res.json({ afspraken: afspraken.map((a) => ({ ...a, link: `${PORTAAL}/afspraak/${a.token}` })) });
});

router.post('/schades/:nummer/afspraken', requireAuth, async (req, res) => {
  const b = req.body || {};
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const opties = (Array.isArray(b.opties) ? b.opties : [])
    .map((o) => ({ datum: o.datum, tijdvak: o.tijdvak || '' }))
    .filter((o) => datum(o.datum));
  if (!opties.length) return res.status(400).json({ error: 'Stel minstens één moment voor' });

  const geldig = new Date();
  geldig.setDate(geldig.getDate() + (Number(b.geldigDagen) || GELDIG_DAGEN));

  // Een eerder openstaand voorstel vervalt.
  await prisma.afspraak.updateMany({
    where: { schadeId: s.id, soort: b.soort === 'herstel' ? 'herstel' : 'opname', status: 'open' },
    data: { status: 'vervallen' },
  });

  const a = await prisma.afspraak.create({
    data: {
      schadeId: s.id,
      token: crypto.randomBytes(24).toString('base64url'),
      soort: b.soort === 'herstel' ? 'herstel' : 'opname',
      omschrijving: b.omschrijving || null,
      vakman: b.vakman || null,
      duur: b.duur || null,
      locatieId: b.locatieId || null,
      opties,
      geldigTot: geldig,
    },
  });

  await prisma.logEntry.create({
    data: {
      text: `${SOORTEN[a.soort]} voorgesteld — ${opties.length} moment${opties.length > 1 ? 'en' : ''}`,
      schadeId: s.id, soort: 'afspraak', byUserId: req.user.id, byName: req.user.naam,
    },
  });

  res.status(201).json({ afspraak: { ...a, link: `${PORTAAL}/afspraak/${a.token}` } });
});

router.delete('/afspraken/:id', requireAuth, async (req, res) => {
  await prisma.afspraak.update({ where: { id: req.params.id }, data: { status: 'vervallen' } });
  res.json({ ok: true });
});

/* ══════ de pagina voor de klant ══════ */

function pagina({ a, verlopen, fout }) {
  const kop = `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Afspraak inplannen &middot; Forward Schadeherstel</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&family=Inter:wght@400;450;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{--navy:#151F35;--teal:#009BA8;--teal-soft:#E0F4F6;--teal-ink:#006670;--teal-deep:#007E8A;
    --canvas:#F3F6F8;--surface:#fff;--line:#E4E9EF;--text:#16202F;--muted:#677589;--muted-2:#97A2B2;
    --green:#1E9E63;--green-soft:#E1F4EA;--amber-soft:#FAF0DA;--red:#D84A4A;--red-soft:#FBE9E9}
  *{box-sizing:border-box}html,body{margin:0;padding:0}
  body{background:var(--canvas);font-family:'Inter',system-ui,sans-serif;color:var(--text);
    line-height:1.55;padding:24px 16px 60px;-webkit-font-smoothing:antialiased}
  .vel{max-width:560px;margin:0 auto}
  .kaart{background:var(--surface);border-radius:16px;padding:26px;margin-bottom:14px;
    box-shadow:0 1px 2px rgba(21,31,53,.05),0 8px 28px rgba(21,31,53,.07)}
  .merk{font-family:'Poppins',sans-serif;font-weight:600;font-size:19px;color:var(--navy);letter-spacing:.02em}
  .merk span{display:block;font-size:9.5px;font-weight:500;color:var(--teal);letter-spacing:.34em;margin-top:2px}
  .eyebrow{font-size:11px;font-weight:600;color:var(--teal);letter-spacing:.09em;text-transform:uppercase;margin:26px 0 6px}
  h1{font-family:'Poppins',sans-serif;font-weight:600;font-size:22px;color:var(--navy);margin:0 0 4px;line-height:1.3}
  .sub{color:var(--muted);font-size:14px}
  .wat{background:var(--canvas);border-radius:12px;padding:14px 16px;margin:20px 0;font-size:14px}
  .wat b{color:var(--navy)}
  .moment{display:flex;align-items:center;gap:14px;width:100%;padding:16px 18px;border:1.5px solid var(--line);
    border-radius:14px;background:var(--surface);margin-bottom:10px;cursor:pointer;transition:.15s;
    font-family:inherit;text-align:left}
  .moment:hover{border-color:var(--teal);background:rgba(0,155,168,.03)}
  .moment.aan{border-color:var(--teal);background:var(--teal-soft)}
  .moment .bol{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);flex:none;
    display:flex;align-items:center;justify-content:center}
  .moment.aan .bol{border-color:var(--teal);background:var(--teal)}
  .moment.aan .bol::after{content:'';width:8px;height:8px;border-radius:50%;background:#fff}
  .moment .d{font-size:15.5px;font-weight:600;color:var(--navy);text-transform:capitalize}
  .moment .t{font-size:13px;color:var(--muted);margin-top:1px}
  button.groot{font-family:inherit;font-size:15px;font-weight:500;padding:14px 22px;border-radius:12px;
    border:none;cursor:pointer;min-height:50px;transition:.15s;width:100%;margin-top:6px}
  .ja{background:var(--teal);color:#fff}
  .ja:hover{background:var(--teal-deep)}
  .nee{background:var(--surface);color:var(--muted);border:1px solid var(--line);margin-top:10px}
  .nee:hover{border-color:var(--red);color:var(--red)}
  label{display:block;font-size:12.5px;color:var(--muted);margin:16px 0 5px}
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
    return kop + `<div class="kaart">${merk}<div class="eyebrow">Afspraak</div>
      <h1>Link niet geldig</h1><p class="sub">${escH(fout)} Neem gerust contact met ons op.</p></div>` + voet;
  }

  const s = a.schade;
  const waar = [s.adres, s.plaats].filter(Boolean).join(', ');
  const klaar = a.status !== 'open';
  const opties = Array.isArray(a.opties) ? a.opties : [];

  let blok = '';
  if (a.status === 'gekozen') {
    blok = `<div class="melding ok"><b>Afspraak staat genoteerd:</b> ${escH(langeDatum(a.gekozenDatum))}${
      a.gekozenTijd ? `, ${escH(a.gekozenTijd)}` : ''
    }. U ontvangt van ons een bevestiging.</div>`;
  } else if (a.status === 'geweigerd') {
    blok = `<div class="melding let">U gaf aan dat geen van de momenten schikt. Wij nemen contact met u op voor een nieuwe datum.</div>`;
  } else if (a.status === 'vervallen') {
    blok = `<div class="melding let">Dit voorstel is vervangen door een nieuwer voorstel.</div>`;
  } else if (verlopen) {
    blok = `<div class="melding let">Dit voorstel is verlopen. Neem contact met ons op voor nieuwe data.</div>`;
  }

  const keuze = klaar || verlopen ? '' : `
    ${opties.map((o, i) => `
      <button class="moment" data-i="${i}" onclick="kies(${i})">
        <span class="bol"></span>
        <span><span class="d">${escH(langeDatum(o.datum))}</span>
        ${o.tijdvak ? `<span class="t">${escH(o.tijdvak)}</span>` : ''}</span>
      </button>`).join('')}
    <div id="vak"></div>
    <button class="groot nee" onclick="geenPast()">Geen van deze momenten schikt</button>`;

  return kop + `<div class="kaart">
    ${merk}
    <div class="eyebrow">${escH(SOORTEN[a.soort] || 'Afspraak')} inplannen</div>
    <h1>${escH(waar)}</h1>
    <div class="sub">${escH(s.owner || '')}</div>

    ${blok}

    <div class="wat">
      ${a.omschrijving ? `<b>${escH(a.omschrijving)}</b><br>` : ''}
      ${a.vakman ? `Uitgevoerd door ${escH(a.vakman)}. ` : ''}
      ${a.duur ? `Reken op ${escH(a.duur)}. ` : ''}
      ${klaar || verlopen ? '' : 'Kies hieronder het moment dat u het beste uitkomt.'}
    </div>

    ${keuze}
  </div>

  <script>
    var gekozen = null;
    function kies(i){
      gekozen = i;
      document.querySelectorAll('.moment').forEach(function(m){
        m.classList.toggle('aan', Number(m.dataset.i) === i);
      });
      document.getElementById('vak').innerHTML =
        '<label>Uw naam</label><input id="naam" placeholder="Voor- en achternaam" autocomplete="name">' +
        '<button class="groot ja" onclick="verstuur(false)">Deze afspraak bevestigen</button>' +
        '<div class="klein">Uw keuze wordt met datum en tijd vastgelegd bij het dossier.</div><div id="fout"></div>';
      document.getElementById('naam').focus();
    }
    function geenPast(){
      gekozen = null;
      document.querySelectorAll('.moment').forEach(function(m){ m.classList.remove('aan'); });
      document.getElementById('vak').innerHTML =
        '<label>Waarom schikken deze momenten niet?</label>' +
        '<textarea id="reden" placeholder="Bijvoorbeeld: ik ben die week op vakantie"></textarea>' +
        '<label>Uw naam</label><input id="naam" placeholder="Voor- en achternaam" autocomplete="name">' +
        '<button class="groot ja" onclick="verstuur(true)">Versturen</button><div id="fout"></div>';
      document.getElementById('reden').focus();
    }
    function verstuur(geen){
      var naam = (document.getElementById('naam')||{}).value || '';
      var reden = (document.getElementById('reden')||{}).value || '';
      fetch('/api/afspraak/${escH(a.token)}/kies', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ index: gekozen, naam: naam, geen: geen, reden: reden })
      }).then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
        .then(function(res){
          if (!res.ok) { document.getElementById('fout').innerHTML =
            '<div class="melding err" style="margin-top:14px">' + (res.j.error || 'Er ging iets mis') + '</div>'; return; }
          location.reload();
        });
    }
  </script>` + voet;
}

module.exports = router;
