const crypto = require('crypto');
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth/middleware');
const { BEDRIJF, PORTAAL, datumNL } = require('../lib/brieven');

const router = express.Router();

// De machtiging waarmee de klant ons toestemming geeft namens hem op te treden.
// Hij krijgt een link, leest wat hij tekent, en zet er zijn naam onder. Wat er
// getekend is bewaren we woordelijk -- niet alleen een vinkje, maar de tekst
// zoals die op dat moment op het scherm stond.

const escH = (v) =>
  String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function langeDatum(d) {
  return new Date(d).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
}

// De tekst van de machtiging. Kort, in gewone taal, en zonder verrassingen.
function machtigingTekst(s) {
  const adres = [s.adres, s.plaats].filter(Boolean).join(', ');
  const wie = s.opdrachtgever || s.owner;
  return [
    `Ondergetekende, ${wie}, machtigt ${BEDRIJF.naam} om op te treden bij de afhandeling ` +
      `van de waterschade op ${adres}.`,
    'Deze machtiging geldt voor het volgende:',
    '\u2022 de schade melden en het dossier indienen bij de verzekeraar;\n' +
      '\u2022 stukken opvragen bij de verzekeraar, de tussenpersoon en de VvE-beheerder;\n' +
      '\u2022 namens ondergetekende overleggen over de omvang van de schade en het herstel;\n' +
      '\u2022 het herstel organiseren en daarvoor leveranciers inschakelen.',
    'Deze machtiging geeft geen recht om betalingen te ontvangen namens ondergetekende, ' +
      'en vervalt zodra het dossier is afgesloten. U kunt hem eerder intrekken door dat ' +
      `te melden bij ${BEDRIJF.email}.`,
  ].join('\n\n');
}

async function log(user, text, schadeId, detail) {
  await prisma.logEntry.create({
    data: {
      text,
      detail: detail || null,
      schadeId: schadeId || null,
      byUserId: user ? user.id : null,
      byName: user ? user.naam : 'Klantportaal',
    },
  });
}

/* ══════ wat de klant ziet ══════ */

router.get('/machtiging/:token', async (req, res) => {
  const m = await prisma.machtiging.findUnique({
    where: { token: req.params.token },
    include: { schade: { select: { nummer: true, adres: true, plaats: true, owner: true } } },
  });
  if (!m) return res.status(404).send(pagina({ fout: 'Deze link bestaat niet of is verlopen.' }));
  if (m.status === 'ingetrokken') {
    return res.send(pagina({ fout: 'Deze machtiging is ingetrokken. U hoeft niets te doen.' }));
  }

  // Het openen leggen we vast: zo weet je of hij hem gezien heeft.
  if (m.status !== 'getekend') {
    await prisma.machtiging.update({
      where: { id: m.id },
      data: {
        status: m.status === 'open' ? 'geopend' : m.status,
        geopendAt: m.geopendAt || new Date(),
        openCount: { increment: 1 },
      },
    });
    if (!m.geopendAt) {
      await log(null, 'Machtiging geopend door de klant', m.schadeId, m.naarNaam);
    }
  }

  res.send(pagina({ m }));
});

