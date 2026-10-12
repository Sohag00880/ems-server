import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/**
 * Access tokens are short-lived and sent as Bearer tokens from clients
 * (web keeps them in memory; mobile stores them in SecureStore).
 */
export function signAccessToken(user) {
  return jwt.sign(
    {
      sub: String(user._id),
      role: user.role,
    },
    env.jwt.accessSecret,
    { expiresIn: env.jwt.accessTtl },
  );
}

/**
 * Refresh tokens are long-lived. On the web they live in an httpOnly
 * cookie; on mobile they can be stored in SecureStore.
 *
 * We tag the payload with typ: 'refresh' so verifyRefreshToken can reject
 * an access token that was mistakenly passed here.
 */
export function signRefreshToken(user) {
  return jwt.sign(
    {
      sub: String(user._id),
      typ: 'refresh',
    },
    env.jwt.refreshSecret,
    { expiresIn: env.jwt.refreshTtl },
  );
}

/**
 * Throws if the token is invalid or expired. Caller converts to 401.
 */
export function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.accessSecret);
}

/**
 * Throws if the token is invalid, expired, or not a refresh token.
 */
export function verifyRefreshToken(token) {
  const payload = jwt.verify(token, env.jwt.refreshSecret);
  if (payload.typ !== 'refresh') {
    throw new Error('Not a refresh token');
  }
  return payload;
}