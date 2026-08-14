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

// Waar jullie werken. Alles daarbuiten wordt niet ingevuld, ook al vindt PDOK
// er een. Komt er later een andere plaats bij, zet die er dan gewoon achter.
const REGIO = ["'s-Gravenhage", 'Den Haag', 'Rotterdam', 'Rijswijk'];

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

// 'J.J.Heggekade' en 'J.J. Heggekade' zijn dezelfde straat.
function kaal(naam) {
  return String(naam || '').toLowerCase().replace(/[^a-z]/g, '');
}

function kiesBeste(treffers, adres) {
  const uit = ontleed(adres);
  const nummer = (uit.nummer + uit.toevoeging).toUpperCase();

  // De straatnaam moet kloppen. Zonder deze controle matcht PDOK soms op
  // alleen het huisnummer, en dan krijg je een heel andere straat terug.
  const zelfdeStraat = treffers.filter((t) => kaal(t.straat) === kaal(uit.straat));
  if (!zelfdeStraat.length) {
    return { zeker: false, reden: 'straatnaam komt niet overeen', opties: treffers.slice(0, 5) };
  }

  // Eerst op huisnummer inclusief toevoeging, anders op het kale nummer.
  let passend = zelfdeStraat.filter((t) => t.nummer.toUpperCase().replace(/\s/g, '') === nummer);
  if (!passend.length) passend = zelfdeStraat.filter((t) => t.nummer.replace(/\D/g, '') === uit.nummer);
  if (!passend.length) passend = zelfdeStraat;

  // Buiten jullie werkgebied vullen we niets in. Liever leeg dan verkeerd.
  const inRegio = passend.filter((t) => REGIO.some((p) => t.plaats.toLowerCase() === p.toLowerCase()));
  if (!inRegio.length) {
    return { zeker: false, reden: 'alleen treffers buiten jullie regio', opties: passend.slice(0, 5) };
  }

  // Alleen zeker als er precies één adres overblijft.
  const uniek = [...new Set(inRegio.map((t) => `${t.postcode}|${t.plaats}`))];
  if (uniek.length === 1 && inRegio[0].postcode) {
    return { zeker: true, treffer: inRegio[0] };
  }
  return { zeker: false, reden: 'meerdere mogelijkheden', opties: inRegio.slice(0, 5) };
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
      console.log(`  ${nr}  ${l.adres}  ->  ${t.postcode}  ${t.plaats}`);

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
      console.log(`  ${nr}  ${l.adres}  ->  ${uitslag.reden}:`);
      uitslag.opties.forEach((t) => console.log(`        ${t.postcode}  ${t.plaats}   (${t.naam})`));
      // Klaar om over te nemen in src/adressen-aanvullen.js
      const eerste = uitslag.opties[0];
      console.log(`        '${nr}': ['${eerste ? eerste.postcode : ''}', '${eerste ? eerste.plaats : ''}'],   // ${l.adres}`);
    }

    await pauze(250);
  }

  console.log('');
  console.log(`${gevonden} zeker, ${twijfel} onzeker, ${niets} niet gevonden.`);
  if (!opslaan && gevonden) {
    console.log('Draai hetzelfde commando met  opslaan  erachter om ze weg te schrijven.');
  }
  if (twijfel) {
    console.log('De onzekere gevallen vul je met de hand in via src/adressen-aanvullen.js.');
    console.log('Klopt een straatnaam niet, kijk dan of het adres in het dossier goed staat.');
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
