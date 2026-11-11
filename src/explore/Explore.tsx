import { useEffect, useRef, useState } from "react";
import { saleKindName } from "../components/SaleTeasers";
import { money } from "../lib/format";
import { listingUrl } from "../links";

/**
 * The look-around view: Google's photorealistic 3D mesh, opened on exactly the camera the
 * story is showing, free to scroll-zoom and drag, and handed back to the story on exit.
 * Needs VITE_GOOGLE_MAPS_KEY (Maps JavaScript API). Without it nothing here is reachable.
 */

export type ViewCamera = {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  /** Ground height at the centre, metres, so Google orbits the same point. */
  altitude: number;
  /** The map's own centre height, metres (terrain units): 0 for the story, the ground under a focused sale. */
  elevation?: number;
};

type GoogleCamera = { center: { lat: number; lng: number; altitude: number }; range: number; tilt: number; heading: number };

declare global {
  interface Window {
    google?: { maps: { importLibrary: (name: string) => Promise<Record<string, unknown>> } };
    __gmapsReady?: () => void;
  }
}

const KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;
export const exploreAvailable = Boolean(KEY);

/**
 * Google's range (camera to centre, metres) that shows the same ground as MapLibre's view.
 * MapLibre's camera sits 1.5 viewport heights from the centre (36.87° vertical field of view);
 * Google's field of view is wider. 0.8 viewport heights matched the frame when the two were
 * toggled over each other at the dive's landing camera (tilt 60-64) over Glendale and over the
 * county-wide commute view: freeways, parks and ridge lines in the same screen positions.
 */
const CAMERA_HEIGHTS = 0.8;
const EQUATOR_METERS_PER_PIXEL = 156543.03392;

