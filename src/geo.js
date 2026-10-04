const EARTH_RADIUS_MILES = 3958.7613;

const toRad = (deg) => (deg * Math.PI) / 180;

export function distanceMiles(aLat, aLon, bLat, bLon) {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function insideArea(lat, lon, center, radiusMiles) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return distanceMiles(center.lat, center.lon, lat, lon) <= radiusMiles;
}