router.post('/machtiging/:token/tekenen', express.json(), async (req, res) => {
  const m = await prisma.machtiging.findUnique({ where: { token: req.params.token } });
  if (!m) return res.status(404).json({ error: 'Deze link bestaat niet meer.' });
  if (m.status === 'getekend') return res.json({ ok: true, al: true });
  if (m.status === 'ingetrokken') return res.status(400).json({ error: 'Deze machtiging is ingetrokken.' });

  const naam = String(req.body?.naam || '').trim();
  const plaats = String(req.body?.plaats || '').trim();
  const functie = String(req.body?.functie || '').trim();
  const krabbel = String(req.body?.handtekening || '');

  if (naam.length < 3) return res.status(400).json({ error: 'Vul uw volledige naam in.' });
  if (!plaats) return res.status(400).json({ error: 'Vul in waar u ondertekent.' });
  if (m.zakelijk && !functie) {
    return res.status(400).json({ error: 'Vul uw functie in, bijvoorbeeld beheerder of bestuurslid.' });
  }
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(krabbel)) {
    return res.status(400).json({ error: 'Zet uw handtekening in het vak.' });
  }
  // Een lege of piepkleine krabbel telt niet als handtekening.
  if (krabbel.length < 1200) return res.status(400).json({ error: 'De handtekening is te klein om te bewaren.' });
  if (krabbel.length > 400000) return res.status(400).json({ error: 'De handtekening is te groot.' });
  if (req.body?.akkoord !== true) return res.status(400).json({ error: 'Zet een vinkje bij de verklaring.' });

  // Alleen het begin van het adres, genoeg als bewijs en niet meer dan dat.
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0].trim().split('.').slice(0, 2).join('.') + '.x.x';

  const uit = await prisma.machtiging.update({
    where: { id: m.id },
    data: {
      status: 'getekend',
      getekendAt: new Date(),
      tekenNaam: naam,
      tekenFunctie: functie || null,
      tekenPlaats: plaats || null,
      handtekening: krabbel,
      tekenIp: ip,
    },
  });

  // Het actiepunt sluit zichzelf: de machtiging is binnen.
  await prisma.actiepunt.updateMany({
    where: { schadeId: m.schadeId, soort: 'machtiging', open: true },
    data: { open: false, afgerondAt: new Date() },
  });

  await log(null, 'Machtiging getekend', m.schadeId,
    `${naam}${functie ? ', ' + functie : ''}${plaats ? ' te ' + plaats : ''}`);

  res.json({ ok: true, getekendAt: uit.getekendAt });
});

/* ══════ het portaal ══════ */
router.use(requireAuth);

router.get('/schades/:nummer/machtigingen', async (req, res) => {
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer }, select: { id: true } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const lijst = await prisma.machtiging.findMany({
    where: { schadeId: s.id },
    orderBy: { createdAt: 'desc' },
  });

  // Staat er een open machtiging langer stil dan de termijn, dan gaat de
  // herinnering vanzelf de deur uit. Zo hoeft niemand het te onthouden.
  for (const m of lijst) {
    if (m.status === 'getekend' || m.status === 'ingetrokken') continue;
    const vanaf = m.herinnerdAt || m.verstuurdAt;
    const dagen = Math.floor((Date.now() - new Date(vanaf).getTime()) / 864e5);
    if (dagen >= (m.herinnerDagen || 3) && m.herinneringen < 4) {
      await prisma.machtiging.update({
        where: { id: m.id },
        data: { herinneringen: { increment: 1 }, herinnerdAt: new Date() },
      });
      await log(null, `${m.herinneringen + 1}e herinnering machtiging verstuurd`, m.schadeId,
        `${m.naarNaam} \u00b7 ${m.status === 'geopend' ? 'wel geopend, niet getekend' : 'nog niet geopend'}`);
      m.herinneringen += 1;
      m.herinnerdAt = new Date();
    }
  }

  res.json({
    machtigingen: lijst.map((m) => ({
      ...m,
      // De afbeelding zelf halen we apart op; in de lijst hebben we alleen
      // nodig te weten dat hij er is.
      handtekening: undefined,
      heeftKrabbel: !!m.handtekening,
      link: `${PORTAAL}/machtiging/${m.token}`,
      dagenStil: Math.floor((Date.now() - new Date(m.herinnerdAt || m.verstuurdAt).getTime()) / 864e5),
    })),
  });
});

