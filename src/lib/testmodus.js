// Testdossiers mogen nooit iets naar een echte partij sturen. Een verzekeraar
// die oefenpost krijgt neemt jullie de volgende keer minder serieus, en een
// bewoner die een testbrief krijgt belt op.
//
// Dit staat bewust in één bestand, zodat elke plek waar iets de deur uit gaat
// dezelfde regel gebruikt: brieven, berichten, machtigingen en facturen.

// Waar oefenpost heen gaat als er geen ander adres bekend is.
const VANGNET = process.env.TEST_MAIL || 'test@forwardschadeherstel.nl';

function isTest(schade) {
  return !!(schade && schade.test);
}

// De ontvangers van een testdossier worden vervangen door het adres van wie
// het verstuurt. Zo ziet hij zelf wat hij heeft gestuurd, en niemand anders.
function veiligeOntvangers(schade, naar, gebruiker) {
  const lijst = Array.isArray(naar) ? naar : [naar].filter(Boolean);
  if (!isTest(schade)) return { naar: lijst, omgeleid: false, echt: [] };

  const eigen = (gebruiker && gebruiker.email) || VANGNET;
  return { naar: [eigen], omgeleid: true, echt: lijst };
}

// Het onderwerp krijgt er een merkteken bij, zodat je in je eigen mailbox
// meteen ziet dat het een oefening was.
function veiligOnderwerp(schade, onderwerp) {
  const tekst = String(onderwerp || '');
  if (!isTest(schade)) return tekst;
  return tekst.startsWith('[TEST]') ? tekst : `[TEST] ${tekst}`;
}

// Eén regel om in het logboek te zetten, zodat later duidelijk is waarom er
// niets bij de verzekeraar is aangekomen.
function omleidingsregel(uit) {
  if (!uit.omgeleid) return null;
  return uit.echt.length
    ? `Testdossier: omgeleid naar ${uit.naar[0]} in plaats van ${uit.echt.join(', ')}`
    : `Testdossier: omgeleid naar ${uit.naar[0]}`;
}

module.exports = { isTest, veiligeOntvangers, veiligOnderwerp, omleidingsregel, VANGNET };
