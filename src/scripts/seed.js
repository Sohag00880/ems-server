import 'dotenv/config';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { User, ROLES } from '../models/User.js';
import { hashPassword } from '../lib/passwords.js';

function log(...a) {
  // eslint-disable-next-line no-console
  console.log('[seed]', ...a);
}

async function upsertUser({ name, email, password, role, employeeCode }) {
  if (!email || !password) {
    log(`skip ${role} (missing env)`);
    return;
  }
  const normalized = email.toLowerCase();
  const existing = await User.findOne({ email: normalized });
  if (existing) {
    log(`exists: ${normalized} (${existing.role})`);
    return;
  }
  const passwordHash = await hashPassword(password);
  const doc = await User.create({
    name,
    email: normalized,
    passwordHash,
    role,
    employeeCode,
    active: true,
  });
  log(`created ${doc.role}: ${doc.email}${doc.employeeCode ? ` (${doc.employeeCode})` : ''}`);
}

async function main() {
  if (env.nodeEnv === 'production') {
    throw new Error('Refusing to run seed script in production.');
  }

  await mongoose.connect(env.mongoUri);
  log('connected to', env.mongoUri.replace(/\/\/.*@/, '//***@'));

  await upsertUser({
    name: env.seed.ownerName || 'Owner',
    email: env.seed.ownerEmail,
    password: env.seed.ownerPassword,
    role: ROLES.OWNER,
  });

  await upsertUser({
    name: env.seed.employeeName || 'Test Employee',
    email: env.seed.employeeEmail,
    password: env.seed.employeePassword,
    role: ROLES.EMPLOYEE,
    employeeCode: env.seed.employeeCode || undefined,
  });

  await mongoose.disconnect();
  log('done');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[seed] failed:', err);
  process.exit(1);
});