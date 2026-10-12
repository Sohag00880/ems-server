import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(64);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(64);
process.env.MONGODB_URI = 'mongodb://127.0.0.1:0/placeholder';
process.env.CORS_ORIGINS = 'http://localhost:5173';

let mongo;
let app;
let createApp;
let User;
let TrackingSession;
let TrackingLocationPoint;
let hashPassword;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri('ems_tracking_test');

  const connect = await import('../src/db/connect.js');
  await connect.connectDb();

  ({ User } = await import('../src/models/User.js'));
  ({ TrackingSession } = await import('../src/models/TrackingSession.js'));
  ({ TrackingLocationPoint } = await import('../src/models/TrackingLocationPoint.js'));
  ({ hashPassword } = await import('../src/lib/passwords.js'));
  ({ createApp } = await import('../src/app.js'));
  app = createApp();

  // Ensure indexes are built (partial unique index matters for race tests).
  await TrackingSession.syncIndexes();
  await TrackingLocationPoint.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await TrackingSession.deleteMany({});
  await TrackingLocationPoint.deleteMany({});
});

async function createUser({ email, password = 'Passw0rd!23', role = 'EMPLOYEE', active = true, employeeCode }) {
  const passwordHash = await hashPassword(password);
  return User.create({ name: role, email, passwordHash, role, active, employeeCode });
}

async function login(email, password = 'Passw0rd!23') {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res.body.accessToken;
}

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString();
}

