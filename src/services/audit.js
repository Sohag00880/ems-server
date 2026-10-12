import { AuditLog } from '../models/AuditLog.js';

/**
 * Fire-and-forget audit write. We never fail the parent request because
 * the audit write failed — but we do log the error so it isn't silent.
 */
export async function recordAudit({
  actorUserId,
  action,
  targetType,
  targetId,
  changes,
  reason,
}) {
  try {
    await AuditLog.create({
      actorUserId,
      action,
      targetType,
      targetId,
      changes,
      reason,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit] failed to record:', action, err.message);
  }
}