// Correspondentie per schadezaak in de mailbox zelf.
//
// Het portaal weet al bij welk dossier een bericht hoort. Dit bestand geeft dat
// door aan Gmail: per dossier een label, inkomende post gaat daarheen en verlaat
// het Postvak IN, verzonden post krijgt hetzelfde label erbij. Zo kun je in
// Gmail een dossier openslaan zonder het portaal erbij te halen.
//
// Waarom labels en geen echte mappen: in Gmail zijn dat hetzelfde. Wat je via
// IMAP een map noemt, is voor Gmail een label. Een schuine streep maakt een
// niveau, dus 'Dossiers/FS-2026-0019' komt netjes onder Dossiers te hangen.
//
// Dit staat standaard uit. Het verplaatst echte post in een echte mailbox, en
// dat is niet met een knop terug te draaien. Zet GMAIL_ARCHIVEREN=aan in Coolify
// zodra je het wilt.

const fs = require('fs');
const path = require('path');
const prisma = require('../db');
const { OPSLAG } = require('./documentsoorten');

const HOST = (process.env.IMAP_HOST || 'imap.gmail.com').trim();
const POORT = Number(process.env.IMAP_POORT || 993);
const GEBRUIKER = (process.env.MAIL_GEBRUIKER || '').trim();
const WACHTWOORD = (process.env.MAIL_WACHTWOORD || '').replace(/\s+/g, '');
const INKOMEND_MAP = (process.env.IMAP_MAP || 'INBOX').trim();

// Onder welke naam komen de dossiers te hangen.
const HOOFDMAP = (process.env.GMAIL_HOOFDMAP || 'Dossiers').trim();

const AAN = /^(aan|ja|1|true|on)$/i.test(String(process.env.GMAIL_ARCHIVEREN || '').trim());

// Loopt de gelezen-stand gelijk met Gmail? Standaard ja zodra archiveren aan
// staat. Wil je wel labels maar geen vinkjes, zet dan GMAIL_GELEZEN=uit.
const GELEZEN_MEE = AAN && !/^(uit|nee|0|false|off)$/i.test(String(process.env.GMAIL_GELEZEN || '').trim());

// Hoe ver terug we in Verzonden zoeken naar post die nog geen label heeft.
const VERZONDEN_DAGEN = Number(process.env.GMAIL_VERZONDEN_DAGEN || 30);

function ingesteld() {
  return AAN && !!(GEBRUIKER && WACHTWOORD);
}

function gelezenMee() {
  return GELEZEN_MEE && !!(GEBRUIKER && WACHTWOORD);
}

/* ─────────── de naam van het label ───────────
   Nummer eerst, dan het adres. Het nummer maakt hem uniek en sorteerbaar, het
   adres maakt hem leesbaar. Een schuine streep zou een extra niveau maken, dus
   die halen we uit het adres weg; hetzelfde geldt voor tekens waar Gmail over
   struikelt. */