router.post('/schades/:nummer/machtigingen', async (req, res) => {
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const naarWie = String(req.body?.naar || 'klant');
  const naam = naarWie === 'beheerder' ? (s.opdrachtgever || s.owner) : s.owner;
  const email = naarWie === 'beheerder' ? s.beheerderEmail : s.email;
  if (!email) {
    return res.status(400).json({ error: `Er staat geen e-mailadres bij ${naam}. Vul dat eerst in bij Contact.` });
  }

  // Loopt er al een? Dan die opnieuw sturen in plaats van een tweede maken.
  const bestaat = await prisma.machtiging.findFirst({
    where: { schadeId: s.id, status: { in: ['open', 'geopend'] } },
  });
  if (bestaat) {
    const uit = await prisma.machtiging.update({
      where: { id: bestaat.id },
      data: { verstuurdAt: new Date(), herinneringen: { increment: 1 }, herinnerdAt: new Date() },
    });
    await log(req.user, 'Machtiging opnieuw verstuurd', s.id, naam);
    return res.json({ machtiging: { ...uit, link: `${PORTAAL}/machtiging/${uit.token}` }, opnieuw: true });
  }

  const m = await prisma.machtiging.create({
    data: {
      schadeId: s.id,
      token: crypto.randomBytes(24).toString('base64url'),
      tekst: machtigingTekst(s),
      naarNaam: naam,
      naarEmail: email,
      kanaal: req.body?.kanaal === 'app' ? 'app' : 'mail',
      zakelijk: naarWie === 'beheerder',
      herinnerDagen: Math.max(1, Math.min(Number(req.body?.herinnerDagen) || 3, 30)),
    },
  });

  const open = await prisma.actiepunt.findFirst({
    where: { schadeId: s.id, soort: 'machtiging', open: true },
  });
  const tekst = `Wacht op de getekende machtiging \u2014 ${naam}`;
  if (open) await prisma.actiepunt.update({ where: { id: open.id }, data: { tekst } });
  else await prisma.actiepunt.create({
    data: { schadeId: s.id, soort: 'machtiging', tekst, klant: true, doorNaam: req.user.naam },
  });

  await log(req.user, 'Machtiging verstuurd', s.id, `${naam} \u00b7 ${email}`);
  res.status(201).json({ machtiging: { ...m, link: `${PORTAAL}/machtiging/${m.token}` } });
});

// Het bewijsstuk: de tekst zoals hij getekend is, met de krabbel eronder.
router.get('/machtigingen/:id/bewijs', async (req, res) => {
  const m = await prisma.machtiging.findUnique({
    where: { id: req.params.id },
    include: { schade: { select: { nummer: true, adres: true, plaats: true } } },
  });
  if (!m) return res.status(404).send('Niet gevonden');
  if (m.status !== 'getekend') return res.status(400).send('Deze machtiging is nog niet getekend.');
  res.send(bewijsPagina(m));
});

router.post('/machtigingen/:id/herinneren', async (req, res) => {
  const m = await prisma.machtiging.findUnique({ where: { id: req.params.id } });
  if (!m) return res.status(404).json({ error: 'Niet gevonden' });
  if (m.status === 'getekend') return res.status(400).json({ error: 'Deze is al getekend.' });

  const uit = await prisma.machtiging.update({
    where: { id: m.id },
    data: { herinneringen: { increment: 1 }, herinnerdAt: new Date() },
  });
  await log(req.user, `${uit.herinneringen}e herinnering machtiging verstuurd`, m.schadeId,
    `${m.naarNaam} \u00b7 ${m.status === 'geopend' ? 'wel geopend, niet getekend' : 'nog niet geopend'}`);

  res.json({ machtiging: { ...uit, link: `${PORTAAL}/machtiging/${uit.token}` } });
});

router.post('/machtigingen/:id/intrekken', async (req, res) => {
  const m = await prisma.machtiging.findUnique({ where: { id: req.params.id } });
  if (!m) return res.status(404).json({ error: 'Niet gevonden' });

  await prisma.machtiging.update({ where: { id: m.id }, data: { status: 'ingetrokken' } });
  await prisma.actiepunt.updateMany({
    where: { schadeId: m.schadeId, soort: 'machtiging', open: true },
    data: { open: false, afgerondAt: new Date() },
  });
  await log(req.user, 'Machtiging ingetrokken', m.schadeId, m.naarNaam);
  res.json({ ok: true });
});

