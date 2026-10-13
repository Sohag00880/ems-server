/**
 * Mapbox Geocoding API wrapper.
 *
 * Uses the Mapbox V5 Geocoding API:
 *   GET https://api.mapbox.com/geocoding/v5/mapbox.places/{lng},{lat}.json
 *   ?access_token=...&language=en&types=address,place,locality,neighborhood
 *
 * Bangladesh village-level accuracy is significantly better than
 * Nominatim / BigDataCloud, so we prefer Mapbox when a token is present.
 *
 * Caching: in-memory, configurable TTL (default 24h), keyed by rounded
 * lat/lng. Repeat requests to the same location are near-instant.
 */

import { env } from '../config/env.js';

const BASE_URL = 'https://api.mapbox.com/geocoding/v5/mapbox.places';

const cache = new Map();

function cacheTtlMs() {
  return env.geocode.cacheTtlHours * 60 * 60 * 1000;
}

function roundKey(lat, lng) {
  return `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.t > cacheTtlMs()) {
    cache.delete(key);
    return null;
  }
  return entry.v;
}

function setCached(key, value) {
  cache.set(key, { t: Date.now(), v: value });
}

/**
 * Build a concise address string from Mapbox features.
 *
 * Mapbox returns place_name like:
 *   "Bisik, Aditmari, Lalmonirhat, Rangpur Division, Bangladesh"
 *
 * We keep it whole but trim to at most 6 comma-separated parts.
 */
function buildAddressFromResponse(data) {
  if (!data.features || data.features.length === 0) return null;
  const feature = data.features[0];
  const placeName = feature.place_name || feature.text;
  if (!placeName) return null;
  const parts = placeName.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.slice(0, 6).join(', ');
}

export function isMapboxEnabled() {
  return Boolean(env.mapbox.secretToken);
}

export async function reverseGeocodeMapbox(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (!isMapboxEnabled()) return null;

  const key = roundKey(lat, lng);
  const cached = getCached(key);
  if (cached) {
    // eslint-disable-next-line no-console
    console.log('[geocode-mapbox] cache hit', key, '→', cached);
    return cached;
  }

  const url =
    `${BASE_URL}/${encodeURIComponent(lng)},${encodeURIComponent(lat)}.json` +
    `?access_token=${encodeURIComponent(env.mapbox.secretToken)}` +
    `&language=en&limit=1&types=address,place,locality,neighborhood,region,country`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn('[geocode-mapbox] HTTP', res.status, 'for', lat, lng);
      return null;
    }

    const data = await res.json();
    const address = buildAddressFromResponse(data);
    if (address) {
      setCached(key, address);
      // eslint-disable-next-line no-console
      console.log('[geocode-mapbox] resolved', key, '→', address);
    } else {
      // eslint-disable-next-line no-console
      console.warn('[geocode-mapbox] no features for', lat, lng);
    }
    return address;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[geocode-mapbox] fetch failed:', err.name, err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}