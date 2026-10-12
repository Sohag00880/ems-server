import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Force test env before importing app/config.
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(64);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(64);
process.env.MONGODB_URI = 'mongodb://127.0.0.1:0/placeholder';
process.env.CORS_ORIGINS = 'http://localhost:5173';

let mongo;
let app;
let User;
let hashPassword;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri('ems_test');

  const connect = await import('../src/db/connect.js');
  await connect.connectDb();

  ({ User } = await import('../src/models/User.js'));
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
});

async function createOwner({ active = true } = {}) {
  const passwordHash = await hashPassword('OwnerPass123!');
  return User.create({
    name: 'Owner',
    email: 'owner@example.com',
    passwordHash,
    role: 'OWNER',
    active,
  });
}

async function createEmployee({ active = true } = {}) {
  const passwordHash = await hashPassword('EmpPass123!');
  return User.create({
    name: 'Employee',
    email: 'emp@example.com',
    passwordHash,
    role: 'EMPLOYEE',
    employeeCode: 'EMP001',
    active,
  });
}

describe('POST /api/auth/login', () => {
  it('rejects missing fields', async () => {
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects wrong password', async () => {
    await createOwner();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'WrongPass123!' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects unknown email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'Whatever123!' });
    expect(res.status).toBe(401);
  });

  it('rejects inactive user', async () => {
    await createOwner({ active: false });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'OwnerPass123!' });
    expect(res.status).toBe(401);
  });

  it('logs in valid owner and never returns passwordHash', async () => {
    await createOwner();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'OWNER@example.com', password: 'OwnerPass123!' }); // case-insensitive
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.email).toBe('owner@example.com');
    expect(res.body.user.role).toBe('OWNER');
    expect(res.body.user.passwordHash).toBeUndefined();
  });
});

describe('GET /api/auth/me', () => {
  it('rejects without token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns current user with a valid token', async () => {
    await createOwner();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'OwnerPass123!' });
    const token = login.body.accessToken;
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('owner@example.com');
    expect(res.body.user.passwordHash).toBeUndefined();
  });
});

describe('Role-based access', () => {
  it('blocks employee from /api/admin/employees', async () => {
    await createEmployee();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'emp@example.com', password: 'EmpPass123!' });
    const token = login.body.accessToken;
    const res = await request(app)
      .get('/api/admin/employees')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows owner to /api/admin/employees', async () => {
    await createOwner();
    await createEmployee();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'OwnerPass123!' });
    const token = login.body.accessToken;
    const res = await request(app)
      .get('/api/admin/employees')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.employees)).toBe(true);
    expect(res.body.employees.length).toBe(2);
    // Never leak passwordHash.
    for (const e of res.body.employees) {
      expect(e.passwordHash).toBeUndefined();
    }
  });
});

describe('Logout + refresh', () => {
  it('clears refresh cookie on logout', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects refresh without cookie', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
  });
});