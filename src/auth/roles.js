// Pure rolregels — geen database-afhankelijkheid, makkelijk te testen.
const isDirectie = (u) => !!u && u.role === 'DIRECTIE';
const canInvoice = (u) => !!u && (u.role === 'DIRECTIE' || u.role === 'FINANCIEEL');

module.exports = { isDirectie, canInvoice };
