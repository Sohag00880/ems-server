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
let User;
let AuditLog;
let hashPassword;
let createApp;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri('ems_test');

  const connect = await import('../src/db/connect.js');
  await connect.connectDb();

  ({ User } = await import('../src/models/User.js'));
  ({ AuditLog } = await import('../src/models/AuditLog.js'));
  ({ hashPassword } = await import('../src/lib/passwords.js'));
  ({ createApp } = await import('../src/app.js'));
  app = createApp();
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await AuditLog.deleteMany({});
});

async function createUser({ email, password = 'Passw0rd!23', role = 'OWNER', active = true, employeeCode }) {
  const passwordHash = await hashPassword(password);
  return User.create({ name: role, email, passwordHash, role, active, employeeCode });
}

async function login(email, password = 'Passw0rd!23') {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res.body.accessToken;
}

describe('GET /api/admin/employees', () => {
  it('rejects without token', async () => {
    const res = await request(app).get('/api/admin/employees');
    expect(res.status).toBe(401);
  });

  it('denies employees', async () => {
    await createUser({ email: 'emp@example.com', role: 'EMPLOYEE', employeeCode: 'EMP001' });
    const token = await login('emp@example.com');
    const res = await request(app).get('/api/admin/employees').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('paginates and searches for owner', async () => {
    await createUser({ email: 'owner@example.com', role: 'OWNER' });
    for (let i = 1; i <= 25; i++) {
      await createUser({
        email: `u${i}@example.com`,
        role: 'EMPLOYEE',
        employeeCode: `EMP${String(i).padStart(3, '0')}`,
      });
    }
    const token = await login('owner@example.com');

    const page1 = await request(app)
      .get('/api/admin/employees?page=1&limit=10')
      .set('Authorization', `Bearer ${token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.employees.length).toBe(10);
    expect(page1.body.pagination.total).toBe(26);
    expect(page1.body.pagination.pages).toBe(3);

    const search = await request(app)
      .get('/api/admin/employees?q=u1')
      .set('Authorization', `Bearer ${token}`);
    expect(search.status).toBe(200);
    expect(search.body.employees.length).toBeGreaterThan(0);
    for (const e of search.body.employees) {
      expect(e.email.includes('u1') || e.name.includes('u1')).toBe(true);
    }
  });

  it('filters by status', async () => {
    await createUser({ email: 'owner@example.com', role: 'OWNER' });
    const activeEmp = await createUser({ email: 'a@example.com', role: 'EMPLOYEE' });
    const inactiveEmp = await createUser({ email: 'b@example.com', role: 'EMPLOYEE' });
    inactiveEmp.active = false;
    await inactiveEmp.save();
    void activeEmp;

    const token = await login('owner@example.com');
    const inactive = await request(app)
      .get('/api/admin/employees?status=inactive')
      .set('Authorization', `Bearer ${token}`);
    expect(inactive.status).toBe(200);
    expect(inactive.body.employees.length).toBe(1);
    expect(inactive.body.employees[0].email).toBe('b@example.com');
  });
});

describe('POST /api/admin/employees', () => {
  it('denies employees', async () => {
    await createUser({ email: 'emp@example.com', role: 'EMPLOYEE', employeeCode: 'EMP001' });
    const token = await login('emp@example.com');
    const res = await request(app)
      .post('/api/admin/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X', email: 'x@example.com', password: 'Passw0rd!23' });
    expect(res.status).toBe(403);
  });

  it('creates an employee and writes an audit log', async () => {
    await createUser({ email: 'owner@example.com', role: 'OWNER' });
    const token = await login('owner@example.com');

    const res = await request(app)
      .post('/api/admin/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'New Employee',
        email: 'new@example.com',
        password: 'Passw0rd!23',
        employeeCode: 'EMP010',
      });

    expect(res.status).toBe(201);
    expect(res.body.employee.email).toBe('new@example.com');
    expect(res.body.employee.role).toBe('EMPLOYEE');
    expect(res.body.employee.passwordHash).toBeUndefined();

    const logs = await AuditLog.find({ action: 'EMPLOYEE_CREATE' }).lean();
    expect(logs.length).toBe(1);
    expect(logs[0].targetId.toString()).toBe(res.body.employee.id);
  });

  it('rejects duplicate email', async () => {
    await createUser({ email: 'owner@example.com', role: 'OWNER' });
    await createUser({ email: 'dup@example.com', role: 'EMPLOYEE' });
    const token = await login('owner@example.com');

    const res = await request(app)
      .post('/api/admin/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Dup', email: 'dup@example.com', password: 'Passw0rd!23' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects duplicate employeeCode', async () => {
    await createUser({ email: 'owner@example.com', role: 'OWNER' });
    await createUser({ email: 'a@example.com', role: 'EMPLOYEE', employeeCode: 'EMP001' });
    const token = await login('owner@example.com');

    const res = await request(app)
      .post('/api/admin/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'B',
        email: 'b@example.com',
        password: 'Passw0rd!23',
        employeeCode: 'EMP001',
      });
    expect(res.status).toBe(409);
  });

  it('rejects invalid input', async () => {
    await createUser({ email: 'owner@example.com', role: 'OWNER' });
    const token = await login('owner@example.com');

    const res = await request(app)
      .post('/api/admin/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X', email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /api/admin/employees/:id', () => {
  it('denies employees', async () => {
    await createUser({ email: 'owner@example.com', role: 'OWNER' });
    const emp = await createUser({
      email: 'emp@example.com',
      role: 'EMPLOYEE',
      employeeCode: 'EMP001',
    });
    const token = await login('emp@example.com');
    const res = await request(app)
      .patch(`/api/admin/employees/${emp._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hax' });
    expect(res.status).toBe(403);
  });

  it('deactivates an employee and writes a specific audit action', async () => {
    await createUser({ email: 'owner@example.com', role: 'OWNER' });
    const emp = await createUser({
      email: 'emp@example.com',
      role: 'EMPLOYEE',
      employeeCode: 'EMP001',
    });
    const token = await login('owner@example.com');

    const res = await request(app)
      .patch(`/api/admin/employees/${emp._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ active: false, reason: 'left company' });
    expect(res.status).toBe(200);
    expect(res.body.employee.active).toBe(false);

    const logs = await AuditLog.find({ action: 'EMPLOYEE_DEACTIVATE' }).lean();
    expect(logs.length).toBe(1);
    expect(logs[0].reason).toBe('left company');
    expect(logs[0].changes.after.active).toBe(false);
  });

  it('deactivated employee loses access on next request', async () => {
    await createUser({ email: 'owner@example.com', role: 'OWNER' });
    const emp = await createUser({
      email: 'emp@example.com',
      role: 'EMPLOYEE',
      employeeCode: 'EMP001',
    });

    // Employee logs in and can hit /me.
    const empToken = await login('emp@example.com');
    const meBefore = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${empToken}`);
    expect(meBefore.status).toBe(200);

    // Owner deactivates.
    const ownerToken = await login('owner@example.com');
    const deact = await request(app)
      .patch(`/api/admin/employees/${emp._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ active: false });
    expect(deact.status).toBe(200);

    // Same token now fails.
    const meAfter = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${empToken}`);
    expect(meAfter.status).toBe(401);

    // And login now fails too.
    const relogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'emp@example.com', password: 'Passw0rd!23' });
    expect(relogin.status).toBe(401);
  });

  it('refuses to demote or deactivate the last active owner', async () => {
    await createUser({ email: 'owner@example.com', role: 'OWNER' });
    const token = await login('owner@example.com');

    // Find the owner id
    const owner = await User.findOne({ email: 'owner@example.com' }).lean();
    const res = await request(app)
      .patch(`/api/admin/employees/${owner._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ active: false });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('updates employeeCode and rejects duplicates', async () => {
    await createUser({ email: 'owner@example.com', role: 'OWNER' });
    const a = await createUser({
      email: 'a@example.com',
      role: 'EMPLOYEE',
      employeeCode: 'EMP001',
    });
    await createUser({ email: 'b@example.com', role: 'EMPLOYEE', employeeCode: 'EMP002' });
    const token = await login('owner@example.com');

    const ok = await request(app)
      .patch(`/api/admin/employees/${a._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ employeeCode: 'EMP003' });
    expect(ok.status).toBe(200);
    expect(ok.body.employee.employeeCode).toBe('EMP003');

    const clash = await request(app)
      .patch(`/api/admin/employees/${a._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ employeeCode: 'EMP002' });
    expect(clash.status).toBe(409);
  });

  it('rejects empty patch', async () => {
    await createUser({ email: 'owner@example.com', role: 'OWNER' });
    const emp = await createUser({
      email: 'emp@example.com',
      role: 'EMPLOYEE',
      employeeCode: 'EMP001',
    });
    const token = await login('owner@example.com');
    const res = await request(app)
      .patch(`/api/admin/employees/${emp._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });
});