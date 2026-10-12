import { User, ROLES } from '../models/User.js';
import { TrackingSession } from '../models/TrackingSession.js';

/**
 * Start of today in the server's local timezone.
 * All dashboard "today" figures are anchored to this.
 */
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * KPI payload for the owner overview page.
 *
 * All numbers come from the database — no hardcoded demo data. If the
 * DB is empty, everything is 0 and the client renders empty states.
 *
 * Returned shape:
 *   {
 *     totalEmployees:        number   // EMPLOYEE role, active or not
 *     activeEmployees:       number   // EMPLOYEE role, active: true
 *     visitsToday:           number   // sessions with startedAt >= today 00:00
 *     currentlyActiveVisits: number   // sessions with status ACTIVE
 *     asOf:                  ISOString
 *   }
 */
export async function getDashboardSummary() {
  const todayStart = startOfToday();

  const [
    totalEmployees,
    activeEmployees,
    visitsToday,
    currentlyActiveVisits,
  ] = await Promise.all([
    User.countDocuments({ role: ROLES.EMPLOYEE }),
    User.countDocuments({ role: ROLES.EMPLOYEE, active: true }),
    TrackingSession.countDocuments({ startedAt: { $gte: todayStart } }),
    TrackingSession.countDocuments({ status: 'ACTIVE' }),
  ]);

  return {
    totalEmployees,
    activeEmployees,
    visitsToday,
    currentlyActiveVisits,
    asOf: new Date().toISOString(),
  };
}