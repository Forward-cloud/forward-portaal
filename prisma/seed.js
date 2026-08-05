const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

const DEFAULT_PASSWORD = 'Welkom123!';

const users = [
  { naam: 'Rick Jansen', email: 'rick@forwardschadeherstel.nl', role: 'DIRECTIE' },
  { naam: 'Petra Willems', email: 'petra@forwardschadeherstel.nl', role: 'FINANCIEEL' },
  { naam: 'Sanne de Boer', email: 'sanne@forwardschadeherstel.nl', role: 'SCHADEBEHANDELAAR' },
  { naam: 'Youssef El Amrani', email: 'youssef@forwardschadeherstel.nl', role: 'PLANNER' },
];

const schades = [
  {
    nummer: 'FWD-2406-018', owner: 'M. de Vries', email: 'm.devries@example.nl',
    adres: 'Dorpsstraat 12, Apeldoorn', ins: 'Nationale-Nederlanden', amount: 8600, profit: 2240,
    step: 3, traject: 'volledig',
    finExpertiseOmzet: 650, finHerstelOmzet: 8200, finHerstelInkoop: 2100, finHerstelUitbesteed: 3400,
    docVisible: { 'Schaderapport.pdf': true, 'Offerte herstel.pdf': true },
  },
  {
    nummer: 'FWD-2406-009', owner: 'VvE Groen Wonen', email: 'beheer@groenwonen.nl',
    adres: 'Parklaan 3, Deventer', ins: 'ASR', amount: 4200, profit: 1090,
    step: 2, traject: 'expertise', finExpertiseOmzet: 900,
    docVisible: {},
  },
];

async function main() {
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);
  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { naam: u.naam, role: u.role },
      create: { ...u, passwordHash },
    });
  }
  for (const s of schades) {
    await prisma.schade.upsert({ where: { nummer: s.nummer }, update: s, create: s });
  }
  console.log('Seed klaar.');
  console.log(`Inloggen kan met wachtwoord: ${DEFAULT_PASSWORD}`);
  console.log('  Directie:   rick@forwardschadeherstel.nl');
  console.log('  Financieel: petra@forwardschadeherstel.nl');
  console.log('  Behandelaar:sanne@forwardschadeherstel.nl');
  console.log('  Planner:    youssef@forwardschadeherstel.nl');
}

main().then(() => prisma.$disconnect()).catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
