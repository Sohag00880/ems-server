import mongoose from 'mongoose';

const trackingLocationPointSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TrackingSession',
      required: true,
      index: true,
    },
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    accuracyMeters: { type: Number, required: false, min: 0, max: 100_000 },
    capturedAt: { type: Date, required: true, index: true },
    receivedAt: { type: Date, required: true },
    pointKey: { type: String, required: true, minlength: 8, maxlength: 128 },
  },
  { timestamps: false, versionKey: false },
);

// Idempotency: same pointKey inside the same session is a duplicate.
trackingLocationPointSchema.index({ sessionId: 1, pointKey: 1 }, { unique: true });

// Efficient per-session chronological fetch.
trackingLocationPointSchema.index({ sessionId: 1, capturedAt: 1 });

export const TrackingLocationPoint =
  mongoose.models.TrackingLocationPoint ||
  mongoose.model('TrackingLocationPoint', trackingLocationPointSchema);