

const BASE_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
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

/**
 * Build a short display string from BigDataCloud's response.
 * Prefers: "Locality, City, Country" → e.g. "Gulshan 2, Dhaka, Bangladesh".
 */
function buildAddress(data) {
  const locality = data.locality || null;
  const city = data.city || data.principalSubdivision || null;
  const country = data.countryName || null;

  const parts = [locality, city, country].filter(Boolean);
  if (parts.length > 0) return parts.join(', ');

  return data.locality || data.city || data.principalSubdivision || null;
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

  const url =
    `${BASE_URL}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}` +
    `&localityLanguage=en`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn('[geocode] HTTP', res.status, 'for', lat, lng);
      return null;
    }

    const data = await res.json();
    const address = buildAddress(data);
    if (address) {
      setCached(key, address);
      // eslint-disable-next-line no-console
      console.log('[geocode] resolved', key, '→', address);
    } else {
      // eslint-disable-next-line no-console
      console.warn('[geocode] no address in response for', lat, lng, data);
    }
    return address;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[geocode] fetch failed:', err.name, err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}