import type { FeatureCollection } from "../types";

type Ring = Array<[number, number]>;
type Feature = FeatureCollection["features"][number];

function rings(feature: Feature): Ring[] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  if (geometry.type === "Polygon") return (geometry.coordinates as Ring[]).slice(0, 1);
  if (geometry.type === "MultiPolygon") return (geometry.coordinates as Ring[][]).map((polygon) => polygon[0]);
  return [];
}

/** Planar shoelace area in square degrees, enough to rank polygons. */
function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(sum / 2);
}

export function featureArea(feature: Feature): number {
  return rings(feature).reduce((total, ring) => total + ringArea(ring), 0);
}

/** A point inside-ish the feature's largest ring: the vertex average, which is fine for labels. */
export function featureAnchor(feature: Feature): [number, number] | null {
  const outer = rings(feature).sort((a, b) => ringArea(b) - ringArea(a))[0];
  if (!outer || outer.length === 0) return null;
  let lon = 0;
  let lat = 0;
  for (const point of outer) {
    lon += point[0];
    lat += point[1];
  }
  return [lon / outer.length, lat / outer.length];
}

export function largestFeature(collection: FeatureCollection | null | undefined, accept: (feature: Feature) => boolean = () => true): Feature | null {
  if (!collection) return null;
  let best: Feature | null = null;
  let bestArea = 0;
  for (const feature of collection.features) {
    if (!accept(feature)) continue;
    const area = featureArea(feature);
    if (area > bestArea) {
      best = feature;
      bestArea = area;
    }
  }
  return best;
}

export function meanPoint(points: Array<{ lon: number; lat: number }>): [number, number] | null {
  if (points.length === 0) return null;
  let lon = 0;
  let lat = 0;
  for (const point of points) {
    lon += point.lon;
    lat += point.lat;
  }
  return [lon / points.length, lat / points.length];
}

export function distanceM(a: [number, number], b: [number, number]): number {
  const radius = 6_371_000;
  const phi1 = (a[1] * Math.PI) / 180;
  const phi2 = (b[1] * Math.PI) / 180;
  const dPhi = ((b[1] - a[1]) * Math.PI) / 180;
  const dLambda = ((b[0] - a[0]) * Math.PI) / 180;
  const h = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

/** Zoom at which `widthDegrees` of longitude fills `fraction` of a viewport `widthPx` wide. */
export function zoomToFit(widthDegrees: number, widthPx: number, fraction = 0.85): number {
  const worldPx = (360 * widthPx * fraction) / Math.max(widthDegrees, 1e-6);
  return Math.log2(worldPx / 512);
}
