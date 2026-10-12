import bcrypt from 'bcryptjs';

/**
 * bcrypt cost factor.
 * - Production: 12 (≈250–400 ms per hash on typical hardware).
 * - Test: 4 (≈2–5 ms per hash). Tests run against an ephemeral in-memory
 *   MongoDB with synthetic data, so a lower cost is safe and keeps the
 *   suite fast. Never use 4 in production.
 */
const ROUNDS = process.env.NODE_ENV === 'test' ? 4 : 12;

export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('hashPassword: password must be a non-empty string');
  }
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}