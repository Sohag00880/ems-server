import { User, ROLES } from '../models/User.js';
import { hashPassword } from '../lib/passwords.js';
import { conflict, notFound, forbidden } from '../lib/errors.js';

/**
 * Public shape returned to clients. Never includes passwordHash.
 */
function publicUser(u) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    role: u.role,
    employeeCode: u.employeeCode ?? null,
    active: u.active,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

/**
 * Escape user-supplied input before using it inside a RegExp for search,
 * so `q` can't cause regex injection or catastrophic backtracking.
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Paginated + filtered + searchable list of employees.
 */
export async function listEmployees({
  page = 1,
  limit = 20,
  q = '',
  status = 'all',
  role = 'all',
} = {}) {
  const filter = {};

  if (status === 'active') filter.active = true;
  else if (status === 'inactive') filter.active = false;

  if (role === 'OWNER' || role === 'EMPLOYEE') filter.role = role;

  if (q && q.trim().length > 0) {
    const rx = new RegExp(escapeRegex(q.trim()), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { employeeCode: rx }];
  }

  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
  ]);

  return {
    employees: items.map(publicUser),
    pagination: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

/**
 * Fetch a single employee's public shape by id. Throws 404 if not found.
 */
export async function getEmployeeById(id) {
  const user = await User.findById(id).lean();
  if (!user) throw notFound('Employee not found');
  return publicUser(user);
}

/**
 * Guard: refuse to deactivate or demote the last remaining active OWNER.
 */
async function assertNotLastOwner({ userId, willBeInactive, willBeRole }) {
  if (willBeInactive !== true && willBeRole !== ROLES.EMPLOYEE) return;

  const target = await User.findById(userId).lean();
  if (!target || target.role !== ROLES.OWNER) return;

  const activeOwnerCount = await User.countDocuments({
    role: ROLES.OWNER,
    active: true,
  });
  if (activeOwnerCount <= 1) {
    throw forbidden('Cannot deactivate or demote the last remaining owner');
  }
}

/**
 * Normalize an employeeCode to uppercase (trim already done by Zod).
 * Returns undefined for empty values so the partial-unique index is not
 * tripped by `null` or `''` on owners.
 */
function normalizeCode(code) {
  if (code === undefined || code === null) return undefined;
  const s = String(code).trim();
  if (!s) return undefined;
  return s.toUpperCase();
}

/**
 * Create a new employee. Password is hashed before storage; the plaintext
 * password never touches the DB and is never returned to the caller.
 *
 * Duplicate email / employeeCode are checked here for a friendly error;
 * the DB-level unique indexes are the ultimate safety net.
 */
export async function createEmployee({ actor, data }) {
  const email = data.email.toLowerCase();
  const employeeCode = normalizeCode(data.employeeCode);

  const [dupEmail, dupCode] = await Promise.all([
    User.findOne({ email }).lean(),
    employeeCode ? User.findOne({ employeeCode }).lean() : null,
  ]);

  if (dupEmail) throw conflict('An account with this email already exists');
  if (dupCode) throw conflict('This employee code is already in use');

  const passwordHash = await hashPassword(data.password);

  const user = await User.create({
    name: data.name,
    email,
    passwordHash,
    role: data.role,
    employeeCode: employeeCode ?? undefined,
    active: data.active ?? true,
  });

  return { user, actorId: actor.id };
}

/**
 * Update an existing employee. Supports partial updates:
 *   - name, email, role, employeeCode, active
 *   - password (admin-driven reset)
 *
 * Returns a summary object including a minimal before/after diff so the
 * route can record a precise audit log entry.
 *
 * Never hard-deletes. Deactivation is expressed as { active: false }.
 */
export async function updateEmployee({ actor, targetId, patch, reason }) {
  const target = await User.findById(targetId);
  if (!target) throw notFound('Employee not found');

  const before = {
    name: target.name,
    email: target.email,
    role: target.role,
    employeeCode: target.employeeCode ?? null,
    active: target.active,
  };

  // --- email ---
  if (patch.email !== undefined) {
    const email = patch.email.toLowerCase();
    if (email !== target.email) {
      const dup = await User.findOne({ email, _id: { $ne: target._id } }).lean();
      if (dup) throw conflict('An account with this email already exists');
      target.email = email;
    }
  }

  // --- employeeCode (normalize before compare/query) ---
  if (patch.employeeCode !== undefined) {
    const code = normalizeCode(patch.employeeCode);
    const current = target.employeeCode ?? undefined;

    if (code !== current) {
      if (code) {
        const dup = await User.findOne({
          employeeCode: code,
          _id: { $ne: target._id },
        }).lean();
        if (dup) throw conflict('This employee code is already in use');
        target.employeeCode = code;
      } else {
        target.employeeCode = undefined;
      }
    }
  }

  // --- name ---
  if (patch.name !== undefined) {
    target.name = patch.name;
  }

  // --- role / active safety ---
  const willBeRole = patch.role;
  const willBeInactive = patch.active === false;
  await assertNotLastOwner({
    userId: target._id,
    willBeRole,
    willBeInactive,
  });

  if (patch.role !== undefined) target.role = patch.role;
  if (patch.active !== undefined) target.active = patch.active;

  // --- password (admin reset) ---
  if (patch.password) {
    target.passwordHash = await hashPassword(patch.password);
  }

  await target.save();

  const after = {
    name: target.name,
    email: target.email,
    role: target.role,
    employeeCode: target.employeeCode ?? null,
    active: target.active,
  };

  const changedKeys = Object.keys(after).filter((k) => before[k] !== after[k]);
  const changes = changedKeys.length
    ? {
        before: Object.fromEntries(changedKeys.map((k) => [k, before[k]])),
        after: Object.fromEntries(changedKeys.map((k) => [k, after[k]])),
        passwordChanged: Boolean(patch.password),
      }
    : { passwordChanged: Boolean(patch.password) };

  return {
    user: target,
    before,
    after,
    changes,
    actorId: actor.id,
    reason,
  };
}

export { publicUser };