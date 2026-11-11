/**
 * Lot lines on Google's mesh, one lot at a time: the LA County Assessor's parcel polygons (the 2025
 * roll, from the County's public ArcGIS feature service). The parcels around the camera are fetched
 * whenever it comes to rest close enough for a lot to be more than a few pixels (PARCEL_RANGE_MAX)
 * and kept in memory as you pan, but nothing is drawn until a lot is pointed at: then its outline
 * goes on as lines a metre and a half above the mesh, so they drape over the roof and garden, and
 * comes off again when the pointer moves on. Drawing every lot at once read as white streaks all
 * over the view. The lots under the pinned homes are fetched by themselves (one multipoint query),
 * since a home can sit well outside the area around the camera's centre, and a home geocoded a few
 * metres off its lot still finds the nearest one.
 */

import { watchStill } from "./still";

type Map3D = HTMLElement & { center: { lat: number; lng: number; altitude: number } | null; range: number; tilt: number; heading: number };
type Polyline = HTMLElement & { strokeColor: string; strokeWidth: number };
/** [lon, lat] vertices; the first ring of a polygon is its outline, the rest are holes. */
type Ring = number[][];
type Parcel = { ain: string; polygons: Ring[][]; lon: number; lat: number };

export type ParcelLayer = {
  /**
   * Outline the lot under a point in a colour, or none. With `near`, a point on no lot (a home
   * geocoded onto the street) takes the lot whose edge is within that many metres.
   */
  highlight(at: { lon: number; lat: number } | null, colour?: string, near?: number): void;
  /** Make sure the lots under these points are in memory, whatever the camera is doing. */
  ensure(points: { lon: number; lat: number }[]): void;
  destroy(): void;
};

const SERVICE = "https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/ASSR_PARCELS_25_View/FeatureServer/0/query";
export const PARCEL_CREDIT = "Hover a lot for its lines · LA County Assessor";
/** Camera distance (metres) beyond which lots are not fetched or drawn. */
export const PARCEL_RANGE_MAX = 1600;
/** How far around the camera's centre parcels are fetched, metres: about what the view covers. */
const REACH_MIN = 250;
const REACH_MAX = 900;
/** Parcels kept in memory at once; past KEEP the farthest from the camera go until TRIM_TO remain. */
const KEEP = 2400;
const TRIM_TO = 1800;
const LIFT = 1.5;
const LINE_WIDTH = 3;
/** A pinned home geocoded onto the street still gets the lot whose edge is within this many metres. */
const PIN_REACH = 25;

function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dx = (b.lng - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  const dy = (b.lat - a.lat) * 110540;
  return Math.hypot(dx, dy);
}

function inRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function contains(parcel: Parcel, lon: number, lat: number): boolean {
  return parcel.polygons.some((rings) => inRing(rings[0], lon, lat) && !rings.slice(1).some((hole) => inRing(hole, lon, lat)));
}

/** Metres from a point to the nearest edge of a parcel's outline. */
function edgeDistance(parcel: Parcel, lon: number, lat: number): number {
  const mlon = 111320 * Math.cos((lat * Math.PI) / 180);
  const mlat = 110540;
  let best = Infinity;
  for (const rings of parcel.polygons) {
    const ring = rings[0];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = (ring[j][0] - lon) * mlon;
      const ay = (ring[j][1] - lat) * mlat;
      const bx = (ring[i][0] - lon) * mlon;
      const by = (ring[i][1] - lat) * mlat;
      const dx = bx - ax;
      const dy = by - ay;
      const len = dx * dx + dy * dy;
      const t = len === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len));
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

type Feature = { properties?: { AIN?: string }; geometry?: { type: string; coordinates: unknown } };

