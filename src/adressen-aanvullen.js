// Postcode en plaats aanvullen bij de adressen.
//
// Draai het eerst zonder iets in te vullen -- dan toont hij wat er nu staat en
// geeft hij een lijst die je hieronder kunt plakken:
//
//   docker exec cmsg017x6000cpo9skai401lv node src/adressen-aanvullen.js
//
// Vul daarna hieronder per dossier de postcode en de plaats in, upload het
// bestand opnieuw, redeploy, en draai hetzelfde commando. Regels die je leeg
// laat slaat hij over, dus je kunt het in stukjes doen.

const prisma = require('./db');

// Dossiernummer, postcode, plaats. Laat staan wat je nog niet weet.
const LIJST = {
  'FS-2025-0001': ['', ''],               // Athenesingel 43
  'FS-2025-0002': ['2526 BD', 'Den Haag'],// Van der Helststraat 22
  'FS-2025-0003': ['', ''],               // Jan van der Heijdenstraat 194
  'FS-2025-0004': ['2517 HS', 'Den Haag'],// Valeriusstraat 50
  'FS-2025-0005': ['2282 AW', 'Rijswijk'],// Acacialaan 25
  'FS-2025-0006': ['', ''],               // Woudenbergstraat 71
  'FS-2025-0007': ['2525 ER', 'Den Haag'],// De Heemstraat 216
  'FS-2025-0008': ['2522 TD', 'Den Haag'],// Oudemansstraat 298
  'FS-2025-0009': ['', ''],               // Monstersestraat 176
  'FS-2025-0010': ['2562 TN', 'Den Haag'],// Vinkensteynstraat 115
  'FS-2025-0011': ['2572 CC', 'Den Haag'],// Brandtstraat 119
  'FS-2025-0012': ['', ''],               // Pasteurstraat 248
  'FS-2025-0013': ['', ''],               // Harderwijkstraat 152
  'FS-2025-0014': ['', ''],               // J.J.Heggekade 56
  'FS-2025-0015': ['', ''],               // Athenesingel 57
  'FS-2025-0016': ['', ''],               // De La Reyweg 457
  'FS-2025-0017': ['', ''],               // Pleinweg 208B
  'FS-2025-0018': ['', ''],               // Pasteurstraat 274
  'FS-2026-0001': ['', ''],               // Dierenselaan 177
  'FS-2026-0002': ['', ''],               // Kaapstraat 67A
  'FS-2026-0003': ['', ''],               // Goudenregenplein 60
  'FS-2026-0004': ['', ''],               // Schepenstraat 112A
  'FS-2026-0005': ['2563 RW', 'Den Haag'],// Jasmijnstraat 14
  'FS-2026-0006': ['2524 CK', 'Den Haag'],// Guido Gezellestraat 1
  'FS-2026-0007': ['', ''],               // Rhenenstraat 75
  'FS-2026-0008': ['', ''],               // Valkenboskade 358
  'FS-2026-0009': ['', ''],               // Van Oestendestraat 17B
  'FS-2026-0010': ['', ''],               // Amelandseplein 10C
  'FS-2026-0011': ['', ''],               // Bussumsestraat 58
};

function schoonPostcode(p) {
  const s = String(p || '').toUpperCase().replace(/\s+/g, '');
  const m = s.match(/^(\d{4})([A-Z]{2})$/);
  return m ? `${m[1]} ${m[2]}` : String(p || '').trim();
}

async function main() {
  const locaties = await prisma.locatie.findMany({
    include: { schade: { select: { nummer: true } } },
    orderBy: [{ schade: { nummer: 'asc' } }, { volgorde: 'asc' }],
  });

  const invullen = Object.keys(LIJST).length > 0;
  let bij = 0;
  let leeg = 0;

  for (const l of locaties) {
    const nr = l.schade?.nummer || '';
    const wens = LIJST[nr];

    if (invullen && wens && (wens[0] || wens[1])) {
      await prisma.locatie.update({
        where: { id: l.id },
        data: {
          postcode: wens[0] ? schoonPostcode(wens[0]) : l.postcode,
          plaats: wens[1] ? String(wens[1]).trim() : l.plaats,
        },
      });
      // Het dossier zelf ook, dan staat het overal gelijk.
      await prisma.schade.update({
        where: { nummer: nr },
        data: {
          postcode: wens[0] ? schoonPostcode(wens[0]) : undefined,
          plaats: wens[1] ? String(wens[1]).trim() : undefined,
        },
      }).catch(() => {});
      bij++;
      console.log(`  ${nr}  ${l.adres}  ->  ${schoonPostcode(wens[0] || l.postcode || '')} ${wens[1] || l.plaats || ''}`);
      continue;
    }

    if (!l.postcode || !l.plaats) leeg++;
  }

  console.log('');

  if (!invullen) {
    console.log('Nog niets ingevuld. Neem deze lijst over in het bestand, bij LIJST.');
    console.log('');
    for (const l of locaties) {
      const nr = l.schade?.nummer || '';
      const heeft = l.postcode && l.plaats ? `  // staat al goed: ${l.postcode} ${l.plaats}` : '';
      console.log(`  '${nr}': ['', ''],${heeft}   ${l.adres}`);
    }
    console.log('');
    console.log(`${locaties.length} adres(sen), waarvan ${leeg} zonder postcode of plaats.`);
    return;
  }

  console.log(`Klaar. ${bij} adres(sen) bijgewerkt, nog ${leeg} zonder postcode of plaats.`);
}

main()
  .catch((e) => {
    console.error('Er ging iets mis:', e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
