import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import {
    startSession,
    endSession,
    ingestPoints,
    listMySessions,
    getSessionForEmployee,
    listSessionPoints,
} from '../services/tracking.js';
import { TrackingSession } from '../models/TrackingSession.js';
import { notFound, forbidden } from '../lib/errors.js';
import { TRACKING } from '../config/tracking.js';
import { reverseGeocode } from '../services/geocode.js';

const router = Router();

router.use(requireAuth);

// ---------- Start ----------

const latLngSchema = z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyMeters: z.number().min(0).max(100_000).optional(),
    capturedAt: z.string().datetime({ offset: true }),
});

const startSchema = z.object({
    startLocation: latLngSchema.optional(),
});

router.post('/sessions/start', async (req, res, next) => {
    try {
        const { startLocation } = startSchema.parse(req.body ?? {});
        const session = await startSession({
            employeeId: req.user.id,
            startLocation: startLocation
                ? { ...startLocation, capturedAt: new Date(startLocation.capturedAt) }
                : undefined,
        });
        res.status(201).json({ session });
    } catch (err) {
        next(err);
    }
});

// ---------- End ----------

const endSchema = z.object({
    endLocation: latLngSchema.optional(),
});

router.post('/sessions/:id/end', async (req, res, next) => {
    try {
        const { endLocation } = endSchema.parse(req.body ?? {});
        const session = await endSession({
            sessionId: req.params.id,
            employeeId: req.user.id,
            endLocation: endLocation
                ? { ...endLocation, capturedAt: new Date(endLocation.capturedAt) }
                : undefined,
        });
        res.json({ session });
    } catch (err) {
        next(err);
    }
});

// ---------- Ingest points ----------

const pointSchema = z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyMeters: z.number().min(0).max(100_000).optional(),
    capturedAt: z.string().datetime({ offset: true }),
    pointKey: z.string().min(8).max(128),
});

const pointsSchema = z
    .object({
        // Accept either a single point or a batch. We normalize to a batch.
        point: pointSchema.optional(),
        points: z.array(pointSchema).min(1).max(TRACKING.MAX_POINTS_PER_BATCH).optional(),
    })
    .refine((v) => Boolean(v.point) !== Boolean(v.points), {
        message: 'Provide exactly one of `point` or `points`',
    });

router.post('/sessions/:id/locations', async (req, res, next) => {
    try {
        const body = pointsSchema.parse(req.body ?? {});
        const batch = body.points ?? [body.point];

        // Load and validate ownership.
        const session = await TrackingSession.findById(req.params.id);
        if (!session) throw notFound('Session not found');
        if (String(session.employeeId) !== String(req.user.id)) {
            throw forbidden('You do not own this session');
        }

        const result = await ingestPoints({
            session,
            employeeId: req.user.id,
            points: batch.map((p) => ({ ...p, capturedAt: new Date(p.capturedAt) })),
        });
        res.status(201).json(result);
    } catch (err) {
        next(err);
    }
});

// ---------- My sessions ----------

const listQuerySchema = z.object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['ACTIVE', 'ENDED', 'all']).default('all'),
});

router.get('/sessions/my', async (req, res, next) => {
    try {
        const params = listQuerySchema.parse(req.query);
        const result = await listMySessions({
            employeeId: req.user.id,
            page: params.page,
            limit: params.limit,
            status: params.status,
        });
        res.json(result);
    } catch (err) {
        next(err);
    }
});

// ---------- My session detail + my session points ----------

router.get('/sessions/:id', async (req, res, next) => {
    try {
        const session = await getSessionForEmployee({
            sessionId: req.params.id,
            employeeId: req.user.id,
        });
        res.json({ session });
    } catch (err) {
        next(err);
    }
});

router.get('/sessions/:id/locations', async (req, res, next) => {
    try {
        // Ownership check first.
        await getSessionForEmployee({ sessionId: req.params.id, employeeId: req.user.id });
        const points = await listSessionPoints({ sessionId: req.params.id });
        res.json({ points });
    } catch (err) {
        next(err);
    }
});




/**
 * GET /api/tracking/sessions/:id/geocode
 *
 * Human-readable start and end addresses for a session.
 * Employees can only geocode their own sessions.
 * Cheap: 2 Nominatim calls per session, cached for 24h.
 */
router.get('/sessions/:id/geocode', async (req, res, next) => {
    try {
        const session = await TrackingSession.findById(req.params.id).lean();
        if (!session) throw notFound('Session not found');
        if (String(session.employeeId) !== String(req.user.id)) {
            throw forbidden('You do not own this session');
        }

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
            attribution: '© OpenStreetMap contributors',
        });
    } catch (err) {
        next(err);
    }
});

export default router;