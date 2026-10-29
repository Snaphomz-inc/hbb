import type maplibregl from "maplibre-gl";
import { LngLat } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { Labels } from "./components/Labels";
import { Neighbors } from "./components/Neighbors";
import { Explore, exploreAvailable, preloadMaps3d, type ViewCamera } from "./explore/Explore";
import { Overview } from "./Overview";
import { distanceM, zoomToFit } from "./lib/geo";
import { money } from "./lib/format";
import { useScramble } from "./lib/scramble";
import { MapScene, PULSE, mapAlive, saleTime, salesOn, screenPoint, setRouteProgress, setSalesClock, showLayers } from "./map/MapScene";
import { SaleTeasers, saleKindName, type Teaser, type TeaserSpots } from "./components/SaleTeasers";
import { buildChapters, type Chapter } from "./story/chapters";
import { useScrollStory } from "./story/useScrollStory";
import type { IndexEntry, Neighborhood } from "./types";
import { build, city } from "./city";
import { homesUrl, listingUrl } from "./links";
// The brand wordmark (design team's Logo.svg, fills set to currentColor so it takes the header's colour).
import logoSvg from "./assets/logo.svg?raw";

const DATA_BASE = `${import.meta.env.BASE_URL}data`;

/**
 * The way into look-around: while Google loads, the story camera dives, halving its distance,
 * tilting toward the horizon and wheeling a little, and Google's mesh fades in where it lands.
 * The mirror of the way out, where the camera glides from Google's view back to the chapter.
 */
export const DIVE_MS = 3200;
export const DIVE_ZOOM = 1.0;
export const DIVE_PITCH = 60;
export const DIVE_BEARING = 14;

/** How long the page is left alone before the camera drift eases to rest. */
const IDLE_MS = 8000;

/** Names for the chapter marks along the bottom; a chapter missing here goes by its id. */
const CHAPTER_NAMES: Record<string, string> = {
  hero: "Start",
  homes: "Homes",
  trend: "Prices",
  places: "Places",
  commute: "Commute",
  schools: "Schools",
  risks: "Risks",
  permits: "Building",
  closing: "Next",
};

function chapterName(chapter: Chapter): string {
  return CHAPTER_NAMES[chapter.id] ?? chapter.id[0].toUpperCase() + chapter.id.slice(1);
}

/** The camera a hop to a neighbour leaves behind, for the next neighborhood to glide in from. */
let arrival: ViewCamera | null = null;

function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

const LEGEND: Record<string, Array<{ swatch: string; label: string }>> = {
  sales: [
    { swatch: "dot #7dd3fc", label: "Lower-priced third" },
    { swatch: "dot #DCF763", label: "Middle third" },
    { swatch: "dot #fb7185", label: "Top third" },
  ],
  "sales-heat": [{ swatch: "heat", label: "Dollar volume of sales, last 12 months: warmer is more" }],
  routes: [
    { swatch: "solid #DCF763", label: "Drive, no traffic" },
    { swatch: "dot #DCF763", label: "Here" },
  ],
  parks: [{ swatch: "fill #34d399", label: "Parks and beaches" }],
  walk: [{ swatch: "fill #DCF763", label: "More walkable blocks" }],
  "pois-grocery": [{ swatch: "dot #DCF763", label: "Grocery" }],
  "pois-rail": [{ swatch: "dot #60a5fa", label: "Rail station" }],
  "pois-cafe": [{ swatch: "dot #ffffff", label: "Cafés and restaurants" }],
  schools: [
    { swatch: "dot #DCF763", label: "Elementary" },
    { swatch: "dot #fbbf24", label: "Middle" },
    { swatch: "dot #fb7185", label: "High" },
  ],
  zones: [{ swatch: "line #ffffff", label: "Attendance zones" }],
  flood: [{ swatch: "fill #3b82f6", label: "FEMA flood zone" }],
  fire: [{ swatch: "fill #f97316", label: "Fire hazard severity" }],
  liquefaction: [{ swatch: "fill #a855f7", label: "Liquefaction" }],
  landslide: [{ swatch: "fill #b45309", label: "Landslide" }],
  fault: [{ swatch: "fill #ef4444", label: "Fault zone" }],
  noise: [{ swatch: "fill #f97316", label: "Noise 55 to 75 dB" }],
  permits: [
    { swatch: "dot #DCF763", label: "New homes" },
    { swatch: "dot #ffffff", label: "Additions" },
    { swatch: "dot #60a5fa", label: "Pools" },
    { swatch: "dot #fbbf24", label: "Solar" },
    { swatch: "dot #9ca3af", label: "Other" },
  ],
};

