import 'dotenv/config';

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 5000),
  corsOrigins: required('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  mongoUri: required('MONGODB_URI'),
  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessTtl: process.env.ACCESS_TOKEN_TTL ?? '15m',
    refreshTtl: process.env.REFRESH_TOKEN_TTL ?? '7d',
  },
  cookie: {
    domain: process.env.COOKIE_DOMAIN ?? 'localhost',
    secure: (process.env.COOKIE_SECURE ?? 'false') === 'true',
  },
  seed: {
    ownerName: process.env.SEED_OWNER_NAME,
    ownerEmail: process.env.SEED_OWNER_EMAIL,
    ownerPassword: process.env.SEED_OWNER_PASSWORD,
    employeeName: process.env.SEED_EMPLOYEE_NAME,
    employeeEmail: process.env.SEED_EMPLOYEE_EMAIL,
    employeePassword: process.env.SEED_EMPLOYEE_PASSWORD,
    employeeCode: process.env.SEED_EMPLOYEE_CODE,
  },
};

if (env.nodeEnv === 'production' && env.cookie.secure === false) {
  // eslint-disable-next-line no-console
  console.warn('[env] COOKIE_SECURE is false in production — cookies will not be sent over HTTPS-only.');
}