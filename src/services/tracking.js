import { TrackingSession, SESSION_STATUS } from '../models/TrackingSession.js';
import { TrackingLocationPoint } from '../models/TrackingLocationPoint.js';
import { User } from '../models/User.js';
import { conflict, notFound, forbidden, gone, badRequest } from '../lib/errors.js';
import { TRACKING } from '../config/tracking.js';

// ============================================================================
// Public serializers
// ============================================================================

function publicSession(s) {
  return {
    id: String(s._id),
    employeeId: String(s.employeeId),
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
    status: s.status,
    startLocation: s.startLocation ?? null,
    endLocation: s.endLocation ?? null,
    lastLocationAt: s.lastLocationAt ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function publicPoint(p) {
  return {
    id: String(p._id),
    sessionId: String(p.sessionId),
    employeeId: String(p.employeeId),
    latitude: p.latitude,
    longitude: p.longitude,
    accuracyMeters: p.accuracyMeters ?? null,
    capturedAt: p.capturedAt,
    receivedAt: p.receivedAt,
    pointKey: p.pointKey,
  };
}

// ============================================================================
// Small helpers
// ============================================================================

function toDateOrNull(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Compute distance (lower bound, straight-line between samples) and
 * average accuracy for a list of points.
 */
function summarizePoints(points) {
  if (!points || points.length === 0) {
    return { distanceMeters: 0, avgAccuracy: null };
  }

  let distanceMeters = 0;
  for (let i = 1; i < points.length; i += 1) {
    distanceMeters += haversineMeters(
      points[i - 1].latitude,
      points[i - 1].longitude,
      points[i].latitude,
      points[i].longitude,
    );
  }

  const withAcc = points.filter((p) => Number.isFinite(p.accuracyMeters));
  const avgAccuracy = withAcc.length
    ? withAcc.reduce((sum, p) => sum + p.accuracyMeters, 0) / withAcc.length
    : null;

  return { distanceMeters, avgAccuracy };
}

// ============================================================================
// Employee: session lifecycle
// ============================================================================

/**
 * Start a new tracking session for the current employee.
 *
 * Races are handled by the partial unique index on
 * { employeeId, status: 'ACTIVE' }. If two concurrent starts race, the
 * loser receives a Mongo E11000 error which we translate to 409 CONFLICT.
 */
export async function startSession({ employeeId, startLocation }) {
  const startedAt = new Date();

  try {
    const doc = await TrackingSession.create({
      employeeId,
      startedAt,
      status: SESSION_STATUS.ACTIVE,
      startLocation: startLocation || undefined,
    });
    return publicSession(doc);
  } catch (err) {
    if (err && err.code === 11000) {
      throw conflict('You already have an active session');
    }
    throw err;
  }
}

/**
 * End the current employee's active session.
 * Ending an already-ended session returns 409.
 */
export async function endSession({ sessionId, employeeId, endLocation }) {
  const session = await TrackingSession.findById(sessionId);
  if (!session) throw notFound('Session not found');
  if (String(session.employeeId) !== String(employeeId)) {
    throw forbidden('You do not own this session');
  }
  if (session.status !== SESSION_STATUS.ACTIVE) {
    throw conflict('Session is already ended');
  }

  session.status = SESSION_STATUS.ENDED;
  session.endedAt = new Date();
  if (endLocation) {
    session.endLocation = endLocation;
    session.lastLocationAt = endLocation.capturedAt ?? session.lastLocationAt;
  }
  await session.save();

  return publicSession(session);
}

// ============================================================================
// Employee: point ingestion
// ============================================================================

function normalizePointForSession({ session, employeeId, point }) {
  const capturedAt = toDateOrNull(point.capturedAt);
  if (!capturedAt) throw badRequest('capturedAt is required and must be a valid date');

  const now = Date.now();
  if (capturedAt.getTime() > now + TRACKING.FUTURE_SLACK_MS) {
    throw badRequest('capturedAt is too far in the future');
  }

  const lower = session.startedAt.getTime() - TRACKING.BOUNDARY_GRACE_MS;
  const upper =
    (session.endedAt ? session.endedAt.getTime() : now) + TRACKING.BOUNDARY_GRACE_MS;
  if (capturedAt.getTime() < lower || capturedAt.getTime() > upper) {
    throw badRequest('capturedAt is outside this session window');
  }

  return {
    sessionId: session._id,
    employeeId,
    latitude: point.latitude,
    longitude: point.longitude,
    accuracyMeters: point.accuracyMeters ?? undefined,
    capturedAt,
    receivedAt: new Date(),
    pointKey: point.pointKey,
  };
}

/**
 * Accept a batch of points for a session.
 *
 * Rules:
 *  - Session must exist and belong to the caller (checked by caller).
 *  - If session is ENDED: only accepted within OFFLINE_GRACE_MS of endedAt.
 *  - Duplicate pointKey inside a session → idempotent success.
 */
export async function ingestPoints({ session, employeeId, points }) {
  const now = Date.now();
  if (session.status === SESSION_STATUS.ENDED) {
    const endedMs = session.endedAt ? session.endedAt.getTime() : 0;
    if (now - endedMs > TRACKING.OFFLINE_GRACE_MS) {
      throw gone('Session sync window has expired');
    }
  }

  const normalized = points.map((p) =>
    normalizePointForSession({ session, employeeId, point: p }),
  );

  let inserted = 0;
  let insertErr = null;
  try {
    const res = await TrackingLocationPoint.insertMany(normalized, { ordered: false });
    inserted = res.length;
  } catch (err) {
    insertErr = err;
    if (Array.isArray(err?.writeErrors)) {
      for (const we of err.writeErrors) {
        const code = we?.err?.code ?? we?.code;
        if (code === 11000) continue; // duplicate — ignore
        throw err;
      }
      inserted = normalized.length - err.writeErrors.length;
    } else if (err && err.code === 11000) {
      inserted = 0;
    } else {
      throw err;
    }
  }

  if (inserted > 0) {
    const latest = normalized.reduce(
      (acc, p) => (p.capturedAt > acc ? p.capturedAt : acc),
      new Date(0),
    );
    await TrackingSession.updateOne(
      { _id: session._id },
      { $max: { lastLocationAt: latest } },
    );
  }

  return {
    received: normalized.length,
    inserted,
    duplicates: insertErr ? normalized.length - inserted : 0,
  };
}

// ============================================================================
// Employee: read own data
// ============================================================================

export async function listMySessions({ employeeId, page, limit, status }) {
  const filter = { employeeId };
  if (status === 'ACTIVE' || status === 'ENDED') filter.status = status;

  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    TrackingSession.find(filter).sort({ startedAt: -1 }).skip(skip).limit(limit).lean(),
    TrackingSession.countDocuments(filter),
  ]);

  return {
    sessions: items.map(publicSession),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  };
}

export async function getSessionForEmployee({ sessionId, employeeId }) {
  const s = await TrackingSession.findById(sessionId).lean();
  if (!s) throw notFound('Session not found');
  if (String(s.employeeId) !== String(employeeId)) {
    throw forbidden('You do not own this session');
  }
  return publicSession(s);
}

export async function listSessionPoints({ sessionId }) {
  const rows = await TrackingLocationPoint.find({ sessionId })
    .sort({ capturedAt: 1 })
    .lean();
  return rows.map(publicPoint);
}

// ============================================================================
// Admin: list, detail, force-close
// ============================================================================

/**
 * Enriched admin list: joins employee info and per-session point stats.
 * Returns sessions sorted by startedAt desc, filtered and paginated.
 */
export async function adminListSessions({ employeeId, status, from, to, page, limit }) {
  const filter = {};
  if (employeeId) filter.employeeId = employeeId;
  if (status === 'ACTIVE' || status === 'ENDED') filter.status = status;
  if (from || to) {
    filter.startedAt = {};
    if (from) filter.startedAt.$gte = from;
    if (to) filter.startedAt.$lte = to;
  }

  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    TrackingSession.find(filter).sort({ startedAt: -1 }).skip(skip).limit(limit).lean(),
    TrackingSession.countDocuments(filter),
  ]);

  // Bulk-fetch employee info (no N+1).
  const employeeIds = [...new Set(items.map((s) => String(s.employeeId)))];
  const employees = employeeIds.length
    ? await User.find({ _id: { $in: employeeIds } })
        .select('name email employeeCode role')
        .lean()
    : [];
  const employeeMap = new Map(employees.map((e) => [String(e._id), e]));

  // Bulk point-count aggregation by sessionId.
  const sessionIds = items.map((s) => s._id);
  const pointCounts = sessionIds.length
    ? await TrackingLocationPoint.aggregate([
        { $match: { sessionId: { $in: sessionIds } } },
        { $group: { _id: '$sessionId', count: { $sum: 1 } } },
      ])
    : [];
  const countMap = new Map(pointCounts.map((p) => [String(p._id), p.count]));

  return {
    sessions: items.map((s) => {
      const emp = employeeMap.get(String(s.employeeId));
      return {
        id: String(s._id),
        employeeId: String(s.employeeId),
        employee: emp
          ? {
              name: emp.name,
              email: emp.email,
              employeeCode: emp.employeeCode ?? null,
            }
          : null,
        startedAt: s.startedAt,
        endedAt: s.endedAt ?? null,
        status: s.status,
        lastLocationAt: s.lastLocationAt ?? null,
        pointCount: countMap.get(String(s._id)) ?? 0,
        startLocation: s.startLocation ?? null,
        endLocation: s.endLocation ?? null,
      };
    }),
    pagination: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

/**
 * Enriched detail with distance (Haversine lower bound), avg accuracy,
 * point count. Used by the owner dashboard.
 */
export async function getSessionForOwner({ sessionId }) {
  const s = await TrackingSession.findById(sessionId).lean();
  if (!s) throw notFound('Session not found');

  const employee = await User.findById(s.employeeId)
    .select('name email employeeCode role')
    .lean();

  const points = await TrackingLocationPoint.find({ sessionId: s._id })
    .sort({ capturedAt: 1 })
    .select('latitude longitude accuracyMeters capturedAt receivedAt')
    .lean();

  const { distanceMeters, avgAccuracy } = summarizePoints(points);

  return {
    id: String(s._id),
    employeeId: String(s.employeeId),
    employee: employee
      ? {
          name: employee.name,
          email: employee.email,
          employeeCode: employee.employeeCode ?? null,
        }
      : null,
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
    status: s.status,
    startLocation: s.startLocation ?? null,
    endLocation: s.endLocation ?? null,
    lastLocationAt: s.lastLocationAt ?? null,
    pointCount: points.length,
    distanceMeters,
    avgAccuracyMeters: avgAccuracy,
  };
}

/**
 * Force-close a session (OWNER-only). Used to unstick an abandoned
 * ACTIVE session. Writes an audit log entry at the route level.
 */
export async function forceCloseSession({ sessionId, ownerId }) {
  const s = await TrackingSession.findById(sessionId);
  if (!s) throw notFound('Session not found');
  if (s.status !== SESSION_STATUS.ACTIVE) {
    throw conflict('Session is already ended');
  }
  s.status = SESSION_STATUS.ENDED;
  s.endedAt = new Date();
  await s.save();
  return { session: publicSession(s), ownerId };
}

export { publicSession, publicPoint };