function schoon(tekst) {
  return String(tekst || '')
    .replace(/[/\\]/g, '-')
    .replace(/["*?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function labelVoor(schade) {
  if (!schade || !schade.nummer) return null;
  const adres = schoon(schade.adres || schade.owner || '');
  const staart = adres ? ` \u00b7 ${adres}` : '';
  // Gmail houdt niet van eindeloze labelnamen; honderd tekens is ruim zat.
  const blad = `${schade.nummer}${staart}`.slice(0, 100).trim();
  return `${HOOFDMAP}/${blad}`;
}

/* ─────────── verbinding ───────────
   Eén verbinding per ronde, niet per bericht. Gmail sluit je sneller buiten als
   je blijft aan- en afmelden. */
async function metMailbox(werk) {
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({
    host: HOST,
    port: POORT,
    secure: true,
    auth: { user: GEBRUIKER, pass: WACHTWOORD },
    logger: false,
  });

  await client.connect();
  try {
    return await werk(client);
  } finally {
    try { await client.logout(); } catch (e) { try { await client.close(); } catch (x) { /* al dicht */ } }
  }
}

// Het label aanmaken als het er nog niet is. Bestaat hij al, dan geeft Gmail
// een foutmelding terug die we mogen negeren.
async function zorgVoorLabel(client, naam) {
  try {
    await client.mailboxCreate(naam.split('/'));
  } catch (e) {
    if (!/already exists|alreadyexists/i.test(e.message || '')) throw e;
  }
}

// Welke map is Verzonden? Gmail noemt die in het Nederlands anders dan in het
// Engels, dus we zoeken op de eigenschap en niet op de naam.
async function verzondenMap(client) {
  const lijst = await client.list();
  const bijzonder = lijst.find((m) => m.specialUse === '\\Sent');
  if (bijzonder) return bijzonder.path;
  const opNaam = lijst.find((m) => /^\[Gmail\]\/(Sent Mail|Verzonden berichten|Verzonden)$/i.test(m.path));
  return opNaam ? opNaam.path : null;
}

/* ─────────── inkomende post ───────────
   Verplaatsen, niet kopiëren: het bericht krijgt het dossierlabel en verlaat
   het Postvak IN. Dat is de afspraak — post die bij een dossier hoort staat in
   het portaal, niet meer in je inbox. */
async function verplaatsInkomend(client, rij, label) {
  const bron = rij.mailbox || INKOMEND_MAP;
  const lock = await client.getMailboxLock(bron);
  try {
    let uid = rij.uid ? String(rij.uid) : null;

    // Staat het bericht er nog? Iemand kan het met de hand hebben verplaatst.
    let bestaat = uid
      ? await client.fetchOne(uid, { uid: true }, { uid: true }).catch(() => null)
      : null;

    /* Geen nummer, of het klopt niet meer. Post die binnenkwam voordat het
       portaal die nummers bijhield heeft er geen. Zoek hem dan op Message-ID
       in deze map. Zit hij er niet, dan staat hij al niet meer in het Postvak
       IN en hoeven we niets te verplaatsen -- dat is de bedoelde eindstand. */
    if (!bestaat && rij.messageId) {
      let treffers = null;
      try {
        treffers = await client.search({ header: { 'message-id': rij.messageId } }, { uid: true });
      } catch (e) {
        return { gelukt: false, reden: `zoeken mislukte: ${e.message}` };
      }
      if (treffers && treffers.length) {
        uid = String(treffers[treffers.length - 1]);
        bestaat = true;
      } else {
        return { gelukt: true, uid: null, alWeg: true };
      }
    }

    if (!bestaat) return { gelukt: false, reden: 'niet meer in deze map' };
    const uit = await client.messageMove(uid, label.split('/'), { uid: true });
    // Na het verplaatsen heeft het bericht een nieuw nummer in de nieuwe map.
    // Dat bewaren we, zodat we het later nog kunnen verplaatsen -- bijvoorbeeld
    // als het adres van het dossier wijzigt en de labelnaam meeverandert.
    let nieuwUid = null;
    if (uit && uit.uidMap && typeof uit.uidMap.get === 'function') {
      nieuwUid = uit.uidMap.get(Number(uid)) || null;
    }
    return { gelukt: true, uid: nieuwUid };
  } finally {
    lock.release();
  }
}

/* ─────────── verzonden post ───────────
   Kopiëren, niet verplaatsen: de brief moet in Verzonden blijven staan én het
   dossierlabel krijgen. Zoeken doen we op ons eigen Message-ID; dat zetten we
   bij het versturen zelf, dus het is exact. */
async function labelVerzonden(client, map, messageId, label) {
  const lock = await client.getMailboxLock(map);
  try {
    const treffers = await client.search({ header: { 'message-id': messageId } }, { uid: true });
    if (!treffers || !treffers.length) return { gelukt: false, reden: 'nog niet in Verzonden' };
    await client.messageCopy(treffers.map(String).join(','), label.split('/'), { uid: true });
    return { gelukt: true };
  } finally {
    lock.release();
  }
}

/* ─────────── gelezen en ongelezen ───────────
   Het vinkje in Gmail is de waarheid. Klik je een bericht open in het portaal,
   dan zetten we het hier ook op gelezen; lees je het in Gmail, dan neemt de
   ronde dat over. Zo staat er nooit iets vet in je mailbox dat een collega al
   heeft afgehandeld, en andersom.                                           */
async function zetGelezen(rij, gelezen) {
  if (!gelezenMee()) return { gelukt: false, reden: 'staat uit' };
  if (!rij || !rij.uid) return { gelukt: false, reden: 'niet meer in de mailbox' };

  try {
    return await metMailbox(async (client) => {
      const lock = await client.getMailboxLock(rij.mailbox || INKOMEND_MAP);
      try {
        const uid = String(rij.uid);
        if (gelezen) await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        else await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
        return { gelukt: true };
      } finally {
        lock.release();
      }
    });
  } catch (e) {
    return { gelukt: false, reden: e.message };
  }
}

/* Wat in Gmail is gelezen ook hier op gelezen zetten, en omgekeerd. Draait mee
   in de ronde, per map één keer, zodat we niet voor elk bericht opnieuw
   verbinding maken. */
async function synchroniseerGelezen(client, rijen) {
  const perMap = new Map();
  rijen.forEach((r) => {
    const m = r.mailbox || INKOMEND_MAP;
    if (!perMap.has(m)) perMap.set(m, []);
    perMap.get(m).push(r);
  });

  let vinkjes = 0; const zoek = [];

  for (const [map, lijst] of perMap) {
    let lock;
    try {
      lock = await client.getMailboxLock(map);
    } catch (e) {
      // De map bestaat niet meer -- dan staan die berichten ergens anders.
      zoek.push(...lijst);
      continue;
    }
    try {
      const opUid = new Map(lijst.map((r) => [Number(r.uid), r]));
      const gezien = new Set();
      const reeks = lijst.map((r) => r.uid).join(',');

      for await (const bericht of client.fetch(reeks, { flags: true }, { uid: true })) {
        const rij = opUid.get(Number(bericht.uid));
        if (!rij) continue;
        gezien.add(rij.id);

        if (!GELEZEN_MEE) continue;
        const inGmail = !!(bericht.flags && typeof bericht.flags.has === 'function'
          && bericht.flags.has('\\Seen'));
        const hier = !!rij.gelezenAt;
        if (inGmail === hier) continue;
        await prisma.inkomend.update({
          where: { id: rij.id },
          data: inGmail
            ? { gelezenAt: new Date(), gelezenDoor: rij.gelezenDoor || 'gelezen in Gmail' }
            : { gelezenAt: null, gelezenDoor: null },
        }).catch(() => {});
        vinkjes++;
      }

      // Wat de mailbox niet teruggeeft staat er niet meer: verplaatst of weg.
      lijst.forEach((r) => { if (!gezien.has(r.id)) zoek.push(r); });
    } finally {
      lock.release();
    }
  }

  return { vinkjes, zoek };
}

/* ─────────── kwijt in de mailbox? ───────────
   Een bericht dat niet meer staat waar wij het achterlieten is met de hand
   verplaatst of weggegooid. Zoek het op Message-ID in Alle berichten -- daar
   staat bij Gmail alles behalve de prullenbak.

   Gevonden  : het is verplaatst of gelabeld. Wij noteren de nieuwe plek en
               laten het bericht in het portaal staan.
   Niet meer : het zit in de prullenbak of is definitief weg. Dan hoort het ook
               hier niet meer te staan; anders blijf je in het portaal post zien
               die je in Gmail al hebt opgeruimd.                             */
async function verdwenenOpsporen(client, rijen) {
  if (!rijen.length) return { verhuisd: 0, verdwenen: 0 };

  const lijst = await client.list();
  const allesMap = (lijst.find((m) => m.specialUse === '\\All')
    || lijst.find((m) => /^\[Gmail\]\/(All Mail|Alle berichten)$/i.test(m.path)) || {}).path;
  if (!allesMap) return { verhuisd: 0, verdwenen: 0 };

  let verhuisd = 0; const weg = [];
  const lock = await client.getMailboxLock(allesMap);
  try {
    for (const r of rijen.slice(0, 200)) {
      if (!r.messageId) continue;
      // Een mislukte zoekopdracht is iets anders dan 'niet gevonden'. Bij een
      // hapering laten we het bericht met rust; anders gooien we post weg
      // omdat de verbinding even stokte.
      let treffers = null; let mislukt = false;
      try {
        treffers = await client.search({ header: { 'message-id': r.messageId } }, { uid: true });
      } catch (e) {
        mislukt = true;
      }
      if (mislukt) continue;

      if (treffers && treffers.length) {
        await prisma.inkomend.update({
          where: { id: r.id },
          data: { mailbox: allesMap, uid: treffers[treffers.length - 1] },
        }).catch(() => {});
        verhuisd++;
      } else {
        weg.push(r);
      }
    }
  } finally {
    lock.release();
  }

  // Uit het portaal halen, inclusief de bijlagen die we hadden bewaard.
  for (const r of weg) {
    for (const a of (Array.isArray(r.bijlagen) ? r.bijlagen : [])) {
      if (!a || !a.opslagnaam) continue;
      try { fs.unlinkSync(path.join(OPSLAG, path.basename(a.opslagnaam))); }
      catch (e) { /* al weg */ }
    }
  }
  if (weg.length) {
    await prisma.inkomend.deleteMany({ where: { id: { in: weg.map((r) => r.id) } } }).catch(() => {});
  }

  return { verhuisd, verdwenen: weg.length };
}

/* ─────────── één ronde ───────────
   Alles wat nog geen label heeft, of onder het verkeerde label hangt omdat de
   koppeling is gewijzigd. Loopt er iets mis bij één bericht, dan gaat de rest
   gewoon door; de volgende ronde probeert het opnieuw. */
async function archiveerRonde(opties = {}) {
  if (!ingesteld() && !gelezenMee()) {
    return { gelukt: false, reden: 'archiveren staat uit', verplaatst: 0, gelabeld: 0, gelijkgezet: 0 };
  }

  const grens = new Date(Date.now() - VERZONDEN_DAGEN * 864e5);

  const inkomend = await prisma.inkomend.findMany({
    where: {
      schadeId: { not: null },
      stand: { not: 'genegeerd' },
      ...(opties.id ? { id: opties.id } : {}),
    },
    include: { schade: { select: { nummer: true, adres: true, owner: true } } },
    take: 200,
  });

  const uitgaand = await prisma.verzending.findMany({
    where: {
      gearchiveerd: null,
      status: 'verstuurd',
      messageId: { not: null },
      createdAt: { gte: grens },
    },
    include: { schade: { select: { nummer: true, adres: true, owner: true } } },
    take: 200,
  });

  // Alleen wat er nog niet goed staat.
  // Alles wat nog niet onder het juiste label hangt. Ook zonder berichtnummer:
  // verplaatsInkomend zoekt hem dan op Message-ID op.
  const teVerplaatsen = ingesteld() ? inkomend.filter((r) => {
    const doel = labelVoor(r.schade);
    return doel && r.gearchiveerd !== doel && (r.uid || r.messageId);
  }) : [];

  // Alles wat nog in de mailbox te vinden is, om de vinkjes gelijk te zetten.
  // Alles wat we in de mailbox kunnen terugvinden: om de vinkjes gelijk te
  // zetten, en om te zien of het er nog staat. Dat laatste hoort er ook bij
  // als de vinkjes niet meelopen -- anders blijft post in het portaal staan die
  // je in Gmail allang hebt weggegooid.
  const teVergelijken = await prisma.inkomend.findMany({
    where: {
      uid: { not: null },
      ...(opties.id ? { id: opties.id } : {}),
    },
    select: {
      id: true, uid: true, mailbox: true, messageId: true,
      gelezenAt: true, gelezenDoor: true, bijlagen: true,
    },
    orderBy: { ontvangenAt: 'desc' },
    take: 300,
  });

  if (!teVerplaatsen.length && !uitgaand.length && !teVergelijken.length) {
    return { gelukt: true, verplaatst: 0, gelabeld: 0, gelijkgezet: 0,
      verhuisd: 0, verdwenen: 0, fouten: [] };
  }

  let verplaatst = 0; let gelabeld = 0; let gelijkgezet = 0;
  let verhuisd = 0; let verdwenen = 0; const fouten = []; const regels = [];

  // Korte aanduiding van een bericht, voor in de terugkoppeling.
  const kort = (r) => String(r.onderwerp || r.id).slice(0, 60);

  try {
    await metMailbox(async (client) => {
      const gemaakt = new Set();

      for (const rij of teVerplaatsen) {
        const label = labelVoor(rij.schade);
        try {
          if (!gemaakt.has(label)) { await zorgVoorLabel(client, label); gemaakt.add(label); }
          const uit = await verplaatsInkomend(client, rij, label);
          if (uit.gelukt) {
            await prisma.inkomend.update({
              where: { id: rij.id },
              data: { gearchiveerd: label, mailbox: label, uid: uit.uid || null },
            });
            // Stond hij al niet meer in het Postvak IN, dan is er niets
            // verplaatst; wel is de eindstand nu goed vastgelegd.
            if (uit.alWeg) {
              regels.push(`${kort(rij)}: stond al niet meer in het Postvak IN`);
            } else {
              verplaatst++;
              regels.push(`${kort(rij)}: verplaatst naar ${label}`);
            }
          } else {
            // Wel blijven proberen: een hapering mag geen bericht permanent
            // buiten beeld zetten. Het staat in de lijst met redenen.
            fouten.push(`${kort(rij)}: ${uit.reden}`);
          }
        } catch (e) {
          fouten.push(`${rij.onderwerp || rij.id}: ${e.message}`);
        }
      }

      // Eerst verplaatsen, dan pas vergelijken: anders kijken we naar berichten
      // die net van map zijn gewisseld en klopt het nummer niet meer.
      if (teVergelijken.length) {
        // Wat we net hebben verplaatst slaan we over: dat heeft een nieuw
        // nummer gekregen en klopt al.
        const vers = teVergelijken.filter((r) => !teVerplaatsen.some((v) => v.id === r.id));
        if (vers.length) {
          try {
            const uitkomst = await synchroniseerGelezen(client, vers);
            gelijkgezet = uitkomst.vinkjes;
            const kwijt = await verdwenenOpsporen(client, uitkomst.zoek);
            verhuisd = kwijt.verhuisd;
            verdwenen = kwijt.verdwenen;
          } catch (e) {
            fouten.push(`gelijkzetten: ${e.message}`);
          }
        }
      }

      if (uitgaand.length && ingesteld()) {
        const map = await verzondenMap(client);
        if (!map) {
          fouten.push('map Verzonden niet gevonden');
        } else {
          for (const v of uitgaand) {
            const label = labelVoor(v.schade);
            if (!label) continue;
            try {
              if (!gemaakt.has(label)) { await zorgVoorLabel(client, label); gemaakt.add(label); }
              const uit = await labelVerzonden(client, map, v.messageId, label);
              if (uit.gelukt) {
                await prisma.verzending.update({ where: { id: v.id }, data: { gearchiveerd: label } });
                gelabeld++;
              }
              // Nog niet gevonden? Dan staat hij er nog niet. Volgende ronde.
            } catch (e) {
              fouten.push(`${v.onderwerp || v.id}: ${e.message}`);
            }
          }
        }
      }
    });
  } catch (e) {
    return { gelukt: false, reden: e.message, verplaatst, gelabeld, gelijkgezet,
      verhuisd, verdwenen, fouten, regels, bekeken: teVerplaatsen.length };
  }

  return { gelukt: true, verplaatst, gelabeld, gelijkgezet, verhuisd, verdwenen,
    fouten, regels, bekeken: teVerplaatsen.length };
}

/* Meteen na het koppelen, zodat het bericht direct uit de inbox verdwijnt in
   plaats van bij de volgende ronde. Mislukt het, dan pakt de ronde het op. */
function archiveerNu(inkomendId) {
  if (!ingesteld() && !gelezenMee()) {
    return Promise.resolve({ gelukt: false, reden: 'archiveren staat uit' });
  }
  return archiveerRonde({ id: inkomendId }).catch((e) => ({ gelukt: false, reden: e.message }));
}


/* ─────────── weggooien ───────────
   Wat is weggefilterd — nieuwsbrieven, reclame, automatische antwoorden —
   hoeft niet in je mailbox te blijven staan. Dit verplaatst die berichten naar
   de prullenbak van Gmail. Daar blijven ze dertig dagen staan, dus het is geen
   onherstelbare stap; wel is het weg uit je zicht.                          */
async function naarPrullenbak(rijen) {
  if (!(GEBRUIKER && WACHTWOORD)) return { gelukt: false, reden: 'geen mailbox', weg: 0 };

  const alles = rijen || [];
  const teDoen = alles.filter((r) => r.uid);
  // Post die binnenkwam voordat het portaal het berichtnummer bijhield heeft
  // geen uid. Die zoeken we straks op Message-ID op, anders blijft hij in Gmail
  // staan terwijl hij in het portaal al weg is.
  const zoeken = alles.filter((r) => !r.uid && r.messageId).slice(0, 200);
  if (!teDoen.length && !zoeken.length) return { gelukt: true, weg: 0, fouten: [] };

  let weg = 0; const fouten = [];

  try {
    await metMailbox(async (client) => {
      const lijst = await client.list();
      const bak = (lijst.find((m) => m.specialUse === '\\Trash')
        || lijst.find((m) => /^\[Gmail\]\/(Trash|Prullenbak)$/i.test(m.path)) || {}).path;
      if (!bak) { fouten.push('prullenbak niet gevonden'); return; }

      /* Zoeken op Message-ID. Eerst in het Postvak IN, en anders in Alle
         berichten -- daar staat bij Gmail alles wat niet in de prullenbak zit,
         ook als het al een label heeft gekregen. */
      if (zoeken.length) {
        const allesMap = (lijst.find((m) => m.specialUse === '\\All')
          || lijst.find((m) => /^\[Gmail\]\/(All Mail|Alle berichten)$/i.test(m.path)) || {}).path;
        const mappen = [INKOMEND_MAP, allesMap].filter(Boolean);
        const nogTeVinden = zoeken.slice();

        for (const map of mappen) {
          if (!nogTeVinden.length) break;
          let lock;
          try { lock = await client.getMailboxLock(map); } catch (e) { continue; }
          try {
            const gevonden = [];
            for (let i = nogTeVinden.length - 1; i >= 0; i--) {
              const r = nogTeVinden[i];
              const treffers = await client
                .search({ header: { 'message-id': r.messageId } }, { uid: true })
                .catch(() => null);
              if (treffers && treffers.length) {
                gevonden.push(...treffers);
                nogTeVinden.splice(i, 1);
              }
            }
            if (gevonden.length) {
              await client.messageMove(gevonden.map(String).join(','), bak, { uid: true });
              weg += gevonden.length;
            }
          } catch (e) {
            fouten.push(`${map}: ${e.message}`);
          } finally {
            lock.release();
          }
        }

        if (nogTeVinden.length) {
          fouten.push(`${nogTeVinden.length} bericht(en) niet meer in de mailbox gevonden`);
        }
      }

      const perMap = new Map();
      teDoen.forEach((r) => {
        const m = r.mailbox || INKOMEND_MAP;
        if (!perMap.has(m)) perMap.set(m, []);
        perMap.get(m).push(r);
      });

      for (const [map, groep] of perMap) {
        if (map === bak) { weg += groep.length; continue; }
        let lock;
        try { lock = await client.getMailboxLock(map); } catch (e) { continue; }
        try {
          await client.messageMove(groep.map((r) => String(r.uid)).join(','), bak, { uid: true });
          weg += groep.length;
        } catch (e) {
          fouten.push(`${map}: ${e.message}`);
        } finally {
          lock.release();
        }
      }
    });
  } catch (e) {
    return { gelukt: false, reden: e.message, weg, fouten };
  }

  return { gelukt: true, weg, fouten };
}

module.exports = {
  ingesteld, gelezenMee, labelVoor, archiveerRonde, archiveerNu, zetGelezen, naarPrullenbak,
  HOOFDMAP, AAN, GEBRUIKER,
};
