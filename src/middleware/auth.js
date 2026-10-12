import { User } from '../models/User.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { unauthorized, forbidden } from '../lib/errors.js';

export async function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw unauthorized('Missing bearer token');
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch {
      throw unauthorized('Invalid or expired token');
    }

    const user = await User.findById(payload.sub).lean();
    if (!user || !user.active) throw unauthorized('User not found or inactive');

    req.user = {
      id: String(user._id),
      role: user.role,
      email: user.email,
      name: user.name,
    };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden('Insufficient role'));
    next();
  };
}