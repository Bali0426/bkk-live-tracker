/**
 * Konvex burok (Monotone Chain) és lekerekített OSM-stílusú poligon generátor
 * a BKK megállócsoportok (csomópontok) vizuális megjelenítéséhez.
 */

export type LatLonPoint = [number, number];

export function getConvexHull(points: LatLonPoint[]): LatLonPoint[] {
  if (points.length <= 2) return points.slice();
  const pts = points
    .slice()
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));

  const cross = (o: LatLonPoint, a: LatLonPoint, b: LatLonPoint): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: LatLonPoint[] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: LatLonPoint[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function getRoundedHull(
  points: LatLonPoint[],
  padding = 0.00018,
  steps = 8
): LatLonPoint[] {
  const hull = getConvexHull(points);
  const cosLat = 0.675; // ~cos(47.5°) Budapest szélességi körén

  const toXY = (p: LatLonPoint): [number, number] => [p[1] * cosLat, p[0]];
  const toLatLon = (xy: [number, number]): LatLonPoint => [
    xy[1],
    xy[0] / cosLat,
  ];

  const xyHull = hull.map(toXY);
  const n = xyHull.length;

  if (n === 1) {
    const [cx, cy] = xyHull[0];
    const poly: LatLonPoint[] = [];
    for (let i = 0; i < 16; i++) {
      const a = (i * 2 * Math.PI) / 16;
      poly.push(toLatLon([cx + Math.cos(a) * padding, cy + Math.sin(a) * padding]));
    }
    return poly;
  }

  if (n === 2) {
    const [p1, p2] = xyHull;
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) {
      return getRoundedHull([hull[0]], padding, steps);
    }
    const baseAngle = Math.atan2(dy, dx);
    const poly: LatLonPoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const a = baseAngle - Math.PI / 2 + (i * Math.PI) / steps;
      poly.push(
        toLatLon([p2[0] + Math.cos(a) * padding, p2[1] + Math.sin(a) * padding])
      );
    }
    for (let i = 0; i <= steps; i++) {
      const a = baseAngle + Math.PI / 2 + (i * Math.PI) / steps;
      poly.push(
        toLatLon([p1[0] + Math.cos(a) * padding, p1[1] + Math.sin(a) * padding])
      );
    }
    return poly;
  }

  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += xyHull[i][0] * xyHull[j][1] - xyHull[j][0] * xyHull[i][1];
  }
  if (area < 0) xyHull.reverse();

  const poly: LatLonPoint[] = [];
  for (let i = 0; i < n; i++) {
    const pPrev = xyHull[(i - 1 + n) % n];
    const pCurr = xyHull[i];
    const pNext = xyHull[(i + 1) % n];

    const v1x = pCurr[0] - pPrev[0];
    const v1y = pCurr[1] - pPrev[1];
    const v2x = pNext[0] - pCurr[0];
    const v2y = pNext[1] - pCurr[1];

    const a1 = Math.atan2(-v1x, v1y);
    let a2 = Math.atan2(-v2x, v2y);
    while (a2 < a1) a2 += 2 * Math.PI;

    for (let s = 0; s <= steps; s++) {
      const a = a1 + ((a2 - a1) * s) / steps;
      poly.push(
        toLatLon([
          pCurr[0] + Math.cos(a) * padding,
          pCurr[1] + Math.sin(a) * padding,
        ])
      );
    }
  }
  return poly;
}