/* ══════ de pagina die de klant opent ══════ */
function pagina({ m, fout }) {
  const kop = `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Machtiging \u2014 ${escH(BEDRIJF.naam)}</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&family=Inter:wght@400;450;500;600&display=swap" rel="stylesheet">
<style>
  :root{--navy:#151F35;--teal:#009BA8;--teal-deep:#007E8A;--teal-soft:#E0F4F6;--teal-ink:#00707B;
    --line:#E4E9EF;--muted:#677589;--muted-2:#8E9AAB;--green:#16A46A;--green-soft:#E4F7EF;--red:#C4453C}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#F7F9FB;font-family:'Inter',system-ui,sans-serif;color:#16202F;line-height:1.6;
    padding:24px 16px 60px}
  .vel{max-width:640px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:16px;
    box-shadow:0 10px 34px rgba(21,31,53,.07);overflow:hidden}
  .kop{padding:26px 30px 22px;border-bottom:1px solid var(--line)}
  .logo{font-family:'Poppins',sans-serif;font-weight:600;font-size:21px;letter-spacing:.18em;color:var(--navy)}
  .sub{font-family:'Poppins',sans-serif;font-size:10px;letter-spacing:.3em;color:var(--teal);margin-top:2px}
  .body{padding:26px 30px 30px}
  h1{font-family:'Poppins',sans-serif;font-size:20px;color:var(--navy);margin-bottom:6px}
  .meta{font-size:13px;color:var(--muted);margin-bottom:22px}
  .tekst{white-space:pre-line;font-size:14.5px;border:1px solid var(--line);border-radius:12px;
    padding:18px 20px;background:#FCFDFE;margin-bottom:22px}
  label{display:block;font-size:12px;color:var(--muted);margin-bottom:5px}
  input[type=text]{width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:11px;
    font-family:inherit;font-size:15px;margin-bottom:16px;background:#fff}
  input[type=text]:focus{outline:none;border-color:var(--teal);box-shadow:0 0 0 3px rgba(0,155,168,.12)}
  .vink{display:flex;gap:11px;align-items:flex-start;font-size:14px;margin-bottom:22px;cursor:pointer}
  .vink input{width:19px;height:19px;margin-top:2px;flex:none;accent-color:var(--teal)}
  button{width:100%;padding:15px;border:none;border-radius:12px;background:var(--teal);color:#fff;
    font-family:inherit;font-size:15.5px;font-weight:600;cursor:pointer}
  button:hover{background:var(--teal-deep)}
  button:disabled{opacity:.5;cursor:not-allowed}
  .klaar{background:var(--green-soft);color:#12704A;border-radius:12px;padding:20px 22px;font-size:15px}
  .klaar b{display:block;font-family:'Poppins',sans-serif;font-size:17px;margin-bottom:5px}
  .fout{background:#FBECEA;color:#8E3A34;border-radius:12px;padding:20px 22px;font-size:15px}
  .melding{font-size:13px;color:var(--red);margin-bottom:14px;display:none}
  .krabbel{border:1px solid var(--line);border-radius:12px;background:#FCFDFE;padding:6px;margin-bottom:8px}
  .krabbel canvas{width:100%;height:150px;display:block;border-radius:9px;background:#fff;
    touch-action:none;cursor:crosshair}
  .krabbelhulp{display:flex;justify-content:space-between;align-items:center;gap:10px;
    padding:6px 6px 2px;font-size:11.5px;color:var(--muted-2)}
  .wis{width:auto;padding:6px 12px;background:transparent;border:1px solid var(--line);
    color:var(--muted);font-size:12px;font-weight:500;border-radius:8px}
  .wis:hover{background:#F3F6F9;border-color:#c8d0db}
  .datumregel{font-size:13px;color:var(--muted);margin-bottom:20px}
  .krabbelklaar{margin-top:16px;border:1px solid var(--line);border-radius:12px;padding:14px;background:#fff}
  .krabbelklaar img{max-width:100%;max-height:130px;display:block;margin:0 auto}
  .voet{padding:16px 30px 22px;border-top:1px solid var(--line);font-size:11.5px;color:var(--muted-2);
    display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
</style></head><body><div class="vel">
<div class="kop"><div class="logo">FORWARD</div><div class="sub">SCHADEHERSTEL</div></div>`;

  const voet = `<div class="voet"><span>${escH(BEDRIJF.naam)} \u00b7 ${escH(BEDRIJF.email)}</span>
    <span>KvK ${escH(BEDRIJF.kvk)}</span></div></div></body></html>`;

  if (fout) return `${kop}<div class="body"><div class="fout">${escH(fout)}</div></div>${voet}`;

  if (m.status === 'getekend') {
    return `${kop}<div class="body">
      <div class="klaar"><b>Getekend, dank u wel.</b>
      ${escH(m.tekenNaam)}${m.tekenFunctie ? ', ' + escH(m.tekenFunctie) : ''} heeft deze machtiging
      ondertekend op ${langeDatum(m.getekendAt)}${m.tekenPlaats ? ' te ' + escH(m.tekenPlaats) : ''}.
      Wij gaan verder met het dossier en houden u op de hoogte.</div>
      ${m.handtekening ? `<div class="krabbelklaar"><img src="${escH(m.handtekening)}" alt="handtekening"></div>` : ''}
    </div>${voet}`;
  }

  return `${kop}<div class="body">
    <h1>Machtiging ondertekenen</h1>
    <div class="meta">Dossier ${escH(m.schade.nummer)} \u00b7 ${escH([m.schade.adres, m.schade.plaats].filter(Boolean).join(', '))}</div>
    <div class="tekst">${escH(m.tekst)}</div>
    <div class="melding" id="melding"></div>
    <label for="naam">Uw volledige naam</label>
    <input type="text" id="naam" placeholder="voor- en achternaam" autocomplete="name">
    ${m.zakelijk ? `<label for="functie">Uw functie</label>
    <input type="text" id="functie" placeholder="bijvoorbeeld beheerder of bestuurslid" autocomplete="organization-title">` : ''}
    <label for="plaats">Plaats</label>
    <input type="text" id="plaats" placeholder="waar u dit ondertekent" autocomplete="address-level2">

    <label>Uw handtekening</label>
    <div class="krabbel">
      <canvas id="doek" width="900" height="300"></canvas>
      <div class="krabbelhulp"><span>Zet uw handtekening met de muis of uw vinger</span>
        <button type="button" class="wis" onclick="wissen()">Wissen</button></div>
    </div>

    <div class="datumregel">Ondertekend op ${langeDatum(new Date())}</div>

    <label class="vink"><input type="checkbox" id="akkoord">
      <span>Ik heb deze machtiging gelezen en ga ermee akkoord. Ik verklaar bevoegd te zijn
      om namens ${escH(m.naarNaam)} te tekenen.</span></label>
    <button id="knop" onclick="tekenen()">Ondertekenen en versturen</button>
  </div>${voet}
  <script>
    // Tekenen met muis of vinger. Het doek is groter dan het beeld, zodat de
    // handtekening scherp blijft op een telefoon.
    var doek = document.getElementById('doek');
    var pen = doek.getContext('2d');
    var bezig = false, iets = false, vorigeX = 0, vorigeY = 0;

    pen.lineWidth = 2.6;
    pen.lineCap = 'round';
    pen.lineJoin = 'round';
    pen.strokeStyle = '#151F35';

    function plek(e){
      var r = doek.getBoundingClientRect();
      var p = e.touches ? e.touches[0] : e;
      return { x: (p.clientX - r.left) * (doek.width / r.width),
               y: (p.clientY - r.top) * (doek.height / r.height) };
    }
    function start(e){
      e.preventDefault();
      bezig = true;
      var p = plek(e); vorigeX = p.x; vorigeY = p.y;
    }
    function trek(e){
      if (!bezig) return;
      e.preventDefault();
      var p = plek(e);
      pen.beginPath(); pen.moveTo(vorigeX, vorigeY); pen.lineTo(p.x, p.y); pen.stroke();
      vorigeX = p.x; vorigeY = p.y; iets = true;
    }
    function stop(){ bezig = false; }

    doek.addEventListener('mousedown', start);
    doek.addEventListener('mousemove', trek);
    window.addEventListener('mouseup', stop);
    doek.addEventListener('touchstart', start, {passive:false});
    doek.addEventListener('touchmove', trek, {passive:false});
    doek.addEventListener('touchend', stop);

    function wissen(){ pen.clearRect(0,0,doek.width,doek.height); iets = false; }

    function tekenen(){
      var naam = document.getElementById('naam').value.trim();
      var plaats = document.getElementById('plaats').value.trim();
      var fnV = document.getElementById('functie');
      var functie = fnV ? fnV.value.trim() : '';
      var akkoord = document.getElementById('akkoord').checked;
      var mld = document.getElementById('melding');
      var knop = document.getElementById('knop');

      function zeg(t){ mld.textContent = t; mld.style.display = 'block'; knop.disabled = false; }

      mld.style.display = 'none';
      if (!iets) { zeg('Zet uw handtekening in het vak.'); return; }
      knop.disabled = true;

      fetch('/machtiging/${escH(m.token)}/tekenen', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({naam:naam, plaats:plaats, functie:functie, akkoord:akkoord,
          handtekening: doek.toDataURL('image/png')})
      }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
        .then(function(u){
          if (!u.ok) { zeg(u.d.error || 'Er ging iets mis.'); return; }
          location.reload();
        })
        .catch(function(){ zeg('Geen verbinding. Probeer het zo nog eens.'); });
    }
  <\/script>`;
}

