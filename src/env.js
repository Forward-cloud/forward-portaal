require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Ontbrekende omgevingsvariabele: ${name}`);
  return v;
}

module.exports = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  DATABASE_URL: required('DATABASE_URL'),
  JWT_SECRET: required('JWT_SECRET'),
  // Frontend-origin die cookies mag meesturen (bv. http://localhost:5500)
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5500',
  // In productie (https) op true zetten
  COOKIE_SECURE: process.env.COOKIE_SECURE === 'true',
  NODE_ENV: process.env.NODE_ENV || 'development',
};
