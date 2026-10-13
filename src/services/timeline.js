import { reverseGeocode } from './geocode.js';

function roundKey(lat, lng) {
  return `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
}

function minutesBetween(a, b) {
  const diff = new Date(b).getTime() - new Date(a).getTime();
  return Math.max(0, Math.round(diff / 60000));
}

export async function buildVisitTimeline(points) {
  if (!points || points.length === 0) {
    return {
      segments: [],
      summary: {
        totalDurationMinutes: 0,
        locationCount: 0,
        pointCount: 0,
        firstAddress: null,
        lastAddress: null,
      },
    };
  }

  // 1) Geocode each point (local cache keyed by rounded lat/lng).
  const geocodeCache = new Map();
  const enriched = [];

  for (const p of points) {
    const key = roundKey(p.latitude, p.longitude);
    let address = geocodeCache.get(key);

    if (address === undefined) {
      try {
        address = await reverseGeocode(p.latitude, p.longitude);
      } catch {
        address = null;
      }
      geocodeCache.set(key, address);
    }

    enriched.push({
      ...p,
      address: address || 'Unknown location',
    });
  }

  // 2) Merge consecutive points with the same address.
  const rawSegments = [];
  let current = null;

  for (const p of enriched) {
    if (!current || current.address !== p.address) {
      if (current) rawSegments.push(current);
      current = {
        address: p.address,
        startTime: p.capturedAt,
        endTime: p.capturedAt,
        pointCount: 1,
        lat: p.latitude,
        lng: p.longitude,
      };
    } else {
      current.endTime = p.capturedAt;
      current.pointCount += 1;
    }
  }
  if (current) rawSegments.push(current);

  // 3) Duration = time until next segment's first arrival (or last point).
  const segments = rawSegments.map((seg, i) => {
    const isLast = i === rawSegments.length - 1;
    const endForDuration = isLast
      ? seg.endTime
      : rawSegments[i + 1].startTime;

    const durationMinutes = minutesBetween(seg.startTime, endForDuration);

    return {
      address: seg.address,
      startTime: seg.startTime,
      endTime: seg.endTime,
      durationMinutes,
      pointCount: seg.pointCount,
      lat: seg.lat,
      lng: seg.lng,
    };
  });

  const totalDurationMinutes = segments.reduce((sum, s) => sum + s.durationMinutes, 0);

  return {
    segments,
    summary: {
      totalDurationMinutes,
      locationCount: segments.length,
      pointCount: points.length,
      firstAddress: segments[0]?.address ?? null,
      lastAddress: segments[segments.length - 1]?.address ?? null,
    },
  };
}