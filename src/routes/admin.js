import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ROLES } from '../models/User.js';
import { recordAudit } from '../services/audit.js';
import {
  listEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  publicUser,
} from '../services/employees.js';
import {
  adminListSessions,
  getSessionForOwner,
  listSessionPoints,
  forceCloseSession,
} from '../services/tracking.js';
import { getDashboardSummary } from '../services/dashboard.js';
import { reverseGeocode } from '../services/geocode.js';
import { getRoute } from '../services/directionsMapbox.js';
import { TrackingSession } from '../models/TrackingSession.js';
import { TrackingLocationPoint } from '../models/TrackingLocationPoint.js';
import { notFound } from '../lib/errors.js';

const router = Router();

// Every route in this file is OWNER-only.
router.use(requireAuth, requireRole(ROLES.OWNER));


router.get('/dashboard/summary', async (_req, res, next) => {
  try {
    const summary = await getDashboardSummary();
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Employees
// ============================================================================

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).default(''),
  status: z.enum(['active', 'inactive', 'all']).default('all'),
  role: z.enum(['OWNER', 'EMPLOYEE', 'all']).default('all'),
});

router.get('/employees', async (req, res, next) => {
  try {
    const params = listQuerySchema.parse(req.query);
    const result = await listEmployees(params);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/employees/:id', async (req, res, next) => {
  try {
    const employee = await getEmployeeById(req.params.id);
    res.json({ employee });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(200),
  role: z.enum(['OWNER', 'EMPLOYEE']).default('EMPLOYEE'),
  employeeCode: z.string().trim().min(1).max(32).optional(),
  active: z.boolean().optional(),
});

router.post('/employees', async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);
    const { user, actorId } = await createEmployee({ actor: req.user, data });
    await recordAudit({
      actorUserId: actorId,
      action: 'EMPLOYEE_CREATE',
      targetType: 'User',
      targetId: user._id,
      changes: {
        after: {
          name: user.name,
          email: user.email,
          role: user.role,
          employeeCode: user.employeeCode ?? null,
          active: user.active,
        },
      },
    });
    res.status(201).json({ employee: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    email: z.string().trim().email().max(254).optional(),
    password: z.string().min(8).max(200).optional(),
    role: z.enum(['OWNER', 'EMPLOYEE']).optional(),
    employeeCode: z
      .union([z.string().trim().min(1).max(32), z.literal(''), z.null()])
      .optional(),
    active: z.boolean().optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((obj) => Object.keys(obj).some((k) => k !== 'reason'), {
    message: 'At least one field must be provided',
  });

router.patch('/employees/:id', async (req, res, next) => {
  try {
    const patch = updateSchema.parse(req.body);
    const { reason, ...fields } = patch;

    const result = await updateEmployee({
      actor: req.user,
      targetId: req.params.id,
      patch: fields,
      reason,
    });

    let action = 'EMPLOYEE_UPDATE';
    if (fields.active !== undefined && result.before.active !== result.after.active) {
      action = result.after.active ? 'EMPLOYEE_ACTIVATE' : 'EMPLOYEE_DEACTIVATE';
    }

    await recordAudit({
      actorUserId: result.actorId,
      action,
      targetType: 'User',
      targetId: result.user._id,
      changes: result.changes,
      reason,
    });

    res.json({ employee: publicUser(result.user) });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Tracking sessions
// ============================================================================

const sessionListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  employeeId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, 'employeeId must be a 24-char hex id')
    .optional(),
  status: z.enum(['ACTIVE', 'ENDED', 'all']).default('all'),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

router.get('/tracking/sessions', async (req, res, next) => {
  try {
    const params = sessionListQuerySchema.parse(req.query);
    const result = await adminListSessions({
      employeeId: params.employeeId,
      status: params.status,
      from: params.from ? new Date(params.from) : undefined,
      to: params.to ? new Date(params.to) : undefined,
      page: params.page,
      limit: params.limit,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/tracking/sessions/:id', async (req, res, next) => {
  try {
    const session = await getSessionForOwner({ sessionId: req.params.id });
    res.json({ session });
  } catch (err) {
    next(err);
  }
});

router.get('/tracking/sessions/:id/locations', async (req, res, next) => {
  try {
    await getSessionForOwner({ sessionId: req.params.id });
    const points = await listSessionPoints({ sessionId: req.params.id });
    res.json({ points });
  } catch (err) {
    next(err);
  }
});

// ---------- Geocode session start/end ----------

router.get('/tracking/sessions/:id/geocode', async (req, res, next) => {
  try {
    const session = await TrackingSession.findById(req.params.id).lean();
    if (!session) throw notFound('Session not found');

    const [startAddress, endAddress] = await Promise.all([
      session.startLocation
        ? reverseGeocode(session.startLocation.latitude, session.startLocation.longitude)
        : Promise.resolve(null),
      session.endLocation
        ? reverseGeocode(session.endLocation.latitude, session.endLocation.longitude)
        : Promise.resolve(null),
    ]);

    res.json({
      sessionId: String(session._id),
      startAddress: startAddress || null,
      endAddress: endAddress || null,
      attribution: '© Mapbox, data © OpenStreetMap contributors',
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Geocoded points for session ----------

router.get('/tracking/sessions/:id/geocoded-points', async (req, res, next) => {
  try {
    await getSessionForOwner({ sessionId: req.params.id });
    const points = await TrackingLocationPoint.find({ sessionId: req.params.id })
      .sort({ capturedAt: 1 })
      .lean();

    const { geocodeSessionPoints } = await import('../services/geocodeSession.js');
    const geocoded = await geocodeSessionPoints(points);

    res.json({
      sessionId: req.params.id,
      points: geocoded,
      clusterRadiusMeters: 100,
      attribution: '© Mapbox, data © OpenStreetMap contributors',
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Force close ----------

const forceCloseSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

router.post('/tracking/sessions/:id/force-close', async (req, res, next) => {
  try {
    const { reason } = forceCloseSchema.parse(req.body ?? {});
    const { session } = await forceCloseSession({
      sessionId: req.params.id,
      ownerId: req.user.id,
    });
    await recordAudit({
      actorUserId: req.user.id,
      action: 'SESSION_FORCE_CLOSE',
      targetType: 'TrackingSession',
      targetId: session.id,
      reason,
    });
    res.json({ session });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Mapbox route — actual road-following route for a session
// ============================================================================

router.get('/tracking/sessions/:id/route', async (req, res, next) => {
  try {
    await getSessionForOwner({ sessionId: req.params.id });
    const points = await TrackingLocationPoint.find({ sessionId: req.params.id })
      .sort({ capturedAt: 1 })
      .lean();

    if (points.length < 2) {
      return res.json({
        sessionId: req.params.id,
        geometry: null,
        distanceMeters: 0,
        durationSeconds: 0,
        reason: 'Need at least two points',
      });
    }

    const route = await getRoute(points);

    if (!route) {
      return res.json({
        sessionId: req.params.id,
        geometry: null,
        distanceMeters: 0,
        durationSeconds: 0,
        reason: 'Route service unavailable',
      });
    }

    res.json({
      sessionId: req.params.id,
      geometry: route.geometry,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      attribution: '© Mapbox',
    });
  } catch (err) {
    next(err);
  }
});




router.get('/tracking/sessions/:id/timeline', async (req, res, next) => {
  try {
    await getSessionForOwner({ sessionId: req.params.id });
    const points = await TrackingLocationPoint.find({ sessionId: req.params.id })
      .sort({ capturedAt: 1 })
      .lean();

    const { buildVisitTimeline } = await import('../services/timeline.js');
    const result = await buildVisitTimeline(points);

    res.json({
      sessionId: req.params.id,
      segments: result.segments,
      summary: result.summary,
      attribution: '© Mapbox, data © OpenStreetMap contributors',
    });
  } catch (err) {
    next(err);
  }
});

export default router;