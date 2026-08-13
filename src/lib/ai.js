// Herschrijft brieftekst op basis van een aanwijzing in gewone taal.

const MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6';
const SLEUTEL = process.env.ANTHROPIC_API_KEY || '';

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
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': SLEUTEL,
      'anthropic-version': '2023-06-01',
    },
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

module.exports = { herschrijf, beschikbaar, MODEL };
