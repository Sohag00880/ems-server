
import { reverseGeocodeMapbox, isMapboxEnabled } from './geocodeMapbox.js';

const BIGDATA_BASE = 'https://api.bigdatacloud.net/data/reverse-geocode-client';

const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function roundKey(lat, lng) {
  return `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
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

function buildBigDataAddress(data) {
  const locality = data.locality || null;
  const city = data.city || data.principalSubdivision || null;
  const country = data.countryName || null;
  const parts = [locality, city, country].filter(Boolean);
  if (parts.length > 0) return parts.join(', ');
  return data.locality || data.city || data.principalSubdivision || null;
}

async function bigDataCloud(lat, lng) {
  const url =
    `${BIGDATA_BASE}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}` +
    `&localityLanguage=en`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return buildBigDataAddress(data);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function reverseGeocode(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    // eslint-disable-next-line no-console
    console.warn('[geocode] invalid coords:', lat, lng);
    return null;
  }

  const key = roundKey(lat, lng);
  const cached = getCached(key);
  if (cached) return cached;

  let address = null;

  // 1. Mapbox first, if configured.
  if (isMapboxEnabled()) {
    try {
      address = await reverseGeocodeMapbox(lat, lng);
    } catch {
      address = null;
    }
  }

  // 2. Fall back to BigDataCloud.
  if (!address) {
    // eslint-disable-next-line no-console
    console.log('[geocode] Mapbox returned nothing — falling back to BigDataCloud for', lat, lng);
    address = await bigDataCloud(lat, lng);
  }

  if (address) {
    setCached(key, address);
    // eslint-disable-next-line no-console
    console.log('[geocode] resolved', key, '→', address);
  } else {
    // eslint-disable-next-line no-console
    console.warn('[geocode] no address found for', lat, lng);
  }

  return address;
}