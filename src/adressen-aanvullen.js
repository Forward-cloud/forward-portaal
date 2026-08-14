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
  // 'FS-2025-0001': ['1234 AB', 'Rotterdam'],
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
