// Postcode en plaats ophalen bij PDOK.
//
// PDOK is de open adressendienst van de overheid, gevoed uit de BAG. Gratis,
// geen sleutel nodig, wel een fair use policy -- vandaar een korte pauze
// tussen de aanvragen.
//
// Draaien met:
//   docker exec cmsg017x6000cpo9skai401lv node src/adressen-pdok.js
//
// Standaard laat hij alleen zien wat hij zou invullen. Pas als je er ' opslaan '
// achter zet, schrijft hij het weg:
//   docker exec cmsg017x6000cpo9skai401lv node src/adressen-pdok.js opslaan

const prisma = require('./db');

const PDOK = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free';

// Waar jullie werken. Een adres buiten deze plaatsen wordt niet vanzelf
// ingevuld, ook al vindt PDOK er een. Vul de lijst gerust aan.
const REGIO = [
  'Den Haag', "'s-Gravenhage", 'Rotterdam', 'Rijswijk', 'Delft', 'Voorburg',
  'Leidschendam', 'Zoetermeer', 'Wassenaar', 'Schiedam', 'Vlaardingen',
  'Capelle aan den IJssel', 'Barendrecht', 'Pijnacker', 'Nootdorp',
];

const pauze = (ms) => new Promise((r) => setTimeout(r, ms));

// 'Amelandseplein 10C' wordt gesplitst in straat, nummer en toevoeging.
function ontleed(adres) {
  const heel = String(adres || '').trim();
  const m = heel.match(/^(.+?)\s+(\d+)\s*([A-Za-z]?)$/);
  if (!m) return { straat: heel, nummer: '', toevoeging: '' };
  return { straat: m[1].trim(), nummer: m[2], toevoeging: (m[3] || '').toUpperCase() };
}

async function zoek(adres) {
  const q = encodeURIComponent(adres);
  const url = `${PDOK}?q=${q}&fq=type%3Aadres&rows=10`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`PDOK gaf ${res.status}`);
  const data = await res.json();
  return (data?.response?.docs || []).map((d) => ({
    straat: d.straatnaam,
    nummer: String(d.huis_nlt || d.huisnummer || ''),
    postcode: d.postcode ? String(d.postcode).replace(/(\d{4})\s?([A-Za-z]{2})/, '$1 $2').toUpperCase() : '',
    plaats: d.woonplaatsnaam || '',
    naam: d.weergavenaam || '',
  }));
}

function kiesBeste(treffers, adres) {
  const uit = ontleed(adres);
  const nummer = (uit.nummer + uit.toevoeging).toUpperCase();

  // Eerst op huisnummer inclusief toevoeging, anders op het kale nummer.
  let passend = treffers.filter((t) => t.nummer.toUpperCase().replace(/\s/g, '') === nummer);
  if (!passend.length) passend = treffers.filter((t) => t.nummer.replace(/\D/g, '') === uit.nummer);
  if (!passend.length) passend = treffers;

  const inRegio = passend.filter((t) => REGIO.some((p) => t.plaats.toLowerCase() === p.toLowerCase()));
  const keuze = inRegio.length ? inRegio : passend;

  // Alleen zeker als er precies één plaats overblijft.
  const plaatsen = [...new Set(keuze.map((t) => `${t.postcode}|${t.plaats}`))];
  if (plaatsen.length === 1 && keuze[0].postcode) {
    return { zeker: true, treffer: keuze[0], buitenRegio: !inRegio.length };
  }
  return { zeker: false, opties: keuze.slice(0, 5) };
}

async function main() {
  const opslaan = process.argv.includes('opslaan');

  const locaties = await prisma.locatie.findMany({
    where: { OR: [{ postcode: null }, { plaats: null }, { postcode: '' }, { plaats: '' }] },
    include: { schade: { select: { nummer: true } } },
    orderBy: [{ schade: { nummer: 'asc' } }],
  });

  if (!locaties.length) {
    console.log('Alle adressen hebben al een postcode en plaats.');
    return;
  }

  console.log(`${locaties.length} adres(sen) zonder postcode of plaats.`);
  console.log(opslaan ? 'Gevonden gegevens worden opgeslagen.' : 'Proefrun -- er wordt niets opgeslagen.');
  console.log('');

  let gevonden = 0;
  let twijfel = 0;
  let niets = 0;

  for (const l of locaties) {
    const nr = l.schade?.nummer || '';
    let treffers = [];
    try {
      treffers = await zoek(l.adres);
    } catch (e) {
      console.log(`  ${nr}  ${l.adres}  ->  PDOK gaf een fout: ${e.message}`);
      await pauze(400);
      continue;
    }

    if (!treffers.length) {
      niets++;
      console.log(`  ${nr}  ${l.adres}  ->  niets gevonden`);
      await pauze(250);
      continue;
    }

    const uitslag = kiesBeste(treffers, l.adres);

    if (uitslag.zeker) {
      const t = uitslag.treffer;
      gevonden++;
      const let_ = uitslag.buitenRegio ? '   (let op: buiten jullie regio)' : '';
      console.log(`  ${nr}  ${l.adres}  ->  ${t.postcode}  ${t.plaats}${let_}`);

      if (opslaan) {
        await prisma.locatie.update({
          where: { id: l.id },
          data: { postcode: t.postcode, plaats: t.plaats },
        });
        await prisma.schade
          .update({ where: { nummer: nr }, data: { postcode: t.postcode, plaats: t.plaats } })
          .catch(() => {});
      }
    } else {
      twijfel++;
      console.log(`  ${nr}  ${l.adres}  ->  meerdere mogelijkheden:`);
      uitslag.opties.forEach((t) => console.log(`        ${t.postcode}  ${t.plaats}   (${t.naam})`));
    }

    await pauze(250);
  }

  console.log('');
  console.log(`${gevonden} zeker, ${twijfel} met meerdere mogelijkheden, ${niets} niet gevonden.`);
  if (!opslaan && gevonden) {
    console.log('Draai hetzelfde commando met  opslaan  erachter om ze weg te schrijven.');
  }
  if (twijfel) {
    console.log('De twijfelgevallen vul je met de hand in via src/adressen-aanvullen.js.');
  }
}

main()
  .catch((e) => {
    console.error('Er ging iets mis:', e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