function metersPerPixel(lat: number, zoom: number): number {
  return (EQUATOR_METERS_PER_PIXEL * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

export function toGoogle(camera: ViewCamera, heightPx: number): GoogleCamera {
  return {
    center: { lat: camera.center[1], lng: camera.center[0], altitude: camera.altitude },
    range: CAMERA_HEIGHTS * heightPx * metersPerPixel(camera.center[1], camera.zoom),
    tilt: camera.pitch,
    heading: camera.bearing,
  };
}

export function fromGoogle(google: GoogleCamera, heightPx: number): ViewCamera {
  const mpp = google.range / (CAMERA_HEIGHTS * heightPx);
  const zoom = Math.log2((EQUATOR_METERS_PER_PIXEL * Math.cos((google.center.lat * Math.PI) / 180)) / mpp);
  return { center: [google.center.lng, google.center.lat], zoom, pitch: google.tilt, bearing: google.heading, altitude: google.center.altitude };
}

let loading: Promise<Record<string, unknown>> | null = null;

function loadMaps3d(): Promise<Record<string, unknown>> {
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const params = new URLSearchParams({ key: KEY ?? "", v: "weekly", libraries: "maps3d", loading: "async", callback: "__gmapsReady" });
      window.__gmapsReady = () => {
        if (!window.google) return reject(new Error("Google Maps did not initialise"));
        resolve(window.google.maps.importLibrary("maps3d"));
      };
      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
      script.async = true;
      script.onerror = () => reject(new Error("Google Maps failed to load"));
      document.head.append(script);
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** Fetch the Google script while the story plays, so entering look-around only waits for tiles. */
export function preloadMaps3d(): void {
  if (KEY) loadMaps3d().catch(() => undefined);
}

type Map3D = HTMLElement & GoogleCamera;

/**
 * A home to pin on the mesh. Today every pin is a closed sale; `status` is here so active listings
 * can ride the same way (a different colour and card line) once a feed of them exists.
 */
export type Sale3D = {
  id: number;
  lon: number;
  lat: number;
  price: number;
  listing: string;
  address: string;
  beds: number;
  sqft: number;
  kind: number;
  /** "Apr 2026": the month it closed (sold) or was listed (for sale). */
  when: string;
  status: "sold" | "for sale";
};

type Marker3D = HTMLElement & { position: { lat: number; lng: number; altitude: number } };

/** How many pins ride on the mesh at once: the nearest to wherever the camera is looking. */
const PIN_LIMIT = 160;
/**
 * Google's vertical field of view. Fitted against where it drew sixteen pins over Glendale at a
 * 1.5 km range and 60° tilt: with this value and the terrain heights, the pinhole model below lands
 * within 6 px of every pin.
 */
const FOV_DEG = 35;
/** A pin's anchor sits on the mesh, a few metres above the terrain model's ground. */
const PIN_LIFT = 5;
/** The pin's head sits this far above its anchor (css px); a pointer this close to the head is on it. */
const PIN_HEAD = 16;
const PIN_RADIUS = 20;
const PIN_COLOURS: Record<Sale3D["status"], string> = { sold: "#dcf763", "for sale": "#fb923c" };

function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lon: number }): number {
  const dx = (b.lon - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  const dy = (b.lat - a.lat) * 110540;
  return Math.hypot(dx, dy);
}

/**
 * Screen position of a world point under Google's camera, which is a pinhole `range` metres behind
 * the centre, tilted off the nadir by `tilt` and turned to `heading`. Google draws its markers in
 * WebGL and reports nothing about where, so this is how a pointer finds a pin.
 */
function projector(cam: GoogleCamera, width: number, height: number): (lon: number, lat: number, alt: number) => { x: number; y: number } | null {
  const t = (cam.tilt * Math.PI) / 180;
  const h = (cam.heading * Math.PI) / 180;
  // The view direction, the camera's place, and its right and up axes, in metres east/north/up of the centre.
  const f = [Math.sin(h) * Math.sin(t), Math.cos(h) * Math.sin(t), -Math.cos(t)];
  const P = [-cam.range * f[0], -cam.range * f[1], cam.center.altitude - cam.range * f[2]];
  const r = [Math.cos(h), -Math.sin(h), 0];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const k = height / 2 / Math.tan(((FOV_DEG / 2) * Math.PI) / 180);
  const mlat = 110540;
  const mlon = 111320 * Math.cos((cam.center.lat * Math.PI) / 180);
  return (lon, lat, alt) => {
    const v = [(lon - cam.center.lng) * mlon - P[0], (lat - cam.center.lat) * mlat - P[1], alt - P[2]];
    const depth = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
    if (depth < 1) return null;
    return {
      x: width / 2 + ((v[0] * r[0] + v[1] * r[1] + v[2] * r[2]) / depth) * k,
      y: height / 2 - ((v[0] * u[0] + v[1] * u[1] + v[2] * u[2]) / depth) * k,
    };
  };
}

function el(className: string, text: string): HTMLElement {
  const node = document.createElement("div");
  node.className = className;
  node.textContent = text;
  return node;
}

/** The card over a pin: status and month, price, address, the facts, and the listing when there is one. */
function fillCard(card: HTMLElement, sale: Sale3D): void {
  card.replaceChildren();
  card.append(el(`sale-tip-status is-${sale.status === "sold" ? "sold" : "sale"}`, sale.status === "sold" ? `Sold · ${sale.when}` : `For sale · ${sale.when}`));
  card.append(el("sale-tip-price", money(sale.price)));
  if (sale.address) card.append(el("sale-tip-address", sale.address));
  const facts = [sale.beds > 0 ? `${sale.beds} bd` : "", sale.sqft > 0 ? `${sale.sqft.toLocaleString()} sqft` : "", saleKindName(sale.kind)].filter(Boolean);
  card.append(el("sale-tip-meta", facts.join(" · ")));
  if (sale.listing) {
    const link = document.createElement("a");
    link.className = "sale-tip-hint";
    link.href = listingUrl(sale.listing);
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Open the listing on Snaphomz ↗";
    card.append(link);
  }
}

type PinLayer = { destroy(): void };

/**
 * The homes as pins on Google's mesh, each labelled with its price, with a card that follows the
 * pointer onto a pin. Google's 3D markers only report clicks, so the hover is ours: every frame the
 * pins are projected through the camera model above and the pointer is matched to the nearest head.
 * A click on a pin opens its listing; a tap (no hover) pins the card, whose link opens the listing.
 * Only the nearest PIN_LIMIT to the camera's centre are on the map, refreshed whenever the camera
 * comes to rest somewhere else.
 */
async function pinSales(
  map3d: Map3D,
  lib: Record<string, unknown>,
  sales: Sale3D[],
  groundAt: (lon: number, lat: number) => number | null,
  host: HTMLElement,
  card: HTMLElement,
  alive: () => boolean,
): Promise<PinLayer | null> {
  if (sales.length === 0 || !window.google) return null;
  const Marker = lib.Marker3DElement as new (options: Record<string, unknown>) => Marker3D;
  const AltitudeMode = lib.AltitudeMode as Record<string, string>;
  const markerLib = await window.google.maps.importLibrary("marker");
  const PinElement = markerLib.PinElement as new (options: Record<string, unknown>) => HTMLElement;
  if (!alive()) return null;
  const onMesh = AltitudeMode.RELATIVE_TO_MESH ?? AltitudeMode.CLAMP_TO_GROUND;

  const shown = new Map<number, { marker: Marker3D; sale: Sale3D; alt: number }>();
  let lastCentre: { lat: number; lng: number } | null = null;
  const refresh = () => {
    const centre = map3d.center;
    if (!alive() || !centre) return;
    if (lastCentre && metresBetween(lastCentre, { lat: centre.lat, lon: centre.lng }) < 150 && shown.size > 0) return;
    lastCentre = { lat: centre.lat, lng: centre.lng };
    const nearest = sales
      .map((sale) => ({ sale, d: metresBetween(centre, sale) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, PIN_LIMIT);
    const keep = new Set(nearest.map((n) => n.sale.id));
    for (const [id, entry] of shown) {
      if (!keep.has(id)) {
        entry.marker.remove();
        shown.delete(id);
      }
    }
    for (const { sale } of nearest) {
      if (shown.has(sale.id)) continue;
      const marker = new Marker({ position: { lat: sale.lat, lng: sale.lon, altitude: 0 }, altitudeMode: onMesh, label: money(sale.price), extruded: false });
      marker.append(new PinElement({ background: PIN_COLOURS[sale.status], borderColor: "#111827", glyphColor: "#111827", scale: 0.85 }));
      map3d.append(marker);
      shown.set(sale.id, { marker, sale, alt: (groundAt(sale.lon, sale.lat) ?? centre.altitude) + PIN_LIFT });
    }
  };
  refresh();
  const onSteady = (event: Event) => {
    if ((event as Event & { isSteady?: boolean }).isSteady) refresh();
  };
  map3d.addEventListener("gmp-steadychange", onSteady);

  // The hover: the pointer's place, the pin under it, and (after a tap) the pin whose card stays.
  let pointer: { x: number; y: number } | null = null;
  let hover: Sale3D | null = null;
  let pinned: Sale3D | null = null;
  let down: { x: number; y: number; touch: boolean } | null = null;
  let frame = 0;
  const show = (sale: Sale3D | null, keep: boolean) => {
    const was = pinned ?? hover;
    if (keep) pinned = sale;
    else hover = sale;
    const now = pinned ?? hover;
    if (now !== was) {
      if (now) fillCard(card, now);
      card.classList.toggle("show", now !== null);
    }
    card.classList.toggle("pinned", pinned !== null);
    host.style.cursor = hover ? "pointer" : "";
  };
  const tick = () => {
    if (!alive()) return;
    frame = requestAnimationFrame(tick);
    const centre = map3d.center;
    if (!centre || shown.size === 0) return;
    const width = host.clientWidth;
    const height = host.clientHeight;
    const project = projector({ center: centre, range: map3d.range, tilt: map3d.tilt, heading: map3d.heading }, width, height);
    // Which pin is under the pointer (none while the pointer drags the map).
    if (pointer && !down) {
      let best: Sale3D | null = null;
      let bestGap = PIN_RADIUS;
      for (const entry of shown.values()) {
        const at = project(entry.sale.lon, entry.sale.lat, entry.alt);
        if (!at) continue;
        const gap = Math.hypot(at.x - pointer.x, at.y - PIN_HEAD - pointer.y);
        if (gap < bestGap) {
          bestGap = gap;
          best = entry.sale;
        }
      }
      if (best !== hover) show(best, false);
    } else if (hover && down) {
      show(null, false);
    }
    // The card rides on its pin.
    const sale = pinned ?? hover;
    if (sale) {
      const entry = shown.get(sale.id);
      const at = entry ? project(sale.lon, sale.lat, entry.alt) : null;
      if (!at || at.x < -40 || at.x > width + 40 || at.y < -40 || at.y > height + 40) {
        show(null, pinned !== null);
      } else {
        card.style.transform = `translate(${at.x.toFixed(1)}px, ${(at.y - PIN_HEAD - 18).toFixed(1)}px) translate(-50%, -100%)`;
      }
    }
  };
  frame = requestAnimationFrame(tick);

  const onMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    pointer = { x: event.clientX, y: event.clientY };
  };
  const onLeave = (event?: PointerEvent) => {
    pointer = null;
    // Leaving the map for the card is not leaving the pin.
    if (event?.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return;
    if (hover) show(null, false);
  };
  const onCardLeave = (event: PointerEvent) => {
    if (event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) return;
    if (hover) show(null, false);
  };
  const onCardClick = (event: MouseEvent) => {
    const sale = pinned ?? hover;
    if (!sale?.listing) return;
    event.preventDefault();
    window.open(listingUrl(sale.listing), "_blank", "noopener");
  };
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    down = { x: event.clientX, y: event.clientY, touch: event.pointerType === "touch" };
  };
  const onUp = (event: PointerEvent) => {
    if (!down) return;
    const tap = Math.hypot(event.clientX - down.x, event.clientY - down.y) < 6;
    const touch = down.touch;
    down = null;
    if (!tap) return;
    if (touch) {
      // No hover on a touch screen: a tap on a pin pins its card; a tap elsewhere lets it go.
      pointer = { x: event.clientX, y: event.clientY };
      const width = host.clientWidth;
      const height = host.clientHeight;
      const centre = map3d.center;
      if (!centre) return;
      const project = projector({ center: centre, range: map3d.range, tilt: map3d.tilt, heading: map3d.heading }, width, height);
      let best: Sale3D | null = null;
      let bestGap = PIN_RADIUS * 1.4;
      for (const entry of shown.values()) {
        const at = project(entry.sale.lon, entry.sale.lat, entry.alt);
        if (!at) continue;
        const gap = Math.hypot(at.x - pointer.x, at.y - PIN_HEAD - pointer.y);
        if (gap < bestGap) {
          bestGap = gap;
          best = entry.sale;
        }
      }
      pointer = null;
      show(best, true);
    } else if (hover?.listing) {
      window.open(listingUrl(hover.listing), "_blank", "noopener");
    }
  };
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerleave", onLeave);
  host.addEventListener("pointerdown", onDown);
  host.addEventListener("pointerup", onUp);
  host.addEventListener("pointercancel", onLeave);
  card.addEventListener("pointerleave", onCardLeave);
  card.addEventListener("click", onCardClick);

  return {
    destroy() {
      cancelAnimationFrame(frame);
      map3d.removeEventListener("gmp-steadychange", onSteady);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("pointercancel", onLeave);
      card.removeEventListener("pointerleave", onCardLeave);
      card.removeEventListener("click", onCardClick);
      host.style.cursor = "";
    },
  };
}

/**
 * `getCamera` is read twice: when Google is created, and again the moment its mesh is ready, so the
 * story view can keep drifting underneath while tiles load and the crossfade still lines up.
 */
export function Explore({
  getCamera,
  closing,
  minWait = 0,
  onExit,
  sales = [],
  groundAt = () => null,
}: {
  getCamera: () => ViewCamera;
  closing: boolean;
  minWait?: number;
  onExit: (camera: ViewCamera) => void;
  sales?: Sale3D[];
  /** Terrain height under a point (metres, unexaggerated), for placing the hover against Google's pins. */
  groundAt?: (lon: number, lat: number) => number | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map3D | null>(null);
  const layer = useRef<PinLayer | null>(null);
  const opened = useRef<ViewCamera>(getCamera());
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let alive = true;
    const mountedAt = performance.now();
    const height = window.innerHeight;
    loadMaps3d()
      .then((lib) => {
        if (!alive || !host.current) return;
        const Map3DElement = lib.Map3DElement as new (options: Record<string, unknown>) => Map3D;
        const MapMode = lib.MapMode as Record<string, string>;
        const map3d = new Map3DElement({ ...toGoogle(opened.current, height), mode: MapMode.HYBRID, defaultUIDisabled: true, gestureHandling: "GREEDY" });
        mapRef.current = map3d;
        host.current.append(map3d);
        pinSales(map3d, lib, sales, groundAt, host.current, card.current!, () => alive)
          .then((pins) => {
            if (!alive) pins?.destroy();
            else layer.current = pins;
          })
          .catch(() => undefined);
        let shown = false;
        const show = () => {
          if (shown || !alive) return;
          shown = true;
          // Let the story's own move (the dive) finish, catch up with where the camera ended, give the
          // mesh a beat to settle on it, then crossfade.
          const wait = Math.max(0, mountedAt + minWait - performance.now());
          setTimeout(() => {
            if (!alive) return;
            const now = toGoogle(getCamera(), height);
            map3d.center = now.center;
            map3d.range = now.range;
            map3d.tilt = now.tilt;
            map3d.heading = now.heading;
            setTimeout(() => alive && setState("ready"), 350);
          }, wait);
        };
        map3d.addEventListener("gmp-steadychange", (event) => {
          if ((event as Event & { isSteady?: boolean }).isSteady) show();
        });
        // A slow network still gets the view after a few seconds.
        setTimeout(show, 4500);
      })
      .catch(() => {
        if (alive) setState("failed");
      });
    document.documentElement.classList.add("exploring");
    return () => {
      alive = false;
      layer.current?.destroy();
      document.documentElement.classList.remove("exploring");
    };
    // Opened once per entry; the camera is the one it opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exit = () => {
    const map3d = mapRef.current;
    if (map3d && map3d.center && state === "ready") {
      onExit(fromGoogle({ center: map3d.center, range: map3d.range, tilt: map3d.tilt, heading: map3d.heading }, window.innerHeight));
    } else {
      onExit(opened.current);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className={`explore ${state === "ready" ? "show" : ""} ${closing ? "closing" : ""}`}>
      <div className="explore-veil" />
      <div ref={host} className="explore-map" />
      <div ref={card} className="sale-tip pin-tip" role="tooltip" />
      <div className="explore-loading" aria-live="polite">
        <div className="explore-loading-label">{state === "failed" ? "Google 3D could not load here" : "Opening Google 3D"}</div>
        {state === "loading" && <div className="explore-loading-bar" />}
      </div>
      <button className="explore-exit" onClick={exit}>
        Back to the story
      </button>
      <div className="explore-hint">
        {sales.length > 0 ? (
          <>
            <span className="explore-hint-pin" aria-hidden="true" /> sold · <span className="explore-hint-pin is-sale" aria-hidden="true" /> for sale, hover a pin · scroll to zoom · drag to look around · esc to return
          </>
        ) : (
          "scroll to zoom · drag to look around · esc to return"
        )}
      </div>
    </div>
  );
}
