/**
 * Mapbox Directions API wrapper.
 *
 * Given a session's GPS points, we build a route that follows actual roads.
 * We use the "driving" profile by default; you can switch to "walking" or
 * "cycling" if your field employees walk.
 *
 * Mapbox Directions supports up to 25 coordinates per request. For longer
 * sessions we send chunks and stitch the geometry together.
 *
 * Returns:
 *   {
 *     geometry: { type: 'LineString', coordinates: [[lng, lat], ...] },
 *     distanceMeters: number,
 *     durationSeconds: number,
 *     waypoints: [ ... ],
 *   }
 */

import { env } from '../config/env.js';

const BASE_URL = 'https://api.mapbox.com/directions/v5/mapbox/driving';
const MAX_COORDS_PER_REQUEST = 25;

const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function pointsHash(points) {
  const first = points[0];
  const last = points[points.length - 1];
  return `${points.length}:${first.latitude.toFixed(4)},${first.longitude.toFixed(4)}:${last.latitude.toFixed(4)},${last.longitude.toFixed(4)}`;
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.t > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.v;
}

function setCached(key, value) {
  cache.set(key, { t: Date.now(), v: value });
}

/**
 * Downsample points to a reasonable number so we don't exceed the Mapbox
 * coordinate limit and keep the URL short. We keep the first and last
 * points and evenly sample the middle.
 */
function downsample(points, max) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i += 1) {
    out.push(points[Math.round(i * step)]);
  }
  return out;
}

async function requestChunk(coords) {
  const coordStr = coords
    .map((c) => `${Number(c[0]).toFixed(6)},${Number(c[1]).toFixed(6)}`)
    .join(';');

  const url =
    `${BASE_URL}/${coordStr}` +
    `?access_token=${encodeURIComponent(env.mapbox.secretToken)}` +
    `&geometries=geojson&overview=full&steps=false&annotations=distance,duration`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn('[directions-mapbox] HTTP', res.status);
      return null;
    }
    const data = await res.json();
    if (!data.routes || data.routes.length === 0) return null;
    return data.routes[0];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[directions-mapbox] fetch failed:', err.name, err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getRoute(points) {
  if (!env.mapbox.secretToken) {
    // eslint-disable-next-line no-console
    console.warn('[directions-mapbox] MAPBOX_SECRET_TOKEN not configured');
    return null;
  }
  if (!points || points.length < 2) return null;

  const hash = pointsHash(points);
  const cached = getCached(hash);
  if (cached) return cached;

  // [lng, lat] order per GeoJSON spec.
  const sampled = downsample(points, 200);
  const coords = sampled.map((p) => [p.longitude, p.latitude]);

  // Chunk if needed.
  const chunks = [];
  if (coords.length <= MAX_COORDS_PER_REQUEST) {
    chunks.push(coords);
  } else {
    for (let i = 0; i < coords.length; i += MAX_COORDS_PER_REQUEST - 1) {
      const end = Math.min(i + MAX_COORDS_PER_REQUEST, coords.length);
      chunks.push(coords.slice(i, end));
      if (end === coords.length) break;
    }
  }

  let totalDistance = 0;
  let totalDuration = 0;
  const allCoords = [];

  for (const chunk of chunks) {
    const route = await requestChunk(chunk);
    if (!route) continue;
    totalDistance += route.distance || 0;
    totalDuration += route.duration || 0;
    if (route.geometry && Array.isArray(route.geometry.coordinates)) {
      // Avoid duplicating the first point of each subsequent chunk.
      const toAppend = allCoords.length ? route.geometry.coordinates.slice(1) : route.geometry.coordinates;
      allCoords.push(...toAppend);
    }
  }

  if (allCoords.length === 0) return null;

  const result = {
    geometry: { type: 'LineString', coordinates: allCoords },
    distanceMeters: Math.round(totalDistance),
    durationSeconds: Math.round(totalDuration),
    waypoints: sampled.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
  };

  setCached(hash, result);
  // eslint-disable-next-line no-console
  console.log('[directions-mapbox] route built:', result.distanceMeters, 'm,', allCoords.length, 'coords');

  return result;
}