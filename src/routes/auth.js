import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { User } from '../models/User.js';
import { verifyPassword } from '../lib/passwords.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../lib/tokens.js';
import { requireAuth } from '../middleware/auth.js';
import { unauthorized, badRequest } from '../lib/errors.js';
import { env } from '../config/env.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' } },
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
});

function publicUser(u) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    role: u.role,
    employeeCode: u.employeeCode ?? null,
    active: u.active,
  };
}

function setRefreshCookie(res, token) {
  res.cookie('refresh_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.cookie.secure,
    domain: env.cookie.domain,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/api/auth',
  });
}

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
    if (!user) throw unauthorized('Invalid credentials');
    if (!user.active) throw unauthorized('Account is inactive');

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw unauthorized('Invalid credentials');

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    setRefreshCookie(res, refreshToken);

    return res.json({
      accessToken,
      user: publicUser(user),
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const token = req.cookies?.refresh_token;
    if (!token) throw unauthorized('Missing refresh token');

    let payload;
    try {
      payload = verifyRefreshToken(token);
    } catch {
      throw unauthorized('Invalid refresh token');
    }

    const user = await User.findById(payload.sub).lean();
    if (!user || !user.active) throw unauthorized('User not found or inactive');

    const accessToken = signAccessToken(user);
    return res.json({ accessToken, user: publicUser(user) });
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('refresh_token', { path: '/api/auth' });
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).lean();
    if (!user || !user.active) throw unauthorized();
    return res.json({ user: publicUser(user) });
  } catch (err) {
    return next(err);
  }
});

export default router;