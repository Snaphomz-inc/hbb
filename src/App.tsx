import type maplibregl from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { Labels } from "./components/Labels";
import { Overview } from "./Overview";
import { distanceM, zoomToFit } from "./lib/geo";
import { money } from "./lib/format";
import { useScramble } from "./lib/scramble";
import { MapScene, mapAlive, setRouteProgress, setSalesClock, showLayers } from "./map/MapScene";
import { buildChapters, type Chapter } from "./story/chapters";
import { useScrollStory } from "./story/useScrollStory";
import type { IndexEntry, Neighborhood } from "./types";

const DATA_BASE = `${import.meta.env.BASE_URL}data`;

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

  // Drive the camera from the scroll position, every frame, with a slow drift so the view never sits still.
  useEffect(() => {
    if (!map || !data || chapters.length === 0) return;
    let frame = 0;
    const widthDegrees = data.bounds[1][0] - data.bounds[0][0];
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const tick = (now: number) => {
      if (!mapAlive(map)) return;
      const { cameraT } = positionRef.current;
      const from = Math.min(chapters.length - 1, Math.floor(cameraT));
      const to = Math.min(chapters.length - 1, from + 1);
      const t = cameraT - from;
      const a = chapters[from].camera;
      const b = chapters[to].camera;
      const fit = zoomToFit(widthDegrees, map.getContainer().clientWidth, 0.8);
      const drift = still ? 0 : Math.sin(now / 9000) * 2.2;
      const breathe = still ? 0 : Math.sin(now / 13000) * 0.04;
      const camera = {
        center: [lerp(a.center[0], b.center[0], t), lerp(a.center[1], b.center[1], t)] as [number, number],
        zoom: Math.min(17.5, Math.max(8.5, fit + lerp(a.zoomDelta, b.zoomDelta, t) + breathe)),
        pitch: lerp(a.pitch, b.pitch, t),
        bearing: lerpAngle(a.bearing, b.bearing, t) + drift,
      };
      const key = `${camera.center[0].toFixed(6)},${camera.center[1].toFixed(6)},${camera.zoom.toFixed(4)},${camera.pitch.toFixed(2)},${camera.bearing.toFixed(2)}`;
      if (key !== lastCamera.current) {
        map.jumpTo(camera);
        lastCamera.current = key;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [map, data, chapters, positionRef]);

  useEffect(() => {
    if (!map || !mapAlive(map)) return;
    showLayers(map, chapters[position.active]?.layers ?? []);
  }, [map, chapters, position.active]);

  const pick = (next: string) => {
    if (next === slug) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    window.location.hash = next ? `/${next}` : "/";
  };

  const chapter: Chapter | undefined = chapters[position.active];
  const settled = position.progress > 0.06 || position.active === 0;
  const playback = chapter?.kind === "story" && settled ? chapter.playback : undefined;
  const chapterId = chapter?.id;
  const [tick, setTick] = useState(-1);

  // Chapter animations: the year of sales lands month by month; commute routes draw themselves.
  useEffect(() => {
    if (!map || !mapAlive(map)) return;
    if (!playback) {
      setSalesClock(map, null);
      setRouteProgress(map, 1);
      setTick(-1);
      return;
    }
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
          <section key={c.id} style={{ height: `${c.height * 100}vh` }} />
        ))}
      </div>

      <header className="top">
        <a className="wordmark" href="#/" onClick={(event) => { event.preventDefault(); pick(""); }}>
          snaphomz<span className="wordmark-dot">.</span>
        </a>
        <div className="top-right">
          <span className="poc">Los Angeles neighborhoods</span>
          <select className="select" value={slug} onChange={(event) => pick(event.target.value)} aria-label="Neighborhood">
            <option value="">All of Los Angeles</option>
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
          <div className="splash-mark">snaphomz</div>
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
          <div className="splash-mark">snaphomz</div>
          <p>Loading {index.find((e) => e.slug === slug)?.name ?? "the neighborhood"}…</p>
        </div>
      )}

      {!overview && data && chapter && map && (
        <>
          <Labels map={map} labels={chapter.labels} visible={chapter.kind === "story" && settled} />

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
            <NeighborhoodChips index={index} current={slug} onPick={pick} title="Nearby" />
            <div className="sources-strip">
              <span>Built from</span> MLS closed sales · FEMA · CAL FIRE · California Geological Survey · EPA · OpenStreetMap · Census · U.S. DOT · FHFA · Freddie Mac
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
              <a className="cta" href={`https://www.snaphomz.com/buy?search=${encodeURIComponent(data.name)}`} target="_blank" rel="noreferrer">
                Browse homes in {data.name} <span aria-hidden="true">→</span>
              </a>
              <button className="cta cta-ghost" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
                Fly over it again
              </button>
            </div>
            <NeighborhoodChips index={index} current={slug} onPick={pick} title="Next door" />
          </div>

          <div className={`question-wrap ${chapter.kind === "story" ? "show" : ""}`}>
            {chapter.question && <Question text={chapter.question} />}
          </div>

          <div className={`scroll-hint ${position.overall < 0.97 ? "show" : ""}`}>
            scroll <span className="arrow">↓</span>
          </div>
          <div className="progress">
            <div className="progress-bar" style={{ transform: `scaleX(${position.overall})` }} />
          </div>
        </>
      )}
    </>
  );
}
