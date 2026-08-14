// Eenmalige migratie: elk dossier krijgt minstens één adresregel.
//
// Zonder adresregel werkt opleveren per adres niet, en de planning per adres
// ook niet. Dit script maakt er één aan op basis van het adres dat al in het
// dossier staat, en slaat dossiers over die er al een hebben. Twee keer draaien
// kan dus geen kwaad.
//
// Draaien met:
//   docker exec cmsg017x6000cpo9skai401lv node scripts/adresregels.js

const prisma = require('../src/db');

// 'Amelandseplein 10C, 3083 GX Rotterdam' uit elkaar trekken.
// Wat er niet in staat laten we leeg -- liever leeg dan verkeerd geraden.
function splits(adres) {
  const heel = String(adres || '').trim();
  if (!heel) return { straat: '', postcode: '', plaats: '' };

  const delen = heel.split(',').map((d) => d.trim()).filter(Boolean);
  const straat = delen[0] || heel;
  const rest = delen.slice(1).join(', ');

  const pc = rest.match(/(\d{4}\s?[A-Za-z]{2})/);
  const postcode = pc ? pc[1].toUpperCase().replace(/(\d{4})\s?([A-Z]{2})/, '$1 $2') : '';
  const plaats = rest.replace(/(\d{4}\s?[A-Za-z]{2})/, '').replace(/^[\s,]+|[\s,]+$/g, '');

  return { straat, postcode, plaats };
}

async function main() {
  const dossiers = await prisma.schade.findMany({
    select: {
      id: true, nummer: true, adres: true, postcode: true, plaats: true,
      bewonerSoort: true, telefoon: true, email: true, owner: true,
      _count: { select: { locaties: true } },
    },
    orderBy: { nummer: 'asc' },
  });

  let gemaakt = 0;
  let overgeslagen = 0;

  for (const d of dossiers) {
    if (d._count.locaties > 0) {
      overgeslagen++;
      continue;
    }

    const uit = splits(d.adres);

    await prisma.locatie.create({
      data: {
        schadeId: d.id,
        adres: uit.straat || d.adres || 'Adres onbekend',
        postcode: d.postcode || uit.postcode || null,
        plaats: d.plaats || uit.plaats || null,
        aanduiding: null,
        bewoner: d.owner || null,
        bewonerSoort: d.bewonerSoort || null,
        telefoon: d.telefoon || null,
        email: d.email || null,
        hoofd: true,
        volgorde: 0,
      },
    });

    gemaakt++;
    console.log(`  ${d.nummer}  ->  ${uit.straat}${uit.plaats ? ', ' + uit.plaats : ''}`);
  }

  console.log('');
  console.log(`Klaar. ${gemaakt} adresregel(s) aangemaakt, ${overgeslagen} dossier(s) hadden er al een.`);
}

main()
  .catch((e) => {
    console.error('Er ging iets mis:', e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
