// Herschrijft brieftekst op basis van een aanwijzing in gewone taal.

// Trim: bij het plakken in Coolify sluipt er makkelijk een spatie of een
// regeleinde mee. Een header met een spatie erin wordt geweigerd.
const MODEL = (process.env.AI_MODEL || 'claude-sonnet-4-6').trim();
const SLEUTEL = (process.env.ANTHROPIC_API_KEY || '').trim();

/* Een sleutel die aan de organisatie hangt in plaats van aan een werkruimte,
   moet erbij vertellen welke werkruimte hij moet gebruiken. Zet dan
   ANTHROPIC_WORKSPACE_ID in Coolify. Hangt de sleutel al aan een werkruimte,
   dan laat je die leeg en gebeurt er niets. */
const WERKRUIMTE = (process.env.ANTHROPIC_WORKSPACE_ID || '').trim();

function koppen() {
  const h = {
    'Content-Type': 'application/json',
    'x-api-key': SLEUTEL,
    'anthropic-version': '2023-06-01',
  };
  if (WERKRUIMTE) h['anthropic-workspace-id'] = WERKRUIMTE;
  return h;
}

const HUISREGELS = `Je redigeert brieven voor Forward Schadeherstel, een schadeherstelbedrijf dat
waterschade afhandelt voor VvE-beheerders, verzekeraars en particulieren.

SCHRIJF ALS EEN MENS, NIET ALS EEN KANTOOR.
De lezer is een schadebehandelaar, een VvE-bestuurder of een bewoner. Die moet in één keer
begrijpen wat er staat, zonder een zin twee keer te lezen.

Zo schrijf je:
- Korte zinnen. Eén gedachte per zin.
- Actief: "wij hebben de schade opgenomen", niet "er is een schadeopname verricht".
- Gewone woorden. Zeg wat je bedoelt.
- Stel gerust een vraag: "Wilt u de claim in behandeling nemen?" leest prettiger dan "Wij verzoeken u vriendelijk".
- Spreek de lezer aan met u. Over onszelf: wij.

Deze woorden en wendingen gebruik je NOOIT:
"middels", "derhalve", "zulks", "gelieve", "ter zake", "dienaangaande", "voornoemd",
"indien" (schrijf: als), "teneinde" (schrijf: om), "alsmede" (schrijf: en),
"in het kader van", "met betrekking tot", "naar aanleiding van het bovenstaande",
"wij verzoeken u vriendelijk doch dringend", "uiteraard graag bereid",
"ter verdere behandeling van", "hierbij doen wij u toekomen".

Vermijd ook:
- Stapelzinnen met drie bijzinnen.
- Zelfstandige naamwoorden waar een werkwoord kan: "de beoordeling van" wordt "beoordelen".
- Vier woorden waar één volstaat.
- Opsmuk en beleefdheidsformules die niets toevoegen.

Toon: rustig, vakkundig, vriendelijk. Geen uitroeptekens. Geen verkooptaal.
Niet overdreven excuserend, niet joviaal.

HARDE REGELS:
- Verzin NOOIT bedragen, data, polisnummers, schadenummers of namen. Gebruik alleen wat er al staat.
- Verander geen bestaand cijfer, ook niet als het vreemd lijkt.
- Doe geen technische beweringen over de oorzaak. Verwijs naar het schaderapport.
- Laat de aanhef en de afsluiting staan, tenzij de aanwijzing daar expliciet over gaat.
- Kun je iets niet weten, laat die passage dan weg in plaats van iets te bedenken.

Geef alleen de herschreven brieftekst terug. Geen uitleg, geen aanhalingstekens eromheen,
geen opmaakcodes, geen inleidende zin over wat je hebt aangepast.`;

function beschikbaar() {
  return !!SLEUTEL;
}

