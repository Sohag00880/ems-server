

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'ems-fieldvisit/0.6 (contact: sohagislamdeveloper2@gmail.com)';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const cache = new Map();

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

let lastCallAt = 0;
async function respectRateLimit() {
  const since = Date.now() - lastCallAt;
  if (since < 1100) {
    await new Promise((r) => setTimeout(r, 1100 - since));
  }
  lastCallAt = Date.now();
}

/**
 * Build a village-level address from Nominatim's address components.
 * Prefers: village/neighbourhood → town/municipality → county → state
 * Example: "Bisik, Aditmari, Lalmonirhat, Bangladesh"
 */
function buildDetailedAddress(data) {
  const addr = data.address || {};
  const parts = [
    addr.village || addr.hamlet || addr.neighbourhood || addr.suburb,
    addr.town || addr.municipality || addr.city_district || addr.county,
    addr.state_district,
    addr.state,
    addr.country,
  ].filter(Boolean);

  if (parts.length > 0) return parts.join(', ');
  return data.display_name || null;
}

export async function reverseGeocodeNominatim(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const key = roundKey(lat, lng);
  const cached = getCached(key);
  if (cached) return cached;

  await respectRateLimit();

  const url =
    `${NOMINATIM_BASE}/reverse?format=jsonv2` +
    `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}` +
    `&zoom=18&addressdetails=1&accept-language=en`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn('[geocode-nominatim] HTTP', res.status, 'for', lat, lng);
      return null;
    }

    const data = await res.json();
    const address = buildDetailedAddress(data);

    if (address) {
      setCached(key, address);
      // eslint-disable-next-line no-console
      console.log('[geocode-nominatim] resolved', key, '→', address);
    }

    return address;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[geocode-nominatim] fetch failed:', err.name, err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}