// Pure geographic helpers for the "near this location" query. No I/O.

const EARTH_RADIUS_KM = 6371;
const KM_PER_DEGREE_LAT = (Math.PI * EARTH_RADIUS_KM) / 180;
const toRadians = (degrees) => (degrees * Math.PI) / 180;

/**
 * Great-circle distance between two WGS84 points (haversine, spherical Earth).
 * Good to roughly 0.5% against the ellipsoid, plenty for "what is near here".
 *
 * @param {{ latitude: number, longitude: number }} a
 * @param {{ latitude: number, longitude: number }} b
 * @returns {number} Kilometres.
 */
export function haversineKm(a, b) {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A latitude/longitude box that contains every point within `radiusKm` of the centre, for a cheap
 * SQL prefilter (the exact distance is checked afterwards). Longitude comes back as two ranges so
 * a box crossing the antimeridian still works; when the box does not wrap, both are the same
 * range. Near a pole the box spans all longitudes.
 *
 * @param {{ latitude: number, longitude: number }} centre
 * @param {number} radiusKm
 * @returns {{ minLat: number, maxLat: number, lonRanges: [[number, number], [number, number]] }}
 */
export function boundingBox(centre, radiusKm) {
  const dLat = radiusKm / KM_PER_DEGREE_LAT;
  const minLat = Math.max(-90, centre.latitude - dLat);
  const maxLat = Math.min(90, centre.latitude + dLat);
  const whole = [
    [-180, 180],
    [-180, 180],
  ];
  if (maxLat >= 90 || minLat <= -90) return { minLat, maxLat, lonRanges: whole };

  // The box is widest at the latitude closest to the equator.
  const widestCos = Math.cos(toRadians(Math.max(Math.abs(minLat), Math.abs(maxLat))));
  const dLon = radiusKm / (KM_PER_DEGREE_LAT * widestCos);
  if (dLon >= 180) return { minLat, maxLat, lonRanges: whole };

  const west = centre.longitude - dLon;
  const east = centre.longitude + dLon;
  if (west < -180) {
    return {
      minLat,
      maxLat,
      lonRanges: [
        [west + 360, 180],
        [-180, east],
      ],
    };
  }
  if (east > 180) {
    return {
      minLat,
      maxLat,
      lonRanges: [
        [west, 180],
        [-180, east - 360],
      ],
    };
  }
  return {
    minLat,
    maxLat,
    lonRanges: [
      [west, east],
      [west, east],
    ],
  };
}