async function herschrijf({ tekst, aanwijzing, context }) {
  if (!SLEUTEL) {
    const e = new Error('Er is nog geen AI-sleutel ingesteld op de server.');
    e.code = 'GEEN_SLEUTEL';
    throw e;
  }

  const bericht =
    `Hier is de huidige brieftekst:\n\n---\n${tekst}\n---\n\n` +
    (context ? `Feiten uit het dossier (alleen ter controle, niet allemaal noemen):\n${context}\n\n` : '') +
    `Aanwijzing van de gebruiker:\n${aanwijzing}\n\n` +
    `Herschrijf de brieftekst volgens deze aanwijzing.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: koppen(),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: HUISREGELS,
      messages: [{ role: 'user', content: bericht }],
    }),
  });

  if (!res.ok) {
    let melding = 'De AI-dienst gaf een fout terug.';
    try {
      const j = await res.json();
      if (j && j.error && j.error.message) melding = j.error.message;
    } catch (e) { /* laat de standaardmelding staan */ }
    const err = new Error(melding);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const uit = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  if (!uit) throw new Error('De AI gaf geen tekst terug. Probeer de aanwijzing anders te formuleren.');
  return uit;
}

/**
 * Maakt van een korte notitie een net bericht in huisstijl.
 * notitie   — wat de gebruiker in eigen woorden opschreef
 * ontvanger — aan wie het gaat (klant, beheerder, verzekeraar)
 * context   — feiten uit het dossier
 */
async function opstellen({ notitie, ontvanger, context }) {
  if (!SLEUTEL) {
    const e = new Error('Er is nog geen AI-sleutel ingesteld op de server.');
    e.code = 'GEEN_SLEUTEL';
    throw e;
  }

  const bericht =
    `Schrijf een bericht aan ${ontvanger || 'de ontvanger'}.\n\n` +
    `Dit wil de afzender kwijt, in eigen woorden:\n---\n${notitie}\n---\n\n` +
    (context ? `Feiten uit het dossier (gebruik alleen wat nodig is):\n${context}\n\n` : '') +
    `Maak er een net bericht van in onze huisstijl. Begin met de aanhef en eindig met de afsluiting.\n` +
    `Verzin niets bij wat er niet staat. Blijf dicht bij wat de afzender bedoelt.\n` +
    `Geef daarnaast een korte onderwerpregel.\n\n` +
    `Antwoord precies zo:\nONDERWERP: <de onderwerpregel>\nTEKST:\n<het bericht>`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: koppen(),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: HUISREGELS,
      messages: [{ role: 'user', content: bericht }],
    }),
  });

  if (!res.ok) {
    let melding = 'De AI-dienst gaf een fout terug.';
    try { const j = await res.json(); if (j && j.error && j.error.message) melding = j.error.message; }
    catch (e) { /* standaardmelding */ }
    const err = new Error(melding);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const uit = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!uit) throw new Error('De AI gaf geen tekst terug.');

  const m = /ONDERWERP:\s*(.+?)\s*\nTEKST:\s*([\s\S]+)/i.exec(uit);
  return m
    ? { onderwerp: m[1].trim(), tekst: m[2].trim() }
    : { onderwerp: '', tekst: uit };
}


/* ─────────── binnengekomen post beoordelen ───────────
   Vraagt dit bericht iets van ons, of is het een mededeling? De uitkomst wordt
   een actiepunt op het dossier, dus we houden het streng: liever een keer te
   veel een actiepunt dan een vraag van een verzekeraar die blijft liggen.

   Geeft de AI geen bruikbaar antwoord, dan gaan we uit van 'ja, actie nodig'.
   Een gemiste vraag kost meer dan een overbodig regeltje op de lijst.        */
const POST_REGELS = `Je beoordeelt binnengekomen e-mail van een schadeherstelbedrijf dat waterschade
afhandelt voor VvE-beheerders, verzekeraars en bewoners.

Bepaal twee dingen:
1. Vraagt dit bericht een handeling van ons? Een vraag, een verzoek, een termijn,
   een afwijzing, een verzoek om stukken, een klacht, een afspraak die bevestigd
   moet worden. Een enkele ontvangstbevestiging of een mededeling zonder verzoek
   vraagt niets.
2. Zo ja: wat moet er gebeuren, in één korte zin, in gewone taal, actief
   geschreven en beginnend met een werkwoord. Bijvoorbeeld "Polisblad opsturen
   naar Achmea" of "Bewoner terugbellen over de hersteldatum".

Kies ook een soort uit deze lijst, en niets anders:
- info      een verzoek om stukken of aanvullende informatie
- bellen    er moet iemand gebeld worden
- herstel   het gaat over de planning of uitvoering van herstel
- offerte   het gaat over een offerte of een prijs
- machtiging het gaat over een machtiging
- klant     iets anders dat een reactie aan de klant vraagt

Antwoord uitsluitend met JSON, zonder uitleg eromheen:
{"actie": true of false, "soort": "info", "tekst": "korte zin", "termijn": "wat er over een termijn wordt gezegd, of leeg"}

Verzin niets. Noem geen bedragen of data die niet in het bericht staan.`;

async function beoordeelPost({ van, onderwerp, tekst, dossier }) {
  if (!SLEUTEL) return { gelukt: false, reden: 'geen sleutel' };

  const kort = String(tekst || '').replace(/\s+/g, ' ').slice(0, 6000);
  const bericht =
    `Afzender: ${van || 'onbekend'}\n` +
    `Onderwerp: ${onderwerp || '(geen onderwerp)'}\n` +
    (dossier ? `Hoort bij dossier: ${dossier}\n` : 'Hoort nog bij geen enkel dossier.\n') +
    `\nBericht:\n---\n${kort}\n---`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: koppen(),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: POST_REGELS,
        messages: [{ role: 'user', content: bericht }],
      }),
    });
    if (!res.ok) return { gelukt: false, reden: `AI gaf ${res.status} terug` };

    const data = await res.json();
    const uit = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    // Soms komt er een codeblok omheen; dat halen we eraf.
    const schoon = uit.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const j = JSON.parse(schoon);

    const SOORTEN = ['info', 'bellen', 'herstel', 'offerte', 'machtiging', 'klant'];
    return {
      gelukt: true,
      actie: j.actie === true,
      soort: SOORTEN.indexOf(j.soort) > -1 ? j.soort : 'klant',
      tekst: String(j.tekst || '').trim().slice(0, 300),
      termijn: String(j.termijn || '').trim().slice(0, 200),
    };
  } catch (e) {
    return { gelukt: false, reden: e.message };
  }
}

module.exports = { herschrijf, opstellen, beoordeelPost, beschikbaar, MODEL };