describe('POST /api/tracking/sessions/start', () => {
  it('rejects without token', async () => {
    const res = await request(app).post('/api/tracking/sessions/start').send({});
    expect(res.status).toBe(401);
  });

  it('starts a session for the authenticated employee', async () => {
    await createUser({ email: 'emp@example.com', employeeCode: 'EMP001' });
    const token = await login('emp@example.com');
    const res = await request(app)
      .post('/api/tracking/sessions/start')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.session.status).toBe('ACTIVE');
    expect(res.body.session.startedAt).toBeTruthy();
  });

  it('accepts an optional startLocation', async () => {
    await createUser({ email: 'emp@example.com', employeeCode: 'EMP001' });
    const token = await login('emp@example.com');
    const res = await request(app)
      .post('/api/tracking/sessions/start')
      .set('Authorization', `Bearer ${token}`)
      .send({
        startLocation: {
          latitude: 23.78,
          longitude: 90.4,
          accuracyMeters: 12.5,
          capturedAt: new Date().toISOString(),
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.session.startLocation.latitude).toBeCloseTo(23.78);
  });

  it('rejects a second concurrent start with 409', async () => {
    await createUser({ email: 'emp@example.com', employeeCode: 'EMP001' });
    const token = await login('emp@example.com');

    const [a, b] = await Promise.all([
      request(app)
        .post('/api/tracking/sessions/start')
        .set('Authorization', `Bearer ${token}`)
        .send({}),
      request(app)
        .post('/api/tracking/sessions/start')
        .set('Authorization', `Bearer ${token}`)
        .send({}),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const count = await TrackingSession.countDocuments({ status: 'ACTIVE' });
    expect(count).toBe(1);
  });

  it('rejects invalid coordinates', async () => {
    await createUser({ email: 'emp@example.com', employeeCode: 'EMP001' });
    const token = await login('emp@example.com');
    const res = await request(app)
      .post('/api/tracking/sessions/start')
      .set('Authorization', `Bearer ${token}`)
      .send({
        startLocation: {
          latitude: 999,
          longitude: 0,
          capturedAt: new Date().toISOString(),
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/tracking/sessions/:id/end', () => {
  it('ends the active session and stamps server time', async () => {
    await createUser({ email: 'emp@example.com', employeeCode: 'EMP001' });
    const token = await login('emp@example.com');
    const start = await request(app)
      .post('/api/tracking/sessions/start')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const id = start.body.session.id;

    const end = await request(app)
      .post(`/api/tracking/sessions/${id}/end`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(end.status).toBe(200);
    expect(end.body.session.status).toBe('ENDED');
    expect(end.body.session.endedAt).toBeTruthy();
  });

  it('rejects ending an already-ended session with 409', async () => {
    await createUser({ email: 'emp@example.com', employeeCode: 'EMP001' });
    const token = await login('emp@example.com');
    const start = await request(app)
      .post('/api/tracking/sessions/start')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const id = start.body.session.id;
    await request(app)
      .post(`/api/tracking/sessions/${id}/end`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const again = await request(app)
      .post(`/api/tracking/sessions/${id}/end`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(again.status).toBe(409);
  });

  it('blocks ending another employee’s session with 403', async () => {
    const a = await createUser({ email: 'a@example.com', employeeCode: 'EMP001' });
    await createUser({ email: 'b@example.com', employeeCode: 'EMP002' });
    const aToken = await login('a@example.com');
    const bToken = await login('b@example.com');

    const start = await request(app)
      .post('/api/tracking/sessions/start')
      .set('Authorization', `Bearer ${aToken}`)
      .send({});
    void a;
    const id = start.body.session.id;

    const res = await request(app)
      .post(`/api/tracking/sessions/${id}/end`)
      .set('Authorization', `Bearer ${bToken}`)
      .send({});
    expect(res.status).toBe(403);
  });
});

describe('POST /api/tracking/sessions/:id/locations', () => {
  it('accepts a single point inside the session window', async () => {
    await createUser({ email: 'emp@example.com', employeeCode: 'EMP001' });
    const token = await login('emp@example.com');
    const start = await request(app)
      .post('/api/tracking/sessions/start')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const id = start.body.session.id;

    const res = await request(app)
      .post(`/api/tracking/sessions/${id}/locations`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        point: {
          latitude: 23.78,
          longitude: 90.4,
          accuracyMeters: 8.5,
          capturedAt: new Date().toISOString(),
          pointKey: 'p-1-abcdefgh',
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(1);

    // Session lastLocationAt is updated.
    const s = await TrackingSession.findById(id).lean();
    expect(s.lastLocationAt).toBeTruthy();
  });

  it('deduplicates retries with the same pointKey', async () => {
    await createUser({ email: 'emp@example.com', employeeCode: 'EMP001' });
    const token = await login('emp@example.com');
    const start = await request(app)
      .post('/api/tracking/sessions/start')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const id = start.body.session.id;

    const payload = {
      point: {
        latitude: 23.78,
        longitude: 90.4,
        capturedAt: new Date().toISOString(),
        pointKey: 'p-retry-key',
      },
    };

    const a = await request(app)
      .post(`/api/tracking/sessions/${id}/locations`)
      .set('Authorization', `Bearer ${token}`)
      .send(payload);
    const b = await request(app)
      .post(`/api/tracking/sessions/${id}/locations`)
      .set('Authorization', `Bearer ${token}`)
      .send(payload);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.inserted).toBe(0);
    expect(b.body.duplicates).toBe(1);

    const count = await TrackingLocationPoint.countDocuments({ sessionId: id });
    expect(count).toBe(1);
  });

  it('rejects a point captured before the session started', async () => {
    await createUser({ email: 'emp@example.com', employeeCode: 'EMP001' });
    const token = await login('emp@example.com');
    const start = await request(app)
      .post('/api/tracking/sessions/start')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const id = start.body.session.id;

    const res = await request(app)
      .post(`/api/tracking/sessions/${id}/locations`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        point: {
          latitude: 23.78,
          longitude: 90.4,
          capturedAt: isoAgo(60 * 60 * 1000), // 1 hour before start
          pointKey: 'p-old-key',
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/outside this session window/i);
  });

  it('rejects a point captured far in the future', async () => {
    await createUser({ email: 'emp@example.com', employeeCode: 'EMP001' });
    const token = await login('emp@example.com');
    const start = await request(app)
      .post('/api/tracking/sessions/start')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const id = start.body.session.id;

    const res = await request(app)
      .post(`/api/tracking/sessions/${id}/locations`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        point: {
          latitude: 23.78,
          longitude: 90.4,
          capturedAt: isoIn(60 * 60 * 1000), // 1 hour from now
          pointKey: 'p-future-key',
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/future/i);
  });

  it('rejects points for another employee’s session with 403', async () => {
    await createUser({ email: 'a@example.com', employeeCode: 'EMP001' });
    await createUser({ email: 'b@example.com', employeeCode: 'EMP002' });
    const aToken = await login('a@example.com');
    const bToken = await login('b@example.com');

    const start = await request(app)
      .post('/api/tracking/sessions/start')
      .set('Authorization', `Bearer ${aToken}`)
      .send({});
    const id = start.body.session.id;

    const res = await request(app)
      .post(`/api/tracking/sessions/${id}/locations`)
      .set('Authorization', `Bearer ${bToken}`)
      .send({
        point: {
          latitude: 23.78,
          longitude: 90.4,
          capturedAt: new Date().toISOString(),
          pointKey: 'p-cross-key',
        },
      });
    expect(res.status).toBe(403);
  });

  it('accepts offline points captured during the session, uploaded shortly after end', async () => {
    await createUser({ email: 'emp@example.com', employeeCode: 'EMP001' });
    const token = await login('emp@example.com');

    const start = await request(app)
      .post('/api/tracking/sessions/start')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const id = start.body.session.id;

    // Build a batch whose capturedAt sits between startedAt and now.
    const batch = [0, 1000, 2000, 3000].map((offset, i) => ({
      latitude: 23.78 + i * 0.0001,
      longitude: 90.4 + i * 0.0001,
      capturedAt: new Date(Date.now() - 10_000 + offset).toISOString(),
      pointKey: `p-offline-${i}-abcdefgh`,
    }));

    // End the session.
    await request(app)
      .post(`/api/tracking/sessions/${id}/end`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    // Upload the batch after end — still inside grace window.
    const res = await request(app)
      .post(`/api/tracking/sessions/${id}/locations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ points: batch });
    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(4);
  });

  it('rejects uploads for a closed session after the offline grace window', async () => {
    const emp = await createUser({ email: 'emp@example.com', employeeCode: 'EMP001' });
    const token = await login('emp@example.com');

    // Directly create a session that ended long ago.
    const startAt = new Date(Date.now() - 10 * 60 * 60 * 1000); // 10h ago
    const endAt = new Date(Date.now() - 8 * 60 * 60 * 1000);   // 8h ago
    const s = await TrackingSession.create({
      employeeId: emp._id,
      startedAt: startAt,
      endedAt: endAt,
      status: 'ENDED',
    });

    const res = await request(app)
      .post(`/api/tracking/sessions/${s._id}/locations`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        point: {
          latitude: 23.78,
          longitude: 90.4,
          capturedAt: new Date(startAt.getTime() + 60 * 1000).toISOString(),
          pointKey: 'p-late-key',
        },
      });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('GONE');
  });

  it('rejects invalid coordinates', async () => {
    await createUser({ email: 'emp@example.com', employeeCode: 'EMP001' });
    const token = await login('emp@example.com');
    const start = await request(app)
      .post('/api/tracking/sessions/start')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const id = start.body.session.id;

    const res = await request(app)
      .post(`/api/tracking/sessions/${id}/locations`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        point: {
          latitude: 123,
          longitude: 500,
          capturedAt: new Date().toISOString(),
          pointKey: 'p-bad-key',
        },
      });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/tracking/sessions/my', () => {
  it('returns only the caller’s sessions', async () => {
    await createUser({ email: 'a@example.com', employeeCode: 'EMP001' });
    await createUser({ email: 'b@example.com', employeeCode: 'EMP002' });
    const aToken = await login('a@example.com');
    const bToken = await login('b@example.com');

    await request(app)
      .post('/api/tracking/sessions/start')
      .set('Authorization', `Bearer ${aToken}`)
      .send({});

    const mine = await request(app)
      .get('/api/tracking/sessions/my')
      .set('Authorization', `Bearer ${aToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.sessions.length).toBe(1);

    const theirs = await request(app)
      .get('/api/tracking/sessions/my')
      .set('Authorization', `Bearer ${bToken}`);
    expect(theirs.body.sessions.length).toBe(0);
  });
});

describe('Admin session endpoints', () => {
  it('employee cannot list all sessions', async () => {
    await createUser({ email: 'emp@example.com', employeeCode: 'EMP001' });
    const token = await login('emp@example.com');
    const res = await request(app)
      .get('/api/admin/tracking/sessions')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('owner can list sessions, filter by employee, and read points', async () => {
    await createUser({ email: 'owner@example.com', role: 'OWNER' });
    const emp = await createUser({ email: 'emp@example.com', employeeCode: 'EMP001' });
    const empToken = await login('emp@example.com');
    const ownerToken = await login('owner@example.com');

    // Employee starts + uploads a point, then ends.
    const start = await request(app)
      .post('/api/tracking/sessions/start')
      .set('Authorization', `Bearer ${empToken}`)
      .send({});
    const id = start.body.session.id;
    await request(app)
      .post(`/api/tracking/sessions/${id}/locations`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({
        point: {
          latitude: 23.78,
          longitude: 90.4,
          capturedAt: new Date().toISOString(),
          pointKey: 'p-admin-1',
        },
      });

    const list = await request(app)
      .get(`/api/admin/tracking/sessions?employeeId=${emp._id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.sessions.length).toBe(1);

    const detail = await request(app)
      .get(`/api/admin/tracking/sessions/${id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.session.id).toBe(id);

    const points = await request(app)
      .get(`/api/admin/tracking/sessions/${id}/locations`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(points.status).toBe(200);
    expect(points.body.points.length).toBe(1);
  });

  it('owner can force-close a stale session and the audit log records it', async () => {
    await createUser({ email: 'owner@example.com', role: 'OWNER' });
    const emp = await createUser({ email: 'emp@example.com', employeeCode: 'EMP001' });
    const empToken = await login('emp@example.com');
    const ownerToken = await login('owner@example.com');

    const start = await request(app)
      .post('/api/tracking/sessions/start')
      .set('Authorization', `Bearer ${empToken}`)
      .send({});
    const id = start.body.session.id;

    const res = await request(app)
      .post(`/api/admin/tracking/sessions/${id}/force-close`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ reason: 'abandoned' });
    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe('ENDED');

    const { AuditLog } = await import('../src/models/AuditLog.js');
    const logs = await AuditLog.find({ action: 'SESSION_FORCE_CLOSE' }).lean();
    expect(logs.length).toBe(1);
    expect(logs[0].reason).toBe('abandoned');

    void emp;
  });
});