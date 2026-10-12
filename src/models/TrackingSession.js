import mongoose from 'mongoose';

export const SESSION_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  ENDED: 'ENDED',
});

const geoPointSchema = new mongoose.Schema(
  {
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    accuracyMeters: { type: Number, required: false, min: 0, max: 100_000 },
    capturedAt: { type: Date, required: true },
  },
  { _id: false },
);

const trackingSessionSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    startedAt: { type: Date, required: true, index: true },
    endedAt: { type: Date, default: null, index: true },
    status: {
      type: String,
      enum: Object.values(SESSION_STATUS),
      required: true,
      default: SESSION_STATUS.ACTIVE,
      index: true,
    },
    startLocation: { type: geoPointSchema, default: undefined },
    endLocation: { type: geoPointSchema, default: undefined },
    lastLocationAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

// One ACTIVE session per employee — enforced at DB level, not app level.
trackingSessionSchema.index(
  { employeeId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' } },
);

// Admin list: filter by employee and sort by startedAt.
trackingSessionSchema.index({ employeeId: 1, startedAt: -1 });

export const TrackingSession =
  mongoose.models.TrackingSession ||
  mongoose.model('TrackingSession', trackingSessionSchema);