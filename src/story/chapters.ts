import { featureAnchor, largestFeature, meanPoint } from "../lib/geo";
import { count, days, money, percent, signedPercent } from "../lib/format";
import type { Neighborhood, Poi, School } from "../types";

export type Tone = "lime" | "red" | "blue" | "orange" | "purple" | "white" | "green";

export type Label = {
  id: string;
  lon: number;
  lat: number;
  title: string;
  value?: string;
  source?: string;
  tone?: Tone;
};

export type Stat = { label: string; value: string; note?: string; tone?: Tone; series?: Array<{ year: number; index: number }> };

export type Camera = {
  center: [number, number];
  /** Added to the zoom that fits the neighborhood in the viewport. */
  zoomDelta: number;
  pitch: number;
  bearing: number;
};

export type Chapter = {
  id: string;
  kind: "hero" | "story" | "closing";
  question?: string;
  headline: string;
  /** Word in the headline drawn in the accent colour. */
  accent?: string;
  body?: string;
  camera: Camera;
  layers: string[];
  labels: Label[];
  stats: Stat[];
  /** Section height, in viewport heights. */
  height: number;
  sources?: string[];
};

const LEVEL_NAMES: Record<string, string> = { Elementary: "Elementary", Middle: "Middle", High: "High", "Elem-High Combo": "K-12" };

