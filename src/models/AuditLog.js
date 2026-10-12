import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema(
  {
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action: { type: String, required: true, index: true },
    targetType: { type: String, required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: false, index: true },
    changes: { type: mongoose.Schema.Types.Mixed, default: undefined },
    reason: { type: String, trim: true, maxlength: 500, default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

auditLogSchema.index({ actorUserId: 1, createdAt: -1 });

export const AuditLog =
  mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema);