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

const prisma = require('../db');

const HOST = (process.env.IMAP_HOST || 'imap.gmail.com').trim();
const POORT = Number(process.env.IMAP_POORT || 993);
const GEBRUIKER = (process.env.MAIL_GEBRUIKER || '').trim();
const WACHTWOORD = (process.env.MAIL_WACHTWOORD || '').replace(/\s+/g, '');
const INKOMEND_MAP = (process.env.IMAP_MAP || 'INBOX').trim();

// Onder welke naam komen de dossiers te hangen.
const HOOFDMAP = (process.env.GMAIL_HOOFDMAP || 'Dossiers').trim();

const AAN = /^(aan|ja|1|true|on)$/i.test(String(process.env.GMAIL_ARCHIVEREN || '').trim());

// Hoe ver terug we in Verzonden zoeken naar post die nog geen label heeft.
const VERZONDEN_DAGEN = Number(process.env.GMAIL_VERZONDEN_DAGEN || 30);

function ingesteld() {
  return AAN && !!(GEBRUIKER && WACHTWOORD);
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
    // Staat het bericht er nog? Iemand kan het met de hand hebben verplaatst.
    const bestaat = await client.fetchOne(String(rij.uid), { uid: true }, { uid: true }).catch(() => null);
    if (!bestaat) return { gelukt: false, reden: 'niet meer in deze map' };
    const uit = await client.messageMove(String(rij.uid), label.split('/'), { uid: true });
    // Na het verplaatsen heeft het bericht een nieuw nummer in de nieuwe map.
    // Dat bewaren we, zodat we het later nog kunnen verplaatsen -- bijvoorbeeld
    // als het adres van het dossier wijzigt en de labelnaam meeverandert.
    let nieuwUid = null;
    if (uit && uit.uidMap && typeof uit.uidMap.get === 'function') {
      nieuwUid = uit.uidMap.get(Number(rij.uid)) || null;
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

/* ─────────── één ronde ───────────
   Alles wat nog geen label heeft, of onder het verkeerde label hangt omdat de
   koppeling is gewijzigd. Loopt er iets mis bij één bericht, dan gaat de rest
   gewoon door; de volgende ronde probeert het opnieuw. */
async function archiveerRonde(opties = {}) {
  if (!ingesteld()) return { gelukt: false, reden: 'archiveren staat uit', verplaatst: 0, gelabeld: 0 };

  const grens = new Date(Date.now() - VERZONDEN_DAGEN * 864e5);

  const inkomend = await prisma.inkomend.findMany({
    where: {
      schadeId: { not: null },
      uid: { not: null },
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
  const teVerplaatsen = inkomend.filter((r) => {
    const doel = labelVoor(r.schade);
    return doel && r.gearchiveerd !== doel;
  });

  if (!teVerplaatsen.length && !uitgaand.length) {
    return { gelukt: true, verplaatst: 0, gelabeld: 0, fouten: [] };
  }

  let verplaatst = 0; let gelabeld = 0; const fouten = [];

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
            verplaatst++;
          } else {
            // Niet meer te vinden: niet elke ronde opnieuw proberen.
            await prisma.inkomend.update({ where: { id: rij.id }, data: { uid: null } });
            fouten.push(`${rij.onderwerp || rij.id}: ${uit.reden}`);
          }
        } catch (e) {
          fouten.push(`${rij.onderwerp || rij.id}: ${e.message}`);
        }
      }

      if (uitgaand.length) {
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
    return { gelukt: false, reden: e.message, verplaatst, gelabeld, fouten };
  }

  return { gelukt: true, verplaatst, gelabeld, fouten };
}

/* Meteen na het koppelen, zodat het bericht direct uit de inbox verdwijnt in
   plaats van bij de volgende ronde. Mislukt het, dan pakt de ronde het op. */
function archiveerNu(inkomendId) {
  if (!ingesteld()) return Promise.resolve({ gelukt: false, reden: 'archiveren staat uit' });
  return archiveerRonde({ id: inkomendId }).catch((e) => ({ gelukt: false, reden: e.message }));
}

module.exports = {
  ingesteld, labelVoor, archiveerRonde, archiveerNu,
  HOOFDMAP, AAN, GEBRUIKER,
};