// Het bewijsstuk om te bewaren of door te sturen: de tekst zoals hij getekend
// is, met naam, functie, plaats, datum en de krabbel eronder.
function bewijsPagina(m) {
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<title>Machtiging ${escH(m.schade.nummer)}</title>
<style>
  body{font-family:'Inter',system-ui,sans-serif;color:#16202F;line-height:1.6;max-width:720px;
    margin:0 auto;padding:40px 32px;font-size:14px}
  .kop{display:flex;justify-content:space-between;align-items:flex-start;
    border-bottom:1px solid #E4E9EF;padding-bottom:18px;margin-bottom:26px}
  .logo{font-weight:600;font-size:20px;letter-spacing:.18em;color:#151F35}
  .sub{font-size:9.5px;letter-spacing:.3em;color:#009BA8;margin-top:2px}
  h1{font-size:19px;color:#151F35;margin:0 0 4px}
  .meta{font-size:12.5px;color:#677589;margin-bottom:24px}
  .tekst{white-space:pre-line;border:1px solid #E4E9EF;border-radius:10px;padding:18px 20px;
    background:#FCFDFE;margin-bottom:26px}
  .onder{display:flex;gap:34px;flex-wrap:wrap;align-items:flex-end}
  .veld{font-size:12.5px;color:#677589}
  .veld b{display:block;font-size:14.5px;color:#151F35;font-weight:500;margin-top:2px}
  .krab{border-bottom:1px solid #151F35;padding-bottom:4px;min-width:230px}
  .krab img{max-height:90px;display:block}
  .voet{margin-top:34px;padding-top:12px;border-top:1px solid #E4E9EF;font-size:11px;color:#8E9AAB}
  @media print{body{padding:0}}
</style></head><body>
  <div class="kop"><div><div class="logo">FORWARD</div><div class="sub">SCHADEHERSTEL</div></div>
    <div style="text-align:right;font-size:12px;color:#677589">Machtiging<br>${escH(m.schade.nummer)}</div></div>
  <h1>Machtiging</h1>
  <div class="meta">${escH([m.schade.adres, m.schade.plaats].filter(Boolean).join(', '))}</div>
  <div class="tekst">${escH(m.tekst)}</div>
  <div class="onder">
    <div class="krab">${m.handtekening ? `<img src="${escH(m.handtekening)}" alt="handtekening">` : ''}</div>
    <div class="veld">Naam<b>${escH(m.tekenNaam || '')}</b></div>
    ${m.tekenFunctie ? `<div class="veld">Functie<b>${escH(m.tekenFunctie)}</b></div>` : ''}
    <div class="veld">Plaats<b>${escH(m.tekenPlaats || '')}</b></div>
    <div class="veld">Datum<b>${langeDatum(m.getekendAt)}</b></div>
  </div>
  <div class="voet">Digitaal ondertekend via ${escH(PORTAAL)} \u00b7 vastgelegd op
    ${new Date(m.getekendAt).toLocaleString('nl-NL')} \u00b7 herkomst ${escH(m.tekenIp || '')}</div>
</body></html>`;
}

module.exports = router;
