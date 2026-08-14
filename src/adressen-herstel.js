// Straatnamen herstellen die in de dossiers verkeerd staan.
//
// PDOK vond een aantal adressen niet omdat de straatnaam net anders is
// gespeld dan in de BAG. Dat is niet alleen vervelend voor het opzoeken:
// een brief naar 'Heemstraat 216' komt bij PostNL ook niet aan.
//
// Draaien met:
//   docker exec cmsg017x6000cpo9skai401lv node src/adressen-herstel.js
//
// Standaard laat hij alleen zien wat hij zou veranderen. Met ' opslaan '
// erachter schrijft hij het weg:
//   docker exec cmsg017x6000cpo9skai401lv node src/adressen-herstel.js opslaan

const prisma = require('./db');

// Dossiernummer -> het juiste adres.
const CORRECTIES = {
  'FS-2025-0002': 'Van der Helststraat 22',
  'FS-2025-0007': 'De Heemstraat 216',
  'FS-2025-0008': 'Oudemansstraat 298',
  'FS-2025-0010': 'Vinkensteynstraat 115',
  'FS-2025-0011': 'Brandtstraat 119',
  'FS-2026-0006': 'Guido Gezellestraat 1',
};

async function main() {
  const opslaan = process.argv.includes('opslaan');
  console.log(opslaan ? 'Wijzigingen worden opgeslagen.' : 'Proefrun -- er wordt niets opgeslagen.');
  console.log('');

  let gedaan = 0;
  let gelijk = 0;
  let weg = 0;

  for (const [nummer, juist] of Object.entries(CORRECTIES)) {
    const schade = await prisma.schade.findUnique({
      where: { nummer },
      select: { id: true, adres: true, locaties: { select: { id: true, adres: true, hoofd: true } } },
    });

    if (!schade) {
      weg++;
      console.log(`  ${nummer}  ->  dossier niet gevonden`);
      continue;
    }

    const nu = schade.adres || '';
    if (nu === juist) {
      gelijk++;
      console.log(`  ${nummer}  ->  stond al goed`);
      continue;
    }

    console.log(`  ${nummer}  ${nu || '(leeg)'}  ->  ${juist}`);

    if (opslaan) {
      await prisma.schade.update({ where: { id: schade.id }, data: { adres: juist } });

      // De adresregel meenemen. Bij meerdere adressen alleen het hoofdadres,
      // want de rest gaat over andere woningen in hetzelfde pand.
      const doel = schade.locaties.find((l) => l.hoofd) || schade.locaties[0];
      if (doel) {
        await prisma.locatie.update({ where: { id: doel.id }, data: { adres: juist } });
      }

      await prisma.logEntry.create({
        data: {
          text: 'Adres gecorrigeerd',
          detail: `${nu || '(leeg)'} \u2192 ${juist}`,
          schadeId: schade.id,
          byName: 'Systeem',
        },
      });
    }

    gedaan++;
  }

  console.log('');
  console.log(`${gedaan} adres(sen) ${opslaan ? 'aangepast' : 'te wijzigen'}, ${gelijk} stond al goed, ${weg} niet gevonden.`);
  if (!opslaan && gedaan) {
    console.log('Draai hetzelfde commando met  opslaan  erachter om het door te voeren.');
  }
  if (opslaan && gedaan) {
    console.log('Draai daarna src/adressen-pdok.js opnieuw voor de postcodes.');
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