export function parcelLines(map3d: Map3D, lib: Record<string, unknown>, alive: () => boolean, onCount: (count: number) => void): ParcelLayer {
  const Polyline3D = lib.Polyline3DElement as new (options: Record<string, unknown>) => Polyline;
  const AltitudeMode = lib.AltitudeMode as Record<string, string>;
  const have = new Map<string, Parcel>();
  let fetched: { lat: number; lng: number; reach: number } | null = null;
  let controller: AbortController | null = null;
  let lit: { parcel: Parcel; colour: string; lines: Polyline[] } | null = null;
  /** The lots under the pinned homes: never trimmed, whatever the camera does. */
  let pinned = new Set<string>();

  /** The lot containing a point, or with `near` the lot whose edge is within that many metres. */
  const lotAt = (lon: number, lat: number, near = 0): Parcel | null => {
    let found = [...have.values()].find((parcel) => contains(parcel, lon, lat)) ?? null;
    if (!found && near > 0) {
      let gap = near;
      for (const parcel of have.values()) {
        const d = edgeDistance(parcel, lon, lat);
        if (d < gap) {
          gap = d;
          found = parcel;
        }
      }
    }
    return found;
  };

  const unlight = () => {
    if (!lit) return;
    for (const line of lit.lines) line.remove();
    lit = null;
  };
  const clear = () => {
    controller?.abort();
    controller = null;
    unlight();
    have.clear();
    fetched = null;
    onCount(0);
  };
  const trim = (centre: { lat: number; lng: number }) => {
    if (have.size <= KEEP) return;
    const far = [...have.values()].filter((parcel) => !pinned.has(parcel.ain)).sort((a, b) => metres(centre, { lat: b.lat, lng: b.lon }) - metres(centre, { lat: a.lat, lng: a.lon }));
    for (const parcel of far.slice(0, have.size - TRIM_TO)) {
      if (lit?.parcel === parcel) unlight();
      have.delete(parcel.ain);
    }
  };
  const add = (feature: Feature) => {
    const ain = feature.properties?.AIN;
    const geometry = feature.geometry;
    if (!ain || !geometry || have.has(ain)) return;
    const polygons = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : []) as Ring[][];
    if (polygons.length === 0 || polygons[0].length === 0 || polygons[0][0].length === 0) return;
    const [lon, lat] = polygons[0][0][0];
    have.set(ain, { ain, polygons, lon, lat });
  };
  /** The parcels intersecting a geometry, or null when the request was aborted or failed. */
  const query = async (geometry: string, geometryType: string, signal?: AbortSignal, extra: Record<string, string> = {}): Promise<Feature[] | null> => {
    const params = new URLSearchParams({
      ...extra,
      f: "geojson",
      geometry,
      geometryType,
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "AIN",
      outSR: "4326",
      geometryPrecision: "6",
      returnGeometry: "true",
    });
    try {
      const response = await fetch(SERVICE, { method: "POST", body: params, signal });
      if (!response.ok) return null;
      return ((await response.json()) as { features?: Feature[] }).features ?? [];
    } catch {
      return null; // aborted by a newer request, or the service is unreachable: the lines are a bonus
    }
  };
  const load = async (centre: { lat: number; lng: number }, reach: number) => {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    const dLat = reach / 110540;
    const dLon = reach / (111320 * Math.cos((centre.lat * Math.PI) / 180));
    const envelope = [centre.lng - dLon, centre.lat - dLat, centre.lng + dLon, centre.lat + dLat].map((v) => v.toFixed(6)).join(",");
    const features = await query(envelope, "esriGeometryEnvelope", signal);
    if (!features || !alive() || signal.aborted) return;
    for (const feature of features) add(feature);
    trim(centre);
    onCount(have.size);
  };
  let pinFetch: Promise<void> | null = null;
  const ensure = async (points: { lon: number; lat: number }[]) => {
    const missing = points.filter((at) => !lotAt(at.lon, at.lat, PIN_REACH));
    if (missing.length > 0) {
      // Within PIN_REACH, so a home geocoded onto the street still brings its lot along.
      const multipoint = JSON.stringify({ points: missing.map((at) => [Number(at.lon.toFixed(6)), Number(at.lat.toFixed(6))]), spatialReference: { wkid: 4326 } });
      const features = await query(multipoint, "esriGeometryMultipoint", undefined, { distance: String(PIN_REACH), units: "esriSRUnit_Meter" });
      if (!features || !alive()) return;
      for (const feature of features) add(feature);
    }
    pinned = new Set(points.map((at) => lotAt(at.lon, at.lat, PIN_REACH)?.ain).filter((ain): ain is string => Boolean(ain)));
    onCount(have.size);
  };
  const refresh = () => {
    const centre = map3d.center;
    if (!alive() || !centre) return;
    if (map3d.range > PARCEL_RANGE_MAX) {
      // Too far out for lots under the pointer; the pinned homes' lots stay for the chip hover.
      controller?.abort();
      controller = null;
      fetched = null;
      return;
    }
    const reach = Math.min(REACH_MAX, Math.max(REACH_MIN, map3d.range * 1.1));
    // Still inside the last fetch, at a similar scale: nothing new to ask for.
    if (fetched && metres(fetched, centre) < fetched.reach * 0.45 && reach <= fetched.reach * 1.3) return;
    fetched = { lat: centre.lat, lng: centre.lng, reach };
    void load(centre, reach);
  };
  const onSteady = (event: Event) => {
    if ((event as Event & { isSteady?: boolean }).isSteady) refresh();
  };
  map3d.addEventListener("gmp-steadychange", onSteady);
  const stopWatching = watchStill(map3d, alive, refresh);
  refresh();

  return {
    highlight(at, colour = "#ffffff", near = 0) {
      const next = at ? lotAt(at.lon, at.lat, near) : null;
      if (next === (lit?.parcel ?? null) && (!next || colour === lit?.colour)) return;
      unlight();
      if (!next) return;
      const lines: Polyline[] = [];
      for (const rings of next.polygons) {
        for (const ring of rings) {
          const line = new Polyline3D({
            path: ring.map(([x, y]) => ({ lat: y, lng: x, altitude: LIFT })),
            strokeColor: colour,
            strokeWidth: LINE_WIDTH,
            outerColor: "#00000080",
            outerWidth: 0.3,
            altitudeMode: AltitudeMode.RELATIVE_TO_MESH,
            drawsOccludedSegments: false,
          });
          map3d.append(line);
          lines.push(line);
        }
      }
      lit = { parcel: next, colour, lines };
    },
    ensure(points) {
      // One at a time: a second refresh waits for the first, so nothing is asked for twice.
      pinFetch = (pinFetch ?? Promise.resolve()).then(() => ensure(points));
    },
    destroy() {
      stopWatching();
      map3d.removeEventListener("gmp-steadychange", onSteady);
      clear();
    },
  };
}