function uniqueByName(points: Poi[], limit: number): Poi[] {
  const seen = new Set<string>();
  const out: Poi[] = [];
  for (const point of points) {
    const key = (point.name || point.brand || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(point);
    if (out.length >= limit) break;
  }
  return out;
}

/** Spread picks across the area: greedy farthest-point so labels don't pile up. */
function spread<T extends { lon: number; lat: number }>(points: T[], limit: number): T[] {
  if (points.length <= limit) return points;
  const chosen: T[] = [points[0]];
  while (chosen.length < limit) {
    let best: T | null = null;
    let bestDistance = -1;
    for (const point of points) {
      if (chosen.includes(point)) continue;
      const nearest = Math.min(...chosen.map((c) => (c.lon - point.lon) ** 2 + (c.lat - point.lat) ** 2));
      if (nearest > bestDistance) {
        bestDistance = nearest;
        best = point;
      }
    }
    if (!best) break;
    chosen.push(best);
  }
  return chosen;
}

function saleLabels(data: Neighborhood): Label[] {
  const labels: Label[] = [];
  const sales = data.sales;
  if (sales.length === 0) return labels;
  const houses = sales.filter((s) => s[4] === 0);
  const condos = sales.filter((s) => s[4] === 1);
  const highest = [...sales].sort((a, b) => b[2] - a[2])[0];
  labels.push({ id: "highest", lon: highest[0], lat: highest[1], title: "Highest sale", value: money(highest[2]), tone: "red" });
  const typical = (group: typeof sales, median: number | undefined) => {
    if (!group.length || median == null) return null;
    return [...group].sort((a, b) => Math.abs(a[2] - median) - Math.abs(b[2] - median))[0];
  };
  const house = typical(houses, data.market.houses?.medianPrice);
  if (house) labels.push({ id: "house", lon: house[0], lat: house[1], title: "Typical house", value: `${money(house[2])} · ${house[5]} bd · ${count(house[3])} sqft`, tone: "lime" });
  const condo = typical(condos, data.market.condos?.medianPrice);
  if (condo) labels.push({ id: "condo", lon: condo[0], lat: condo[1], title: "Typical condo", value: `${money(condo[2])} · ${condo[5]} bd · ${count(condo[3])} sqft`, tone: "lime" });
  const cheapest = [...houses].sort((a, b) => a[2] - b[2])[0];
  if (cheapest && cheapest !== house) labels.push({ id: "entry", lon: cheapest[0], lat: cheapest[1], title: "Entry-level house", value: money(cheapest[2]), tone: "blue" });
  return labels;
}

function placeLabels(data: Neighborhood): Label[] {
  const pois = data.pois;
  if (!pois) return [];
  const labels: Label[] = [];
  for (const store of spread(uniqueByName(pois.categories.grocery ?? [], 12), 4)) {
    labels.push({ id: `grocery-${store.lon}-${store.lat}`, lon: store.lon, lat: store.lat, title: "Grocery", value: store.name || store.brand || "Supermarket", tone: "lime" });
  }
  for (const station of spread(uniqueByName(pois.categories.rail ?? [], 8), 3)) {
    labels.push({ id: `rail-${station.lon}-${station.lat}`, lon: station.lon, lat: station.lat, title: "Rail station", value: station.name || "Station", tone: "blue" });
  }
  const parks = pois.parks?.features
    .filter((f) => f.properties.kind === "park" && f.properties.name)
    .map((f) => ({ feature: f, anchor: featureAnchor(f) }))
    .filter((p) => p.anchor)
    .sort((a, b) => (b.feature.geometry ? 1 : 0) - (a.feature.geometry ? 1 : 0)) ?? [];
  const biggest = parks
    .map((p) => ({ ...p, area: p.feature.geometry ? 1 : 0 }))
    .slice(0, 40);
  for (const park of spread(biggest.map((p) => ({ lon: p.anchor![0], lat: p.anchor![1], name: String(p.feature.properties.name) })), 2)) {
    labels.push({ id: `park-${park.lon}-${park.lat}`, lon: park.lon, lat: park.lat, title: "Park", value: park.name, tone: "green" });
  }
  const beach = largestFeature(pois.parks, (f) => f.properties.kind === "beach");
  const beachAnchor = beach ? featureAnchor(beach) : null;
  if (beachAnchor) labels.push({ id: "beach", lon: beachAnchor[0], lat: beachAnchor[1], title: "Beach", value: String(beach!.properties.name || "Shoreline"), tone: "blue" });
  return labels;
}

function schoolLabels(schools: School[]): Label[] {
  const byLevel = (level: string, limit: number) =>
    spread(
      schools
        .filter((s) => s.public && s.type === level && (s.enrollment ?? 0) > 0)
        .sort((a, b) => (b.enrollment ?? 0) - (a.enrollment ?? 0))
        .slice(0, 10),
      limit,
    );
  const picks = [...byLevel("Elementary", 3), ...byLevel("Middle", 1), ...byLevel("High", 1)];
  return picks.map((s) => ({
    id: `school-${s.lon}-${s.lat}`,
    lon: s.lon,
    lat: s.lat,
    title: `${LEVEL_NAMES[s.type] ?? s.type} school`,
    value: `${s.name}${s.enrollment ? ` · ${count(s.enrollment)} students` : ""}`,
    tone: "lime" as Tone,
  }));
}

function riskLabels(data: Neighborhood): Label[] {
  const labels: Label[] = [];
  const hazards = data.hazards;
  const flood = largestFeature(hazards.flood, (f) => f.properties.cls === "sfha");
  const floodAnchor = flood ? featureAnchor(flood) : null;
  if (floodAnchor) labels.push({ id: "flood", lon: floodAnchor[0], lat: floodAnchor[1], title: "Flood zone", value: `FEMA ${String(flood!.properties.FLD_ZONE)} · 1% a year`, tone: "blue" });
  const moderate = largestFeature(hazards.flood, (f) => f.properties.cls === "moderate");
  const moderateAnchor = moderate ? featureAnchor(moderate) : null;
  if (moderateAnchor && !floodAnchor) labels.push({ id: "flood-moderate", lon: moderateAnchor[0], lat: moderateAnchor[1], title: "Moderate flood risk", value: "0.2% a year", tone: "blue" });
  const fire = largestFeature(hazards.fire, (f) => Number(f.properties.severity) >= 2) ?? largestFeature(hazards.fire);
  const fireAnchor = fire ? featureAnchor(fire) : null;
  if (fireAnchor) {
    const severity = Number(fire!.properties.severity);
    labels.push({ id: "fire", lon: fireAnchor[0], lat: fireAnchor[1], title: "Fire hazard zone", value: ["", "Moderate", "High", "Very high"][severity] ?? "Zoned", tone: "orange" });
  }
  const liquefaction = largestFeature(hazards.liquefaction);
  const liqAnchor = liquefaction ? featureAnchor(liquefaction) : null;
  if (liqAnchor) labels.push({ id: "liquefaction", lon: liqAnchor[0], lat: liqAnchor[1], title: "Liquefaction zone", value: "Earthquake · soft soil", tone: "purple" });
  const landslide = largestFeature(hazards.landslide);
  const slideAnchor = landslide ? featureAnchor(landslide) : null;
  if (slideAnchor) labels.push({ id: "landslide", lon: slideAnchor[0], lat: slideAnchor[1], title: "Landslide zone", value: "Earthquake-induced", tone: "orange" });
  const fault = largestFeature(hazards.fault);
  const faultAnchor = fault ? featureAnchor(fault) : null;
  if (faultAnchor) labels.push({ id: "fault", lon: faultAnchor[0], lat: faultAnchor[1], title: "Fault zone", value: "Alquist-Priolo", tone: "red" });
  const loudest = data.noise?.cells.filter((c) => c[2] >= 65).sort((a, b) => b[2] - a[2]) ?? [];
  if (loudest.length) {
    // Several loud cells sit along the same road; take one from the middle of the pack.
    const pick = loudest[Math.floor(loudest.length / 2)];
    labels.push({ id: "noise", lon: pick[0], lat: pick[1], title: "Traffic noise", value: `${pick[2]} dB daily average`, tone: "red" });
  }
  return labels;
}

function permitLabels(data: Neighborhood): Label[] {
  const permits = data.permits;
  if (!permits) return [];
  const labelFor: Record<string, Tone> = { "New homes": "lime", "Pools and spas": "blue", Additions: "white", Solar: "orange" };
  const labels: Label[] = [];
  for (const group of Object.keys(labelFor)) {
    const points = permits.points.filter((p) => p[2] === group).map((p) => ({ lon: p[0], lat: p[1] }));
    for (const point of spread(points.slice(0, 30), group === "New homes" ? 2 : 1)) {
      labels.push({ id: `permit-${point.lon}-${point.lat}`, lon: point.lon, lat: point.lat, title: group, value: "Permit, last 12 months", tone: labelFor[group] });
    }
  }
  return labels;
}

export function buildChapters(data: Neighborhood): Chapter[] {
  const market = data.market;
  const all = market.all;
  const base = { bearing: data.camera.bearing ?? 30, pitch: data.camera.pitch ?? 60 };
  const center = data.center;
  const chapters: Chapter[] = [];

  chapters.push({
    id: "hero",
    kind: "hero",
    headline: `Know ${data.name} before you buy.`,
    accent: data.name,
    body: data.tagline,
    camera: { center, zoomDelta: -0.35, pitch: Math.max(45, base.pitch - 12), bearing: base.bearing - 25 },
    layers: [],
    labels: [],
    stats: [],
    height: 1,
  });

  const payment = market.paymentAtMedian;
  chapters.push({
    id: "homes",
    kind: "story",
    question: "What do homes sell for here?",
    headline: "Every sale, last 12 months.",
    accent: "sale",
    camera: { center, zoomDelta: 0.05, pitch: base.pitch, bearing: base.bearing },
    layers: ["sales"],
    labels: saleLabels(data),
    stats: [
      { label: "Median sale price", value: money(all.medianPrice), note: `${count(all.count)} sales · ${money(all.p25Price)} to ${money(all.p75Price)} middle half` },
      { label: "Price per sq ft", value: all.medianPpsf ? `$${Math.round(all.medianPpsf)}` : "—", note: `typical home ${count(all.medianSqft)} sq ft` },
      { label: "Houses", value: money(market.houses?.medianPrice), note: market.houses ? `${count(market.houses.count)} sold` : undefined },
      { label: "Condos and townhomes", value: money(market.condos?.medianPrice), note: market.condos ? `${count(market.condos.count)} sold` : undefined },
      { label: "Days to go pending", value: days(all.medianDom), note: all.shareOverList != null ? `${percent(all.shareOverList)} sold over asking` : undefined },
      ...(payment ? [{ label: "Monthly payment at the median", value: `${money(payment.monthly, false)}`, note: `20% down, ${payment.rate.toFixed(2)}% 30-year (Freddie Mac, week of ${payment.week})`, tone: "lime" as Tone }] : []),
    ],
    height: 1.6,
    sources: [data.sources.sales],
  });

  const trend = market.trend;
  const census = data.census;
  const rentals = market.rentals;
  chapters.push({
    id: "trend",
    kind: "story",
    question: "Where are prices heading?",
    headline: trend?.change10y != null ? `${signedPercent(trend.change10y)} in ten years.` : "The longer view.",
    accent: trend?.change10y != null ? signedPercent(trend.change10y) : undefined,
    camera: { center: [center[0] + 0.004, center[1] - 0.002], zoomDelta: -0.2, pitch: base.pitch - 5, bearing: base.bearing + 40 },
    layers: ["sales"],
    labels: [],
    stats: [
      ...(trend ? [{ label: "House price index, ten years", value: `${signedPercent(trend.change5y)} in five`, note: `${trend.label}, FHFA, through ${trend.latestYear}`, series: trend.series, tone: "lime" as Tone }] : []),
      ...(rentals ? [{ label: "Median rent", value: `${money(rentals.medianRent, false)}/mo`, note: `${count(rentals.count)} leases · 2 bd ${money(rentals.byBeds["2"]?.medianRent, false)} · 3 bd ${money(rentals.byBeds["3"]?.medianRent, false)}` }] : []),
      ...(census ? [
        { label: "Own vs rent", value: `${percent(census.ownerShare)} own`, note: `median household income ${money(census.medianIncome)}` },
        { label: "Median age", value: census.medianAge ? `${Math.round(census.medianAge)}` : "—", note: `${count(census.population)} residents in ${census.zips.length} ZIP${census.zips.length > 1 ? "s" : ""}` },
        { label: "Work from home", value: percent(census.commute.workFromHome), note: `${percent(census.commute.drove)} drive · ${percent(census.commute.transit)} transit · ${percent(census.commute.walked)} walk` },
      ] : []),
    ],
    height: 1.3,
    sources: [trend?.source, census?.source].filter((s): s is string => Boolean(s)),
  });

  const pois = data.pois;
  const poiCenter = meanPoint([...(pois?.categories.cafe ?? []), ...(pois?.categories.grocery ?? []), ...(pois?.categories.rail ?? [])]) ?? center;
  const walk = data.walkability;
  chapters.push({
    id: "places",
    kind: "story",
    question: "What's within reach?",
    headline: "Groceries, parks, trains, coffee.",
    accent: "reach",
    camera: { center: [(poiCenter[0] + center[0]) / 2, (poiCenter[1] + center[1]) / 2], zoomDelta: 0.35, pitch: base.pitch + 4, bearing: base.bearing - 15 },
    layers: ["parks", "walk", "pois-rail", "pois-grocery", "pois-cafe", "pois-park"],
    labels: placeLabels(data),
    stats: [
      ...(pois ? [
        { label: "Homes within a 10-minute walk of a grocery store", value: percent(pois.stats.shareNearGrocery800m), tone: "lime" as Tone },
        { label: "Homes within 5 minutes of a park", value: percent(pois.stats.shareNearPark400m) },
        ...(pois.stats.counts.rail ? [{ label: "Homes within a 10-minute walk of rail", value: percent(pois.stats.shareNearRail800m), note: `${pois.stats.counts.rail} stations` }] : []),
        ...(pois.stats.counts.beach ? [{ label: "Homes within a mile of the beach", value: percent(pois.stats.shareNearBeach1600m) }] : []),
        { label: "Cafés · restaurants · bars", value: `${count(pois.stats.counts.cafe)} · ${count(pois.stats.counts.restaurant)} · ${count(pois.stats.counts.bar)}`, note: `${count(pois.stats.counts.grocery)} grocery stores · ${count(pois.stats.counts.park)} parks · ${count(pois.stats.counts.gym)} gyms` },
      ] : []),
      ...(walk?.medianAtHomes != null ? [{ label: "Walkability", value: `${walk.medianAtHomes.toFixed(1)} / 20`, note: `${percent(walk.shareWalkable)} of homes in a "most walkable" block group (EPA)` }] : []),
    ],
    height: 1.6,
    sources: [pois?.source, walk?.source].filter((s): s is string => Boolean(s)),
  });

  const publicSchools = data.schools.filter((s) => s.public);
  const schoolCenter = meanPoint(publicSchools) ?? center;
  const districts = [...new Set(publicSchools.map((s) => s.district))];
  chapters.push({
    id: "schools",
    kind: "story",
    question: "Where would the kids go to school?",
    headline: "Public schools, by the numbers.",
    accent: "schools",
    camera: { center: [(schoolCenter[0] + center[0]) / 2, (schoolCenter[1] + center[1]) / 2], zoomDelta: 0.2, pitch: base.pitch, bearing: base.bearing + 20 },
    layers: ["zones", "schools"],
    labels: schoolLabels(data.schools),
    stats: [
      { label: "Public schools in the area", value: count(publicSchools.length), note: districts.length ? districts.join(" · ") : undefined },
      { label: "Elementary · middle · high", value: `${publicSchools.filter((s) => s.type === "Elementary").length} · ${publicSchools.filter((s) => s.type === "Middle").length} · ${publicSchools.filter((s) => s.type === "High").length}` },
      { label: "Students enrolled", value: count(publicSchools.reduce((sum, s) => sum + (s.enrollment ?? 0), 0)) },
      { label: "Charter · magnet", value: `${publicSchools.filter((s) => s.charter).length} · ${publicSchools.filter((s) => s.magnet).length}`, note: data.zones ? "Attendance zones outlined" : "Ratings not shown: no reliable free source" },
    ],
    height: 1.5,
    sources: [data.sources.schools],
  });

  const hazards = data.hazards;
  const noise = data.noise;
  const riskCenter = (() => {
    const flood = largestFeature(hazards.flood, (f) => f.properties.cls === "sfha");
    const anchor = flood ? featureAnchor(flood) : null;
    return anchor ? ([(anchor[0] + center[0]) / 2, (anchor[1] + center[1]) / 2] as [number, number]) : center;
  })();
  const riskStat = (value: number | null | undefined, label: string, tone?: Tone): Stat => ({
    label,
    value: value == null ? "Not available" : value === 0 ? "None" : percent(value, value < 0.01 ? 1 : 0),
    tone: value ? tone : undefined,
  });
  chapters.push({
    id: "risks",
    kind: "story",
    question: "What are the risks?",
    headline: "Flood, fire, quake, noise.",
    accent: "risks",
    camera: { center: riskCenter, zoomDelta: -0.1, pitch: base.pitch - 8, bearing: base.bearing + 55 },
    layers: ["flood", "fire", "liquefaction", "landslide", "fault", "noise"],
    labels: riskLabels(data),
    stats: [
      riskStat(hazards.stats.shareInFloodZone, "Homes sold in a FEMA flood zone", "blue"),
      riskStat(hazards.stats.shareInFireZone, "In a fire hazard severity zone", "orange"),
      riskStat(hazards.stats.shareInLiquefaction, "In a liquefaction zone", "purple"),
      riskStat(hazards.stats.shareInLandslide, "In a landslide zone", "orange"),
      ...(noise?.stats.shareLoud != null ? [{ label: "Homes with 60+ dB road, rail or air noise", value: percent(noise.stats.shareLoud), note: `${percent(noise.stats.shareQuiet)} are under 50 dB (quiet)`, tone: noise.stats.shareLoud > 0.2 ? ("red" as Tone) : undefined }] : []),
    ],
    height: 1.6,
    sources: [hazards.source.flood, hazards.source.fire, hazards.source.seismic, noise?.source].filter((s): s is string => Boolean(s)),
  });

  const permits = data.permits;
  if (permits && permits.count12m >= 20) {
    chapters.push({
      id: "permits",
      kind: "story",
      question: "What's being built?",
      headline: "Permits pulled this year.",
      accent: "built",
      camera: { center, zoomDelta: 0.15, pitch: base.pitch + 2, bearing: base.bearing - 40 },
      layers: ["permits"],
      labels: permitLabels(data),
      stats: [
        { label: "Permits, last 12 months", value: count(permits.count12m), tone: "lime" },
        { label: "New homes", value: count(permits.byGroup["New homes"]), note: `${count(permits.adu)} with an ADU` },
        { label: "Additions · remodels", value: `${count(permits.byGroup["Additions"])} · ${count(permits.byGroup["Remodels and repairs"])}` },
        { label: "Pools · solar", value: `${count(permits.byGroup["Pools and spas"])} · ${count(permits.byGroup["Solar"])}` },
        ...(permits.medianValuation ? [{ label: "Median project value", value: money(permits.medianValuation, false) }] : []),
      ],
      height: 1.4,
      sources: [permits.source],
    });
  }

  chapters.push({
    id: "closing",
    kind: "closing",
    headline: `Ready to look at homes in ${data.name}?`,
    accent: data.name,
    body: "Every number on this page came from public records, the MLS and open data. Snaphomz puts the same intelligence behind each listing.",
    camera: { center, zoomDelta: -0.45, pitch: Math.max(40, base.pitch - 18), bearing: base.bearing + 90 },
    layers: ["sales"],
    labels: [],
    stats: [],
    height: 1,
  });

  return chapters;
}
