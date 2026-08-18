// Pure rolregels — geen database-afhankelijkheid, makkelijk te testen.
const isDirectie = (u) => !!u && u.role === 'DIRECTIE';
const canInvoice = (u) => !!u && (u.role === 'DIRECTIE' || u.role === 'FINANCIEEL');

// Een opleidingsaccount is bedoeld om in te oefenen. Zo iemand ziet alleen
// testdossiers, nooit echte klanten, en nergens bedragen of facturen. Alles
// wat hij aanmaakt is automatisch een testdossier.
const isOpleiding = (u) => !!u && u.role === 'OPLEIDING';

// Mag deze gebruiker dit dossier zien? Een opleidingsaccount alleen als het
// een testdossier is; de rest ziet alles.
const magDossierZien = (u, s) => (isOpleiding(u) ? !!(s && s.test) : true);

module.exports = { isDirectie, canInvoice, isOpleiding, magDossierZien };
