import { reverseGeocode } from './geocode.js';

/**
 * Cluster consecutive points within CLUSTER_RADIUS_M of each other and
 * reverse-geocode each cluster once.
 */
const CLUSTER_RADIUS_M = 100;

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export async function geocodeSessionPoints(points) {
  if (!points || points.length === 0) return [];

  const sorted = [...points].sort(
    (a, b) => new Date(a.capturedAt) - new Date(b.capturedAt),
  );

  const clusters = [];
  let current = null;

  for (const p of sorted) {
    if (!current) {
      current = { anchor: { lat: p.latitude, lng: p.longitude }, points: [p] };
      continue;
    }
    const d = distanceMeters(
      current.anchor.lat,
      current.anchor.lng,
      p.latitude,
      p.longitude,
    );
    if (d <= CLUSTER_RADIUS_M) {
      current.points.push(p);
    } else {
      clusters.push(current);
      current = { anchor: { lat: p.latitude, lng: p.longitude }, points: [p] };
    }
  }
  if (current) clusters.push(current);

  const results = await Promise.all(
    clusters.map(async (c) => {
      const addr = await reverseGeocode(c.anchor.lat, c.anchor.lng);
      return c.points.map((p) => ({
        pointId: String(p._id),
        address: addr ?? null,
        anchor: { lat: c.anchor.lat, lng: c.anchor.lng },
      }));
    }),
  );

  return results.flat();
}

export { CLUSTER_RADIUS_M };