/** "" is the county overview; anything else is a neighborhood slug. */
function slugFromHash(): string {
  return window.location.hash.replace(/^#\/?/, "");
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let delta = ((b - a + 540) % 360) - 180;
  return a + delta * t;
}

function Swatch({ spec }: { spec: string }) {
  const [kind, color] = spec.split(" ");
  if (kind === "heat") return <span className="swatch swatch-heat" />;
  return <span className={`swatch swatch-${kind}`} style={{ background: color, borderColor: color }} />;
}

/** The year of sales as a ticker: the month landing now, its count and median, and a bar per month lit as it arrives. */
function Timeline({ buckets, tick }: { buckets: Array<{ label: string; count: number; median: number }>; tick: number }) {
  const at = tick < 0 ? buckets.length - 1 : Math.min(buckets.length - 1, tick);
  const bucket = buckets[at];
  const most = Math.max(1, ...buckets.map((b) => b.count));
  if (!bucket) return null;
  return (
    <div className="timeline">
      <div className="timeline-head">
        <span className="timeline-month">{bucket.label}</span>
        <span className="timeline-meta">{bucket.count} sales · median {money(bucket.median)}</span>
      </div>
      <div className="timeline-bar">
        {buckets.map((b, i) => (
          <span key={b.label + i} className={i <= at ? "on" : ""} style={{ height: `${Math.max(8, Math.round((b.count / most) * 100))}%` }} title={`${b.label}: ${b.count} sales`} />
        ))}
      </div>
    </div>
  );
}

function Headline({ text, accent, className }: { text: string; accent?: string; className?: string }) {
  const shown = useScramble(text);
  const start = accent ? text.indexOf(accent) : -1;
  if (start < 0 || !accent) return <h2 className={className}>{shown}</h2>;
  return (
    <h2 className={className}>
      {shown.slice(0, start)}
      <em>{shown.slice(start, start + accent.length)}</em>
      {shown.slice(start + accent.length)}
    </h2>
  );
}

function Sparkline({ series }: { series: Array<{ year: number; index: number }> }) {
  if (series.length < 2) return null;
  const width = 300;
  const height = 44;
  const values = series.map((p) => p.index);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = (i: number) => (i / (series.length - 1)) * width;
  const y = (v: number) => height - 6 - ((v - min) / Math.max(1e-9, max - min)) * (height - 16);
  const line = series.map((p, i) => `${x(i).toFixed(1)},${y(p.index).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon className="spark-area" points={`0,${height} ${line} ${width},${height}`} />
      <polyline className="spark-line" points={line} />
      <text className="spark-axis" x="0" y={height - 1}>{series[0].year}</text>
      <text className="spark-axis" x={width} y={height - 1} textAnchor="end">{series[series.length - 1].year}</text>
    </svg>
  );
}

function Question({ text }: { text: string }) {
  const shown = useScramble(text, 600);
  return <div className="question">{shown}</div>;
}

/** The current neighborhood plus its nearest neighbours, so the chip row stays short on a county-wide index. */
function nearby(index: IndexEntry[], current: string, limit: number): IndexEntry[] {
  const here = index.find((entry) => entry.slug === current);
  if (!here) return index.slice(0, limit);
  return [...index]
    .sort((a, b) => distanceM(here.center, a.center) - distanceM(here.center, b.center))
    .slice(0, limit);
}

function NeighborhoodChips({ index, current, onPick, title }: { index: IndexEntry[]; current: string; onPick: (slug: string) => void; title?: string }) {
  return (
    <div className="chips">
      {title && <span className="chips-title">{title}</span>}
      {nearby(index, current, 7).map((entry) => (
        <button key={entry.slug} className={`chip ${entry.slug === current ? "chip-on" : ""}`} onClick={() => onPick(entry.slug)}>
          <span>{entry.name}</span>
          <small>{money(entry.medianPrice)} median</small>
        </button>
      ))}
    </div>
  );
}

export function App() {
  const [index, setIndex] = useState<IndexEntry[]>([]);
  const [slug, setSlug] = useState(slugFromHash);
  const overview = slug === "";
  const [data, setData] = useState<Neighborhood | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const chapters = useMemo(() => (data ? buildChapters(data) : []), [data]);
  const { position, positionRef } = useScrollStory(chapters);
  const lastCamera = useRef("");
  // The look-around view (Google 3D) opens on the story's current camera and hands its own back on exit.
  const [explore, setExplore] = useState<"off" | "on" | "closing">("off");
  const resume = useRef<{ from: ViewCamera; at: number; ms?: number } | null>(null);
  // A flight within free look (down to a focused sale, out toward a neighbour), flown by the loop itself:
  // MapLibre's easeTo loses the centre height on a terrain map, and the height is the whole point here.
  const flight = useRef<{ from: ViewCamera; to: ViewCamera; at: number; ms: number } | null>(null);
  const dive = useRef<{ at: number } | null>(null);
  // Free look: a drag, a ctrl + scroll or a two-finger gesture hands the camera to the reader, and the
  // story stops steering it until the next page scroll, Escape or the "back to the tour" chip.
  const free = useRef(false);
  const [freeLook, setFreeLook] = useState(false);
  // While a button or finger is down the loop leaves the camera alone: each jumpTo resets MapLibre's
  // gesture handlers, so a drag begun while the drift was moving would never become one, and its
  // release would land as a click.
  const pressed = useRef(false);
  // The sale a click flew down to; its card stays pinned until free look ends.
  const focused = useRef<number | null>(null);
  // The sale dot under the pointer, for the hover card; a click on it opens the listing on the main site.
  const [saleTip, setSaleTip] = useState<{ price: number; beds: number; sqft: number; kind: number; address: string } | null>(null);
  // The card's place follows the pointer straight through the DOM; React only renders when the dot changes.
  const tipNode = useRef<HTMLDivElement>(null);
  const tipAt = useRef({ x: 0, y: 0 });
  const tipFor = useRef(-1);
  // A couple of dots show their card unprompted once they land, so the link is discoverable; the
  // first hover on any other dot clears them for the rest of the chapter.
  const [teasers, setTeasers] = useState<Teaser[]>([]);
  const teasersRef = useRef<Teaser[]>(teasers);
  teasersRef.current = teasers;
  const teaserSpots = useRef<TeaserSpots>([]);
  // The dot under the pointer swells and pings while the pointer rests on it, so there is no doubt which one is live.
  const hovering = useRef<{ id: number; since: number; frame: number } | null>(null);
  const teasersCleared = useRef(false);

  useEffect(() => {
    fetch(`${DATA_BASE}/index.json`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((entries: IndexEntry[]) => setIndex(entries))
      .catch((reason: Error) => setError(`Could not load the neighborhood list (${reason.message}). Run "npm run data" first.`));
    const onHash = () => setSlug(slugFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    let alive = true;
    setData(null);
    setMap(null);
    setError(null);
    lastCamera.current = "";
    free.current = false;
    setFreeLook(false);
    focused.current = null;
    window.scrollTo({ top: 0 });
    if (slug === "") return;
    fetch(`${DATA_BASE}/${slug}.json`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((loaded: Neighborhood) => {
        if (alive) setData(loaded);
      })
      .catch((reason: Error) => {
        if (alive) setError(`No data for "${slug}" (${reason.message}).`);
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  // Drive the camera from the scroll position, every frame, with a slow drift so the view never sits still
  // while someone is looking. Once the page has been left alone for a while the drift eases to rest, and a
  // resting camera means the map draws nothing at all. A scroll, click, key or touch wakes it; moving the
  // mouse alone does not, so nothing slides away from under the pointer.
  useEffect(() => {
    if (!map || !data || chapters.length === 0) return;
    let frame = 0;
    // The drift runs on its own clock, which stops while the pointer rests on a sale dot and slows to a halt when idle.
    let driftNow = 0;
    let lastNow = 0;
    let lastActivity = performance.now();
    let pace = 1; // 1 drifting, 0 at rest
    const wake = () => {
      lastActivity = performance.now();
    };
    const wakeEvents = ["scroll", "wheel", "pointerdown", "touchstart", "keydown"] as const;
    for (const event of wakeEvents) window.addEventListener(event, wake, { passive: true });
    const widthDegrees = data.bounds[1][0] - data.bounds[0][0];
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const tick = (now: number) => {
      if (!mapAlive(map)) return;
      // In free look the reader has the camera; keep the clock honest and wait.
      if (free.current || pressed.current) {
        lastNow = now;
        const trip = flight.current;
        if (trip && !pressed.current) {
          const e = smoothstep((now - trip.at) / trip.ms);
          map.jumpTo({
            center: [lerp(trip.from.center[0], trip.to.center[0], e), lerp(trip.from.center[1], trip.to.center[1], e)],
            zoom: lerp(trip.from.zoom, trip.to.zoom, e),
            pitch: lerp(trip.from.pitch, trip.to.pitch, e),
            bearing: lerpAngle(trip.from.bearing, trip.to.bearing, e),
            elevation: lerp(trip.from.elevation ?? 0, trip.to.elevation ?? 0, e),
          });
          if (e >= 1) flight.current = null;
        }
        frame = requestAnimationFrame(tick);
        return;
      }
      const { cameraT } = positionRef.current;
      const from = Math.min(chapters.length - 1, Math.floor(cameraT));
      const to = Math.min(chapters.length - 1, from + 1);
      const t = cameraT - from;
      const a = chapters[from].camera;
      const b = chapters[to].camera;
      const fit = zoomToFit(widthDegrees, map.getContainer().clientWidth, 0.8);
      const dt = lastNow ? now - lastNow : 0;
      lastNow = now;
      // The drift eases to rest once the page has been left alone. Hovering never touches it: pausing it
      // for a dot or a pill under the pointer made the map stutter with every dot a sweep crossed, and at
      // a couple of pixels a second the drift is slow enough that nothing escapes the cursor.
      const idle = now - lastActivity > IDLE_MS;
      pace = Math.min(1, Math.max(0, pace + (idle ? -dt / 1500 : dt / 800)));
      driftNow += dt * pace;
      const drift = still ? 0 : Math.sin(driftNow / 9000) * 2.2;
      const breathe = still ? 0 : Math.sin(driftNow / 13000) * 0.04;
      const camera = {
        center: [lerp(a.center[0], b.center[0], t), lerp(a.center[1], b.center[1], t)] as [number, number],
        zoom: Math.min(17.5, Math.max(8.5, fit + lerp(a.zoomDelta, b.zoomDelta, t) + breathe)),
        pitch: lerp(a.pitch, b.pitch, t),
        bearing: lerpAngle(a.bearing, b.bearing, t) + drift,
        // The story looks at sea level under its centre; a focus or look-around may have raised it.
        elevation: 0,
      };
      // On the way into look-around the camera dives toward the ground and Google picks up where it lands.
      const diving = dive.current;
      if (diving) {
        const u = smoothstep((now - diving.at) / DIVE_MS);
        camera.zoom += DIVE_ZOOM * u;
        camera.pitch = lerp(camera.pitch, Math.max(camera.pitch, DIVE_PITCH), u);
        camera.bearing += DIVE_BEARING * u;
      }
      // After look-around, glide from wherever Google left us back to the story.
      const back = resume.current;
      if (back) {
        const k = Math.min(1, (now - back.at) / (back.ms ?? 1400));
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        camera.center = [lerp(back.from.center[0], camera.center[0], e), lerp(back.from.center[1], camera.center[1], e)];
        camera.zoom = lerp(back.from.zoom, camera.zoom, e);
        camera.pitch = lerp(back.from.pitch, camera.pitch, e);
        camera.bearing = lerpAngle(back.from.bearing, camera.bearing, e);
        camera.elevation = lerp(back.from.elevation ?? 0, 0, e);
        if (k >= 1) resume.current = null;
      }
      const key = `${camera.center[0].toFixed(6)},${camera.center[1].toFixed(6)},${camera.zoom.toFixed(4)},${camera.pitch.toFixed(2)},${camera.bearing.toFixed(2)},${camera.elevation.toFixed(1)}`;
      if (key !== lastCamera.current) {
        map.jumpTo(camera);
        lastCamera.current = key;
      }
      frame = requestAnimationFrame(tick);
    };
    // Arriving from next door: glide in from where the hop left the previous camera.
    if (arrival) {
      resume.current = { from: arrival, at: performance.now(), ms: 2400 };
      arrival = null;
    }
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      for (const event of wakeEvents) window.removeEventListener(event, wake);
    };
  }, [map, data, chapters, positionRef]);

  useEffect(() => {
    if (!map || !mapAlive(map)) return;
    showLayers(map, chapters[position.active]?.layers ?? [], chapters[position.active + 1]?.layers ?? []);
  }, [map, chapters, position.active]);

  const pick = (next: string) => {
    if (next === slug) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    window.location.hash = next ? `/${next}` : "/";
  };

  /** The story camera as Google needs it, read live so the handover matches whatever is on screen. */
  const readCamera = (): ViewCamera => {
    const centre = map!.getCenter();
    const exaggeration = map!.getTerrain()?.exaggeration ?? 1;
    const altitude = (map!.queryTerrainElevation(centre) ?? 0) / exaggeration;
    return { center: [centre.lng, centre.lat], zoom: map!.getZoom(), pitch: map!.getPitch(), bearing: map!.getBearing(), altitude, elevation: map!.transform.elevation };
  };
  const enterExplore = () => {
    if (!map || !exploreAvailable || explore !== "off" || !mapAlive(map)) return;
    dive.current = { at: performance.now() };
    setExplore("on");
  };
  const enterExploreRef = useRef(enterExplore);
  enterExploreRef.current = enterExplore;
  const exitExplore = (camera: ViewCamera) => {
    if (explore !== "on") return;
    const pitch = Math.min(80, Math.max(0, camera.pitch));
    // Google orbits the ground under its centre; the map's centre height is the same ground, exaggerated.
    const elevation = camera.altitude * (map?.getTerrain()?.exaggeration ?? 1);
    if (free.current && map && mapAlive(map)) {
      // Look-around opened on a free camera, so it comes back to one: the map picks up Google's last view as is.
      map.jumpTo({ center: camera.center, zoom: camera.zoom, pitch, bearing: camera.bearing, elevation });
    } else {
      resume.current = { from: { ...camera, pitch, elevation }, at: performance.now() };
    }
    dive.current = null;
    setExplore("closing");
    window.setTimeout(() => setExplore("off"), 500);
  };

  const chapter: Chapter | undefined = chapters[position.active];
  const chapterRef = useRef(chapter);
  chapterRef.current = chapter;
  const dataRef = useRef(data);
  dataRef.current = data;

  const enterFree = () => {
    if (free.current || !map || !mapAlive(map)) return;
    free.current = true;
    setFreeLook(true);
  };
  /** Hand the camera back: it glides from wherever the reader left it to the chapter's view. */
  const leaveFree = () => {
    if (!free.current) return;
    free.current = false;
    setFreeLook(false);
    if (focused.current !== null) {
      focused.current = null;
      setTeasers([]);
    }
    if (!map || !mapAlive(map)) return;
    map.stop();
    flight.current = null;
    resume.current = { from: readCamera(), at: performance.now() };
  };

  /** Scroll to a chapter, far enough in that its text has settled. */
  const goToChapter = (index: number) => {
    if (chapters.length === 0) return;
    const i = Math.min(chapters.length - 1, Math.max(0, index));
    let top = 0;
    for (let k = 0; k < i; k += 1) top += chapters[k].height * window.innerHeight;
    if (i > 0 && i < chapters.length - 1) top += chapters[i].height * window.innerHeight * 0.12;
    window.scrollTo({ top: Math.round(top), behavior: "smooth" });
  };

  /** Fly down to a sale and pin its card; a second click on the dot, or the card, opens the listing. */
  const focusSale = (sale: Teaser) => {
    if (!map || !mapAlive(map)) return;
    enterFree();
    focused.current = sale.id;
    teasersCleared.current = true;
    tipFor.current = -1;
    setSaleTip(null);
    setTeasers([sale]);
    // The camera looks at the ground under the house, not at sea level beneath it: on a hillside the
    // difference is hundreds of metres, and aiming low put the house off screen behind the slope.
    const ground = map.queryTerrainElevation([sale.lon, sale.lat]) ?? 0;
    flight.current = {
      from: readCamera(),
      to: { center: [sale.lon, sale.lat], zoom: Math.max(map.getZoom(), 16.6), pitch: 62, bearing: map.getBearing() + 18, altitude: 0, elevation: ground },
      at: performance.now(),
      ms: 1500,
    };
  };

  /**
   * Go next door the immersive way: fly toward the neighbour before switching to it, and let the
   * next neighborhood glide in from there, so the change reads as a move across the map.
   */
  const hop = (next: string) => {
    const entry = index.find((e) => e.slug === next);
    if (!map || !mapAlive(map) || !entry || next === slug || explore !== "off") {
      pick(next);
      return;
    }
    enterFree();
    flight.current = {
      from: readCamera(),
      to: { center: entry.center, zoom: Math.max(11, map.getZoom() - 0.9), pitch: Math.min(map.getPitch(), 50), bearing: map.getBearing(), altitude: 0, elevation: 0 },
      at: performance.now(),
      ms: 1100,
    };
    window.setTimeout(() => {
      if (mapAlive(map)) arrival = readCamera();
      pick(next);
    }, 1000);
  };
  const actions = useRef({ enterFree, leaveFree, focusSale, goToChapter });
  actions.current = { enterFree, leaveFree, focusSale, goToChapter };

  // Sales that could carry a card: with a listing and an address, a house or condo, priced near the
  // median so they read as typical. Which two actually do is decided on screen when the chapter opens.
  const teaserCandidates = useMemo(() => {
    if (!data) return [];
    const median = data.market.all.medianPrice;
    return data.sales
      .map((s, id) => ({ id, lon: s[0], lat: s[1], price: s[2], sqft: s[3], kind: s[4], beds: s[5], listing: s[7] ?? "", address: s[8] ?? "", t: saleTime(id, s[6]) }))
      .filter((s) => s.listing && s.address && s.kind <= 1 && s.sqft > 0)
      .sort((a, b) => Math.abs(a.price - median) - Math.abs(b.price - median));
  }, [data]);

  // Two candidates well inside the view (clear of the headline, the stat column and the fact labels),
  // far apart on screen, one landing early in the year and one later on.
  const pickTeasers = (target: maplibregl.Map): Teaser[] => {
    const width = target.getContainer().clientWidth;
    const height = target.getContainer().clientHeight;
    const wide = width > 900;
    // A phone shows a sliver of map between the headline and the stat row, so it gets one card, placed more tightly.
    const box = wide
      ? { x0: width * 0.3, x1: width * 0.74, y0: height * 0.3, y1: height * 0.84 }
      : { x0: width * 0.25, x1: width * 0.75, y0: height * 0.3, y1: height * 0.52 };
    const windows: ReadonlyArray<readonly [number, number]> = wide ? [[1.5, 4.5], [6, 10]] : [[1.5, 10]];
    const labelGap = wide ? 150 : 90;
    const labels = (chapterRef.current?.labels ?? []).map((l) => screenPoint(target, [l.lon, l.lat]));
    // The ground a fact label's card can cover: up its stem from the dot and off to the right (or the left, flipped).
    const labelRects = labels.map((l) => ({ x0: l.x - 220, y0: l.y - 150, x1: l.x + 220, y1: l.y + 12 }));
    const cardRect = (at: { x: number; y: number }) => ({ x0: at.x - 95, y0: at.y - 100, x1: at.x + 95, y1: at.y + 6 });
    const overlaps = (a: { x0: number; y0: number; x1: number; y1: number }, b: { x0: number; y0: number; x1: number; y1: number }) =>
      a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
    const placed: Array<{ x: number; y: number }> = [];
    const picks: Teaser[] = [];
    for (const window of windows) {
      for (const s of teaserCandidates) {
        if (s.t < window[0] || s.t > window[1] || picks.some((p) => p.id === s.id)) continue;
        const at = screenPoint(target, [s.lon, s.lat]);
        if (!(at.x > box.x0 && at.x < box.x1 && at.y > box.y0 && at.y < box.y1)) continue;
        if (labels.some((l) => Math.hypot(l.x - at.x, l.y - at.y) < labelGap)) continue;
        if (labelRects.some((r) => overlaps(cardRect(at), r))) continue;
        if (placed.some((q) => Math.hypot(q.x - at.x, q.y - at.y) < width * 0.22)) continue;
        picks.push(s);
        placed.push(at);
        break;
      }
    }
    return picks;
  };

  // A click on a sale dot opens that listing on the main site; a click on the map itself is the quiet
  // way into look-around. Google's script is fetched early so the way in is short.
  useEffect(() => {
    if (!map || !mapAlive(map)) return;
    type SaleHit = Teaser & { teaser: boolean };
    // Screen positions of every sale, projected once per camera position rather than per mouse move,
    // with a remembered ground height per sale (the DEM read is the slow part, and it also drops to sea
    // level for a frame at tile edges), so a sweep across the dots costs next to nothing.
    const sales = dataRef.current?.sales ?? [];
    const lngLats = sales.map((s) => new LngLat(s[0], s[1]));
    const heights = new Float64Array(sales.length);
    const screen = new Float64Array(sales.length * 2);
    let cameraVersion = 0;
    let projectedFor = -1;
    const bump = () => {
      cameraVersion += 1;
    };
    let height = 0;
    type FakeTerrain = NonNullable<Parameters<typeof map.transform.locationToScreenPoint>[1]>;
    const fixed = { getElevationForLngLat: () => height, getElevationForLngLatZoom: () => height } as unknown as FakeTerrain;
    const projectAll = () => {
      if (projectedFor === cameraVersion) return;
      projectedFor = cameraVersion;
      const terrain = map.getTerrain();
      for (let i = 0; i < sales.length; i += 1) {
        if (terrain && heights[i] === 0) heights[i] = map.queryTerrainElevation(lngLats[i]) ?? 0;
        height = heights[i];
        const p = map.transform.locationToScreenPoint(lngLats[i], terrain ? fixed : undefined);
        screen[i * 2] = p.x;
        screen[i * 2 + 1] = p.y;
      }
    };
    const saleAt = (point: maplibregl.Point): SaleHit | null => {
      // Dots exist in every chapter but are only drawn in the ones that list the layer, and only once the timeline has reached them.
      if (!chapterRef.current?.layers.includes("sales") || !map.getLayer("sales")) return null;
      // A dot carrying a card is matched where its card is drawn, so it is never lost among its neighbours.
      const rect = map.getCanvas().getBoundingClientRect();
      const spot = teaserSpots.current.find((s) => Math.hypot(s.x - rect.left - point.x, s.y - rect.top - point.y) <= 12);
      const teaser = spot && teasersRef.current.find((t) => t.id === spot.id);
      if (teaser) return { ...teaser, teaser: true };
      // The dots are matched on the CPU: a rendered-feature query on a terrain map reads a pixel back from
      // the GPU, which stalls the frame and showed as a hitch whenever the pointer crossed a dot.
      const on = salesOn(map);
      if (!on) return null;
      projectAll();
      const pad = 9;
      let best = -1;
      let bestGap = pad;
      for (let i = 0; i < sales.length; i += 1) {
        if (!on[i]) continue;
        const d = Math.hypot(screen[i * 2] - point.x, screen[i * 2 + 1] - point.y);
        // Where dots crowd, the one nearest the pointer wins.
        if (d < bestGap) {
          bestGap = d;
          best = i;
        }
      }
      if (best < 0) return null;
      const s = sales[best];
      return { id: best, teaser: false, lon: s[0], lat: s[1], price: s[2], sqft: s[3], kind: s[4], beds: s[5], listing: s[7] ?? "", address: s[8] ?? "" };
    };
    const releaseHover = () => {
      const current = hovering.current;
      if (!current) return;
      cancelAnimationFrame(current.frame);
      hovering.current = null;
      if (mapAlive(map) && map.getSource("sales")) map.setFeatureState({ source: "sales", id: current.id }, { hover: -1, ring: 1 });
    };
    const holdSaleHover = (id: number) => {
      if (hovering.current?.id === id) return;
      releaseHover();
      const since = performance.now();
      const state = { id, since, frame: 0 };
      hovering.current = state;
      const ping = (now: number) => {
        if (hovering.current !== state) return;
        // The chapter may have scrolled away under a resting pointer.
        if (!mapAlive(map) || !chapterRef.current?.layers.includes("sales")) {
          releaseHover();
          return;
        }
        const t = (now - since) / 1000;
        map.setFeatureState({ source: "sales", id }, { hover: t, ring: (t % 1.1) / 1.1 });
        state.frame = requestAnimationFrame(ping);
      };
      state.frame = requestAnimationFrame(ping);
    };
    const onClick = (event: maplibregl.MapMouseEvent) => {
      const hit = saleAt(event.point);
      if (hit) {
        // The first click on a dot flies down to it with its card pinned; a click on the focused dot opens the listing.
        if (hit.listing && focused.current === hit.id) {
          window.open(listingUrl(hit.listing), "_blank", "noopener");
          return;
        }
        const { teaser: _teaser, ...sale } = hit;
        actions.current.focusSale(sale);
        return;
      }
      enterExploreRef.current();
    };
    // A mouse reports many positions per frame; the hit test (a rendered-feature query on a terrain
    // map) runs once per frame on the latest one.
    let moveFrame = 0;
    let lastMove: maplibregl.MapMouseEvent | null = null;
    const onMove = (event: maplibregl.MapMouseEvent) => {
      lastMove = event;
      if (moveFrame) return;
      moveFrame = requestAnimationFrame(() => {
        moveFrame = 0;
        if (lastMove && mapAlive(map)) hitTest(lastMove);
      });
    };
    const clearTip = () => {
      tipFor.current = -1;
      setSaleTip((tip) => (tip ? null : tip));
    };
    const hitTest = (event: maplibregl.MapMouseEvent) => {
      const hit = saleAt(event.point);
      map.getCanvas().style.cursor = hit ? "pointer" : "";
      if (!hit) {
        releaseHover();
        clearTip();
        return;
      }
      holdSaleHover(hit.id);
      // A teaser dot already shows its card; any other dot takes the teasers down for good.
      if (hit.teaser) {
        clearTip();
        return;
      }
      if (teasersRef.current.some((t) => t.id !== focused.current)) {
        teasersCleared.current = true;
        setTeasers((current) => current.filter((t) => t.id === focused.current));
      }
      const rect = map.getCanvas().getBoundingClientRect();
      tipAt.current = { x: rect.left + event.point.x, y: rect.top + event.point.y };
      if (tipNode.current) {
        tipNode.current.style.left = `${tipAt.current.x}px`;
        tipNode.current.style.top = `${tipAt.current.y}px`;
      }
      if (tipFor.current !== hit.id) {
        tipFor.current = hit.id;
        setSaleTip({ price: hit.price, beds: hit.beds, sqft: hit.sqft, kind: hit.kind, address: hit.address });
      }
    };
    const onLeave = () => {
      releaseHover();
      map.getCanvas().style.cursor = "";
      clearTip();
    };
    // Any gesture on the map hands the camera over; the next page scroll takes it back.
    const grab = (event: { originalEvent?: unknown }) => {
      if (!event.originalEvent) return;
      // A hand on the map ends any flight in progress.
      flight.current = null;
      actions.current.enterFree();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) actions.current.enterFree();
    };
    const onTouch = (event: TouchEvent) => {
      if (event.touches.length >= 2) actions.current.enterFree();
    };
    const onScroll = () => actions.current.leaveFree();
    const onPress = () => {
      pressed.current = true;
    };
    const onRelease = (event: MouseEvent | TouchEvent) => {
      if ("touches" in event && event.touches.length > 0) return;
      pressed.current = false;
    };
    // The hover card sits where the pointer was; once the map slides under a still pointer it is stale.
    const onMapMove = () => {
      bump();
      if (!free.current) return;
      releaseHover();
      clearTip();
    };
    const gestures = ["dragstart", "zoomstart", "rotatestart", "pitchstart"] as const;
    const canvas = map.getCanvas();
    map.on("click", onClick);
    map.on("mousemove", onMove);
    map.on("mouseout", onLeave);
    map.on("move", onMapMove);
    for (const name of gestures) map.on(name, grab);
    canvas.addEventListener("wheel", onWheel, { passive: true });
    canvas.addEventListener("touchstart", onTouch, { passive: true });
    canvas.addEventListener("mousedown", onPress);
    canvas.addEventListener("touchstart", onPress, { passive: true });
    window.addEventListener("mouseup", onRelease);
    window.addEventListener("touchend", onRelease);
    window.addEventListener("touchcancel", onRelease);
    window.addEventListener("scroll", onScroll, { passive: true });
    const warm = window.setTimeout(preloadMaps3d, 2500);
    return () => {
      releaseHover();
      cancelAnimationFrame(moveFrame);
      if (mapAlive(map)) {
        map.off("click", onClick);
        map.off("mousemove", onMove);
        map.off("mouseout", onLeave);
        map.off("move", onMapMove);
        for (const name of gestures) map.off(name, grab);
      }
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("touchstart", onTouch);
      canvas.removeEventListener("mousedown", onPress);
      canvas.removeEventListener("touchstart", onPress);
      window.removeEventListener("mouseup", onRelease);
      window.removeEventListener("touchend", onRelease);
      window.removeEventListener("touchcancel", onRelease);
      window.removeEventListener("scroll", onScroll);
      pressed.current = false;
      window.clearTimeout(warm);
    };
  }, [map]);

  // The keys move through the chapters; Escape hands a free camera back to the story.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.key === "Escape") {
        actions.current.leaveFree();
        return;
      }
      if (explore !== "off" || chapters.length === 0) return;
      const step = ["ArrowRight", "ArrowDown", "PageDown"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key) ? -1 : 0;
      if (step === 0) return;
      event.preventDefault();
      actions.current.goToChapter(positionRef.current.active + step);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chapters, explore, positionRef]);
  const settled = position.progress > 0.06 || position.active === 0;
  const playback = chapter?.kind === "story" && settled ? chapter.playback : undefined;
  const chapterId = chapter?.id;
  const [tick, setTick] = useState(-1);

  // Chapter animations: the year of sales lands month by month; commute routes draw themselves.
  useEffect(() => {
    if (!map || !mapAlive(map)) return;
    // The pointer has not moved, but the map under it has.
    tipFor.current = -1;
    setSaleTip(null);
    if (!playback) {
      setSalesClock(map, null);
      setRouteProgress(map, 1);
      setTick(-1);
      setTeasers([]);
      teasersCleared.current = false;
      return;
    }
    const shown = new Set<number>();
    // Picked once the first card is due, when the camera has settled on the chapter.
    let picks: Teaser[] | null = null;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = playback === "sales" ? 7000 : 2800;
    const span = 12 + 1.5; // months, plus a tail for the last pulses to fade
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      if (!mapAlive(map)) return;
      const u = still ? 1 : Math.min(1, (now - start) / duration);
      if (playback === "sales") {
        const clock = u * span;
        setSalesClock(map, clock);
        setTick(Math.min(11, Math.floor(clock)));
        // A teaser's card appears once its pulse ring has settled.
        if (clock >= 1.5 + PULSE + 0.4 && !teasersCleared.current) {
          picks ??= pickTeasers(map);
          for (const pick of picks) {
            if (shown.has(pick.id) || clock < saleTime(pick.id, data?.sales[pick.id]?.[6] ?? 0) + PULSE + 0.4) continue;
            shown.add(pick.id);
            setTeasers((current) => (current.some((t) => t.id === pick.id) ? current : [...current, pick]));
          }
        }
      } else {
        setRouteProgress(map, 1 - Math.pow(1 - u, 2));
      }
      if (u < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [map, playback, chapterId]);
  const legend = chapter ? chapter.layers.flatMap((layer) => LEGEND[layer] ?? []) : [];
  const regions = useMemo(() => {
    const groups = new Map<string, IndexEntry[]>();
    for (const entry of index) groups.set(entry.region, [...(groups.get(entry.region) ?? []), entry]);
    return [...groups.entries()];
  }, [index]);

  return (
    <>
      {overview && index.length > 0 && <Overview index={index} onPick={pick} />}
      {data && <MapScene key={data.slug} data={data} onReady={setMap} />}
      <div className="spacers">
        {chapters.map((c) => (
          <section key={c.id} style={{ ["--h" as string]: c.height * 100 }} />
        ))}
      </div>

      <header className="top">
        <a className="wordmark" href="#/" aria-label="Snaphomz" onClick={(event) => { event.preventDefault(); pick(""); }} dangerouslySetInnerHTML={{ __html: logoSvg }} />
        <div className="top-right">
          <span className="poc" title={`build ${build}`}>{city.name} neighborhoods</span>
          <select className="select" value={slug} onChange={(event) => pick(event.target.value)} aria-label="Neighborhood">
            <option value="">All of {city.name}</option>
            {index.length === 0 && slug && <option value={slug}>{data?.name ?? slug}</option>}
            {regions.map(([region, entries]) => (
              <optgroup key={region} label={region}>
                {entries.map((entry) => (
                  <option key={entry.slug} value={entry.slug}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </header>

      {error && (
        <div className="splash">
          <div className="splash-mark" aria-label="Snaphomz" dangerouslySetInnerHTML={{ __html: logoSvg }} />
          <p>{error}</p>
          {index.length > 0 && (
            <p>
              <a href={`#/${index[0].slug}`} style={{ color: "#DCF763" }}>
                Go to {index[0].name}
              </a>
            </p>
          )}
        </div>
      )}
      {!error && !overview && (!data || !map) && (
        <div className="splash">
          <div className="splash-mark" aria-label="Snaphomz" dangerouslySetInnerHTML={{ __html: logoSvg }} />
          <p>Loading {index.find((e) => e.slug === slug)?.name ?? "the neighborhood"}…</p>
        </div>
      )}

      {!overview && data && chapter && map && (
        <>
          <Labels map={map} labels={chapter.labels} visible={chapter.kind === "story" && settled} />
          <Neighbors
            map={map}
            index={index}
            current={slug}
            onPick={hop}
            hidden={explore !== "off"}
          />

          <div className={`hero ${chapter.kind === "hero" ? "show" : ""}`}>
            <h1>
              Know <em>{data.name}</em>
              <br />
              before you buy.
            </h1>
            <p className="hero-body">{data.tagline}</p>
            <p className="hero-sub">
              {data.market.all.count.toLocaleString()} sales in the last year · median {money(data.market.all.medianPrice)} · {data.region}
            </p>
            <NeighborhoodChips index={index} current={slug} onPick={hop} title="Nearby" />
            <div className="sources-strip">
              <span>Built from</span> {city.credits}
            </div>
          </div>

          <div className={`story ${chapter.kind === "story" && settled ? "show" : ""}`}>
            <div className="story-left">
              <Headline text={chapter.headline} accent={chapter.accent} className="story-headline" />
              {legend.length > 0 && (
                <div className="legend">
                  {legend.map((item) => (
                    <span key={item.label} className="legend-item">
                      <Swatch spec={item.swatch} />
                      {item.label}
                    </span>
                  ))}
                </div>
              )}
              {chapter.timeline && <Timeline buckets={chapter.timeline} tick={tick} />}
            </div>
            <aside className="stats" key={chapter.id}>
              {chapter.stats.map((stat, i) => (
                <div key={stat.label} className={`stat tone-${stat.tone ?? "white"}`} style={{ transitionDelay: `${120 + i * 90}ms` }}>
                  <div className="stat-value">{stat.value}</div>
                  <div className="stat-label">{stat.label}</div>
                  {stat.series && <Sparkline series={stat.series} />}
                  {stat.note && <div className="stat-note">{stat.note}</div>}
                </div>
              ))}
              {chapter.sources && chapter.sources.length > 0 && <div className="stat-sources">{chapter.sources.join(" · ")}</div>}
            </aside>
          </div>

          <div className={`closing ${chapter.kind === "closing" ? "show" : ""}`}>
            <Headline text={chapter.headline} accent={chapter.accent} className="closing-headline" />
            <p>{chapter.body}</p>
            <div className="cta-row">
              <a className="cta" href={homesUrl(data.slug)} target="_blank" rel="noreferrer">
                Homes for sale in {data.name} <span aria-hidden="true">→</span>
              </a>
              <button className="cta cta-ghost" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
                Fly over it again
              </button>
            </div>
            <NeighborhoodChips index={index} current={slug} onPick={hop} title="Next door" />
          </div>

          <div className={`question-wrap ${chapter.kind === "story" ? "show" : ""}`}>
            {chapter.question && <Question text={chapter.question} />}
          </div>

          <div className={`scroll-hint ${position.overall < 0.97 && !freeLook ? "show" : ""}`}>
            scroll <span className="arrow">↓</span>
          </div>
          <nav className="progress" aria-label="Chapters">
            {chapters.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className={`progress-seg ${i === position.active ? "is-on" : ""}`}
                onClick={() => goToChapter(i)}
                title={chapterName(c)}
              >
                <span className="progress-name">{chapterName(c)}</span>
                <span className="progress-track">
                  <span className="progress-fill" style={{ transform: `scaleX(${i < position.active ? 1 : i === position.active ? position.progress : 0})` }} />
                </span>
              </button>
            ))}
          </nav>
          <button type="button" className={`tour-back ${freeLook && explore === "off" ? "show" : ""}`} onClick={leaveFree}>
            <span aria-hidden="true">↩</span> back to the tour
          </button>
          <div className={`free-hint ${!freeLook && explore === "off" && chapter.kind !== "hero" ? "show" : ""}`} aria-hidden="true">
            drag to look around · ctrl + scroll zooms
          </div>

          {saleTip && (
            <div ref={tipNode} className="sale-tip" style={{ left: tipAt.current.x, top: tipAt.current.y }} role="tooltip">
              <div className="sale-tip-price">{money(saleTip.price)}</div>
              {saleTip.address && <div className="sale-tip-address">{saleTip.address}</div>}
              <div className="sale-tip-meta">
                {saleTip.beds > 0 ? `${saleTip.beds} bd · ` : ""}
                {saleTip.sqft > 0 ? `${saleTip.sqft.toLocaleString()} sqft · ` : ""}
                {saleKindName(saleTip.kind)}
              </div>
              <div className="sale-tip-hint">Open the listing on Snaphomz ↗</div>
            </div>
          )}
          {map && mapAlive(map) && teasers.length > 0 && explore === "off" && <SaleTeasers map={map} teasers={teasers} spots={teaserSpots} />}
          {exploreAvailable && (
            <button className={`look-around ${explore === "off" ? "show" : ""}`} onClick={enterExplore} title="Open this view in Google 3D and move around freely">
              <span className="look-around-icon" aria-hidden="true">⤢</span>look around
            </button>
          )}
          {explore !== "off" && <Explore getCamera={readCamera} closing={explore === "closing"} minWait={DIVE_MS} onExit={exitExplore} />}
        </>
      )}
    </>
  );
}
