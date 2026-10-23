/** Shape of public/data/<slug>.json, written by scripts/build_neighborhood.py. */

export type FeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: Record<string, unknown>;
    geometry: { type: string; coordinates: unknown } | null;
  }>;
};

export type MarketSummary = {
  count: number;
  medianPrice: number;
  p25Price: number;
  p75Price: number;
  medianPpsf: number | null;
  medianSqft: number | null;
  medianDom: number | null;
  medianSaleToList: number | null;
  shareOverList: number | null;
  medianYearBuilt: number | null;
};

export type Poi = { name: string; lat: number; lon: number; brand: string | null };

export type School = {
  name: string;
  district: string;
  type: string;
  level: string;
  grades: string;
  charter: boolean;
  magnet: boolean;
  enrollment: number | null;
  lat: number;
  lon: number;
  public: boolean;
};

export type Neighborhood = {
  slug: string;
  name: string;
  region: string;
  tagline: string;
  zips: string[];
  camera: { bearing?: number; pitch?: number };
  center: [number, number];
  bounds: [[number, number], [number, number]];
  builtAt: string;
  market: {
    all: MarketSummary;
    houses: MarketSummary | null;
    condos: MarketSummary | null;
    monthly: Array<{ month: string; count: number; medianPrice: number }>;
    window: { from: string; to: string };
    daysSinceLatest: number;
    paymentAtMedian?: { rate: number; down: number; monthly: number; week: string };
    trend: {
      label: string;
      series: Array<{ year: number; index: number }>;
      change5y: number | null;
      change10y: number | null;
      latestYear: number;
      source: string;
    } | null;
    rentals: {
      count: number;
      medianRent: number;
      byBeds: Record<string, { count: number; medianRent: number }>;
    } | null;
  };
  /** [lon, lat, price, sqft, kind (0 house, 1 condo, 2 other), beds, monthsAgo, listingId ("" when unknown)] */
  sales: Array<[number, number, number, number, number, number, number, string]>;
  schools: School[];
  zones: FeatureCollection | null;
  permits: {
    count12m: number;
    byGroup: Record<string, number>;
    adu: number;
    medianValuation: number | null;
    points: Array<[number, number, string]>;
    source: string;
  } | null;
  noise: {
    cell: number;
    cells: Array<[number, number, number]>;
    stats: { shareQuiet: number | null; shareLoud: number | null; medianDb: number | null };
    source: string;
  } | null;
  pois: {
    categories: Record<string, Poi[]>;
    stats: {
      shareNearGrocery800m: number | null;
      shareNearPark400m: number | null;
      shareNearRail800m: number | null;
      shareNearCafe400m: number | null;
      shareNearBeach1600m: number | null;
      counts: Record<string, number>;
    };
    parks: FeatureCollection | null;
    source: string;
  } | null;
  hazards: {
    flood: FeatureCollection | null;
    fire: FeatureCollection | null;
    liquefaction: FeatureCollection | null;
    landslide: FeatureCollection | null;
    fault: FeatureCollection | null;
    stats: Record<string, number | null>;
    source: Record<string, string>;
  };
  walkability: {
    polygons: FeatureCollection;
    medianAtHomes: number | null;
    shareWalkable: number | null;
    source: string;
  } | null;
  census: {
    population: number;
    medianIncome: number | null;
    ownerShare: number | null;
    medianAge: number | null;
    medianHomeValue: number | null;
    medianGrossRent: number | null;
    commute: { drove: number; transit: number; walked: number; workFromHome: number };
    zips: string[];
    source: string;
  } | null;
  /** Driving routes along real streets from the centre, OSRM without traffic. */
  routes: Route[] | null;
  sources: Record<string, string>;
};

export type Route = {
  to: string;
  /** Short form for headlines ("Downtown"); falls back to `to`. */
  label?: string;
  /** "core" is the job centre the commute headline is about; "city" is a plain destination. */
  kind: "core" | "airport" | "beach" | "city";
  lon: number;
  lat: number;
  km: number;
  minutes: number;
  line: Array<[number, number]>;
};

export type IndexEntry = {
  slug: string;
  name: string;
  region: string;
  center: [number, number];
  medianPrice: number;
  sales: number;
};
