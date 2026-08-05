const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

const DEFAULT_PASSWORD = 'Welkom123!';

const users = [
  { naam: 'Tarish Navaratnam', email: 'tarish@forwardschadeherstel.nl', role: 'DIRECTIE' },
  { naam: 'Abdullah',          email: 'abdullah@forwardschadeherstel.nl', role: 'DIRECTIE' },
];

const demoSchades = ['FWD-2406-018', 'FWD-2406-009'];

async function main() {
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);
  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { naam: u.naam, role: u.role },
      create: { ...u, passwordHash },
    });
  }

  const weg = await prisma.user.deleteMany({
    where: { email: { notIn: users.map((u) => u.email) } },
  });
  const wegSchades = await prisma.schade.deleteMany({
    where: { nummer: { in: demoSchades } },
  });

  console.log('Seed klaar.');
  console.log(`Verwijderd: ${weg.count} oude gebruiker(s), ${wegSchades.count} demoschade(s).`);
  console.log(`Wachtwoord voor beide accounts: ${DEFAULT_PASSWORD}`);
  for (const u of users) console.log(`  ${u.role}: ${u.email}`);
}

main().then(() => prisma.$disconnect()).catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
