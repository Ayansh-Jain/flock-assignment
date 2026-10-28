import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { boundingBox, haversineKm } from '../src/geo.js';

const point = (latitude, longitude) => ({ latitude, longitude });
const EARTH_RADIUS_KM = 6371;

describe('haversineKm', () => {
  test('one degree of latitude is R * pi / 180 (about 111.195 km)', () => {
    const expected = (EARTH_RADIUS_KM * Math.PI) / 180;
    assert.ok(Math.abs(haversineKm(point(25, 75), point(26, 75)) - expected) < 1e-9);
    assert.ok(Math.abs(expected - 111.195) < 0.001);
  });

  test('a quarter of the equator is R * pi / 2 (about 10007.543 km)', () => {
    const expected = (EARTH_RADIUS_KM * Math.PI) / 2;
    assert.ok(Math.abs(haversineKm(point(0, 0), point(0, 90)) - expected) < 1e-6);
  });

  test('is zero for the same point and symmetric', () => {
    assert.equal(haversineKm(point(26.9, 75.8), point(26.9, 75.8)), 0);
    const a = point(26.9, 75.8);
    const b = point(28.6, 77.2);
    assert.equal(haversineKm(a, b), haversineKm(b, a));
  });

  test('goes the short way across the antimeridian', () => {
    const distance = haversineKm(point(0, 179.5), point(0, -179.5));
    assert.ok(Math.abs(distance - 111.195) < 0.001);
  });
});

describe('boundingBox', () => {
  const inside = (box, { latitude, longitude }) =>
    latitude >= box.minLat &&
    latitude <= box.maxLat &&
    box.lonRanges.some(([min, max]) => longitude >= min && longitude <= max);

  test('contains every point within the radius, in all directions', () => {
    const centre = point(26.9, 75.8);
    const box = boundingBox(centre, 10);
    for (let bearing = 0; bearing < 360; bearing += 15) {
      const rad = (bearing * Math.PI) / 180;
      // 9.9 km out, using the small-distance flat approximation (fine at this scale).
      const edge = point(
        centre.latitude + (9.9 / 111.195) * Math.cos(rad),
        centre.longitude +
          (9.9 / (111.195 * Math.cos((centre.latitude * Math.PI) / 180))) * Math.sin(rad),
      );
      assert.ok(inside(box, edge), `bearing ${bearing} should be inside the box`);
    }
    assert.ok(!inside(box, point(27.5, 75.8)), 'a point 60+ km north is outside');
  });

  test('wraps across the antimeridian into two longitude ranges', () => {
    const box = boundingBox(point(0, 179.9), 50);
    assert.ok(inside(box, point(0, -179.8)));
    assert.ok(inside(box, point(0, 179.6)));
    assert.ok(!inside(box, point(0, 0)));
  });

  test('spans all longitudes near a pole and clamps latitude', () => {
    const box = boundingBox(point(89.9, 10), 100);
    assert.equal(box.maxLat, 90);
    assert.deepEqual(box.lonRanges[0], [-180, 180]);
  });
});
