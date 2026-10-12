import mongoose from 'mongoose';
import { env } from '../config/env.js';

export async function connectDb() {
  mongoose.set('strictQuery', true);

  mongoose.connection.on('connected', () => {
    // eslint-disable-next-line no-console
    console.log('[db] connected');
  });
  mongoose.connection.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[db] connection error:', err.message);
  });
  mongoose.connection.on('disconnected', () => {
    // eslint-disable-next-line no-console
    console.log('[db] disconnected');
  });

  await mongoose.connect(env.mongoUri);
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}