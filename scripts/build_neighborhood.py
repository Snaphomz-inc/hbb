"""Build the data file behind each neighborhood flyover.

Reads the cleaned CMA database (sales, leases, schools, zones, permits, the
noise grid) and a handful of free public services (OpenStreetMap, FEMA flood
zones, CAL FIRE, the California Geological Survey, EPA walkability, Census
Reporter), and writes one JSON file per neighborhood into cities/<city>/data/.

A city is a folder under cities/: city.json (name, domain, commute destinations,
county FIPS, source labels) and neighborhoods.json (the areas to build).

Run from the project root with an isolated interpreter:

    python -I scripts/build_neighborhood.py [--city la] [--only santa-monica] [--offline]

Every outside request is cached under scripts/cache/, so a rebuild is free and
--offline builds from the cache alone. A source that fails is written as null
with a warning; it never silently becomes "no risk" or "no places".
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sqlite3
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
WORKSPACE = ROOT.parent
CMA_DB = WORKSPACE / "parcel-package" / "re_superapp" / "data" / "cma-local.db"
DEV_DB = WORKSPACE / "parcel-package" / "re_superapp" / "data" / "dev.db"
CACHE = HERE / "cache"
CITIES = ROOT / "cities"
USER_AGENT = "snaphomz-neighborhood-aerial/1.0 (neighborhood guides; contact: snaphomz.com)"

CALFIRE = "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services"
CGS = "https://services2.arcgis.com/zr3KAIbsRSUyARHG/arcgis/rest/services"
LAYERS = {
    "flood": "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28",
    "fireState": f"{CALFIRE}/FHSZSRA_23_3/FeatureServer/0",
    "fireLocal": f"{CALFIRE}/FHSALRA25_v1_All/FeatureServer/0",
    "liquefaction": f"{CGS}/CGS_Liquefaction_Zones/FeatureServer/0",
    "landslide": f"{CGS}/CGS_Landslide_Zones/FeatureServer/0",
    "fault": f"{CGS}/CGS_Alquist_Priolo_Fault_Zones/FeatureServer/0",
    "walkability": "https://geodata.epa.gov/arcgis/rest/services/OA/WalkabilityIndex/MapServer/0",
}
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
CENSUS_REPORTER = "https://api.censusreporter.org/1.0/data/show/latest"
OSRM = "https://router.project-osrm.org/route/v1/driving"

# The city being built, from cities/<slug>/city.json (see load_city). Holds the commute
# destinations (kind "core", "airport", ...), the beaches (the nearer one is routed), the
# county FIPS for the price index fallback, the state, and the source labels.
CITY: dict = {}

OFFLINE = False
PAUSE = 1.0  # seconds between live requests; a full-county run makes a few hundred of them
WARNINGS: list[str] = []


def warn(message: str) -> None:
    WARNINGS.append(message)
    print(f"  warning: {message}", file=sys.stderr)


def load_city(slug: str) -> dict:
    path = CITIES / slug / "city.json"
    if not path.exists():
        known = ", ".join(sorted(p.name for p in CITIES.iterdir() if (p / "city.json").exists())) if CITIES.exists() else "none"
        raise SystemExit(f"no city config at {path} (known cities: {known})")
    city = json.loads(path.read_text(encoding="utf-8"))
    for key in ("slug", "name", "domain", "sources"):
        if key not in city:
            raise SystemExit(f"{path}: missing '{key}'")
    city.setdefault("state", "CA")
    city.setdefault("destinations", [])
    city.setdefault("beaches", [])
    return city


# ---------------------------------------------------------------- fetching


def cache_path(key: str) -> Path:
    digest = hashlib.sha1(key.encode()).hexdigest()[:16]
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in key)[:60]
    return CACHE / f"{safe}-{digest}.json"


def fetch_json(key: str, url: str, data: bytes | None = None, timeout: int = 90, tries: int = 4):
    """GET or POST a JSON document, cached forever under scripts/cache/."""
    path = cache_path(key)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    if OFFLINE:
        raise RuntimeError(f"offline and not cached: {key}")
    last: Exception | None = None
    for attempt in range(tries):
        try:
            request = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read().decode("utf-8")
            parsed = json.loads(body)
            if isinstance(parsed, dict) and parsed.get("error"):
                raise RuntimeError(f"service error: {str(parsed['error'])[:200]}")
            CACHE.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(parsed), encoding="utf-8")
            time.sleep(PAUSE)
            return parsed
        except Exception as error:  # noqa: BLE001 - any failure is retried, then reported
            last = error
            time.sleep(4 * (attempt + 1))
    raise RuntimeError(f"{key}: {last}")


def arcgis_query(key: str, layer: str, bbox: tuple[float, float, float, float], out_fields: str, where: str = "1=1",
                 offset: float = 0.00003, geometry: bool = True) -> dict:
    """Features of an ArcGIS layer inside a lon/lat envelope, as GeoJSON, paged."""
    west, south, east, north = bbox
    key = f"{key}-{hashlib.sha1(repr([round(v, 4) for v in bbox]).encode()).hexdigest()[:6]}"
    features: list[dict] = []
    result_offset = 0
    while True:
        params = {
            "geometry": f"{west},{south},{east},{north}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "outSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "where": where,
            "outFields": out_fields,
            "returnGeometry": "true" if geometry else "false",
            "maxAllowableOffset": str(offset) if geometry else "",
            "geometryPrecision": "6",
            "resultOffset": str(result_offset),
            "resultRecordCount": "1000",
            "f": "geojson",
        }
        url = f"{layer}/query?{urllib.parse.urlencode({k: v for k, v in params.items() if v != ''})}"
        page = fetch_json(f"{key}-{result_offset}", url)
        got = page.get("features") or []
        features.extend(got)
        if not page.get("exceededTransferLimit") or not got:
            break
        result_offset += len(got)
    return {"type": "FeatureCollection", "features": features}


# ---------------------------------------------------------------- geometry


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def point_in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
    inside = False
    count = len(ring)
    j = count - 1
    for i in range(count):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat):
            x = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x:
                inside = not inside
        j = i
    return inside


def point_in_geometry(lon: float, lat: float, geometry: dict | None) -> bool:
    if not geometry:
        return False
    kind = geometry.get("type")
    polygons = geometry["coordinates"] if kind == "MultiPolygon" else [geometry["coordinates"]] if kind == "Polygon" else []
    for polygon in polygons:
        if not polygon:
            continue
        if point_in_ring(lon, lat, polygon[0]) and not any(point_in_ring(lon, lat, hole) for hole in polygon[1:]):
            return True
    return False


def geometry_bbox(geometry: dict | None) -> tuple[float, float, float, float] | None:
    if not geometry:
        return None
    kind = geometry.get("type")
    coords = geometry["coordinates"]
    rings = [ring for polygon in (coords if kind == "MultiPolygon" else [coords]) for ring in polygon] if kind in ("Polygon", "MultiPolygon") else []
    points = [point for ring in rings for point in ring]
    if not points:
        return None
    lons = [p[0] for p in points]
    lats = [p[1] for p in points]
    return (min(lons), min(lats), max(lons), max(lats))


def share_inside(points: list[tuple[float, float]], collection: dict | None, accept=lambda feature: True) -> float | None:
    """Share of points that fall in any accepted feature, or None when the layer failed."""
    if collection is None:
        return None
    features = [(f.get("geometry"), geometry_bbox(f.get("geometry"))) for f in collection["features"] if accept(f)]
    features = [(g, b) for g, b in features if b]
    if not points:
        return 0.0
    hits = 0
    for lon, lat in points:
        for geometry, (west, south, east, north) in features:
            if west <= lon <= east and south <= lat <= north and point_in_geometry(lon, lat, geometry):
                hits += 1
                break
    return hits / len(points)


def median(values: list[float]) -> float | None:
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else None


def percentile(values: list[float], share: float) -> float | None:
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    index = (len(values) - 1) * share
    low = math.floor(index)
    high = math.ceil(index)
    return values[low] + (values[high] - values[low]) * (index - low)


# ---------------------------------------------------------------- the neighborhood


HOUSE_SUBTYPES = {"Single Family Residence", "Manufactured Home"}
CONDO_SUBTYPES = {"Condominium", "Townhouse", "Stock Cooperative", "Own Your Own"}


def kind_of(subtype: str | None) -> int:
    if subtype in HOUSE_SUBTYPES:
        return 0
    if subtype in CONDO_SUBTYPES:
        return 1
    return 2


def area_filter(cities: list[str], zips: list[str], by_zip: bool) -> tuple[str, list[str]]:
    """SQL for "in this neighborhood": the MLS city name, narrowed to the listed ZIPs when the
    city is too big to be a neighborhood (the City of Los Angeles)."""
    clause = f"city IN ({','.join('?' for _ in cities)})"
    params = list(cities)
    if by_zip:
        clause += f" AND zip IN ({','.join('?' for _ in zips)})"
        params += list(zips)
    return clause, params


def load_sales(con: sqlite3.Connection, cities: list[str], zips: list[str], by_zip: bool = False) -> list[dict]:
    clause, params = area_filter(cities, zips, by_zip)
    rows = con.execute(
        f"""SELECT lat, lon, sold_price, list_price, living_sqft, beds, subtype, sold_date, dom, year_built, zip, listing_id
            FROM sales WHERE {clause} AND property_type != 'Residential Income'
              AND sold_price > 50000 AND lat IS NOT NULL AND lon IS NOT NULL""",
        params,
    ).fetchall()
    sales = [dict(zip(["lat", "lon", "price", "list", "sqft", "beds", "subtype", "date", "dom", "built", "zip", "listing"], row)) for row in rows]
    if not sales:
        return []
    # Trim mis-geocoded outliers: keep the 3rd to 97th percentile box, padded.
    # (A few "Manhattan Beach" closings geocode to Inglewood or Compton.)
    lats = [s["lat"] for s in sales]
    lons = [s["lon"] for s in sales]
    south, north = percentile(lats, 0.03), percentile(lats, 0.97)
    west, east = percentile(lons, 0.03), percentile(lons, 0.97)
    pad_lat = (north - south) * 0.05
    pad_lon = (east - west) * 0.05
    return [s for s in sales if south - pad_lat <= s["lat"] <= north + pad_lat and west - pad_lon <= s["lon"] <= east + pad_lon]


def bbox_of(sales: list[dict], pad: float = 0.006) -> tuple[float, float, float, float]:
    return (
        min(s["lon"] for s in sales) - pad,
        min(s["lat"] for s in sales) - pad,
        max(s["lon"] for s in sales) + pad,
        max(s["lat"] for s in sales) + pad,
    )


def market_stats(sales: list[dict], today: date) -> dict:
    def summary(group: list[dict]) -> dict | None:
        if not group:
            return None
        ppsf = [s["price"] / s["sqft"] for s in group if s["sqft"] and s["sqft"] > 200]
        ratios = [s["price"] / s["list"] for s in group if s["list"] and s["list"] > 0]
        return {
            "count": len(group),
            "medianPrice": median([s["price"] for s in group]),
            "p25Price": percentile([s["price"] for s in group], 0.25),
            "p75Price": percentile([s["price"] for s in group], 0.75),
            "medianPpsf": median(ppsf),
            "medianSqft": median([s["sqft"] for s in group if s["sqft"]]),
            "medianDom": median([s["dom"] for s in group if s["dom"] is not None]),
            "medianSaleToList": median(ratios),
            "shareOverList": (sum(1 for r in ratios if r > 1.0) / len(ratios)) if ratios else None,
            "medianYearBuilt": median([s["built"] for s in group if s["built"] and s["built"] > 1800]),
        }

    months: dict[str, list[dict]] = {}
    for s in sales:
        months.setdefault(s["date"][:7], []).append(s)
    monthly = [
        {"month": month, "count": len(group), "medianPrice": median([s["price"] for s in group])}
        for month, group in sorted(months.items())
    ][-12:]
    latest = max(s["date"] for s in sales)
    return {
        "all": summary(sales),
        "houses": summary([s for s in sales if kind_of(s["subtype"]) == 0]),
        "condos": summary([s for s in sales if kind_of(s["subtype"]) == 1]),
        "monthly": monthly,
        "window": {"from": min(s["date"] for s in sales), "to": latest},
        "daysSinceLatest": (today - date.fromisoformat(latest)).days,
    }


def compact_sales(sales: list[dict], today: date) -> list[list]:
    out = []
    for s in sales:
        months_ago = max(0, (today - date.fromisoformat(s["date"])).days // 30)
        out.append([round(s["lon"], 5), round(s["lat"], 5), int(s["price"]), int(s["sqft"] or 0), kind_of(s["subtype"]), s["beds"] or 0, months_ago,
                    str(s["listing"] or "")])
    return out


def load_rentals(con: sqlite3.Connection, cities: list[str], zips: list[str], by_zip: bool, bbox) -> dict | None:
    clause, params = area_filter(cities, zips, by_zip)
    rows = con.execute(f"SELECT rent, beds, lat, lon FROM leases WHERE {clause} AND rent BETWEEN 500 AND 60000", params).fetchall()
    rows = [r for r in rows if r[2] is not None and bbox[0] <= r[3] <= bbox[2] and bbox[1] <= r[2] <= bbox[3]]
    if not rows:
        return None
    by_beds = {}
    for beds in (1, 2, 3, 4):
        group = [r[0] for r in rows if (r[1] or 0) == beds] if beds < 4 else [r[0] for r in rows if (r[1] or 0) >= 4]
        if len(group) >= 5:
            by_beds[str(beds)] = {"count": len(group), "medianRent": median(group)}
    return {"count": len(rows), "medianRent": median([r[0] for r in rows]), "byBeds": by_beds}


def load_schools(con: sqlite3.Connection, bbox) -> list[dict]:
    west, south, east, north = bbox
    rows = con.execute(
        """SELECT name, district, type, level, grades, charter, magnet, enrollment, lat, lon, funding
           FROM schools WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND virtual IN ('N', 'C')
             AND type IN ('Elementary', 'Middle', 'High', 'K-12')""",
        (south, north, west, east),
    ).fetchall()
    schools = []
    for name, district, kind, level, grades, charter, magnet, enrollment, lat, lon, funding in rows:
        schools.append({
            "name": name, "district": district, "type": kind, "level": level, "grades": grades,
            "charter": bool(charter), "magnet": bool(magnet), "enrollment": enrollment, "lat": lat, "lon": lon,
            # The CDE directory holds public schools only; funding marks charters.
            "public": True,
            "cds": None,
        })
    return schools


def load_zones(con: sqlite3.Connection, bbox, schools: list[dict]) -> dict | None:
    west, south, east, north = bbox
    rows = con.execute(
        """SELECT level, code, cds, geometry FROM school_zones
           WHERE level = 'elementary' AND max_lon >= ? AND min_lon <= ? AND max_lat >= ? AND min_lat <= ?""",
        (west, east, south, north),
    ).fetchall()
    if not rows:
        return None
    by_cds = {s.get("cds"): s for s in schools if s.get("cds")}
    features = []
    for level, code, cds, geometry in rows:
        name = None
        if cds:
            match = con.execute("SELECT name FROM schools WHERE cds = ?", (cds,)).fetchone()
            name = match[0] if match else None
        features.append({"type": "Feature", "properties": {"level": level, "code": code, "name": name}, "geometry": json.loads(geometry)})
    del by_cds
    return {"type": "FeatureCollection", "features": features}


PERMIT_GROUPS = [
    ("New homes", lambda t, s, u, w: t == "Bldg-New" and ("DWELLING" in u.upper() or "ADU" in w.upper() or "RESIDEN" in u.upper())),
    ("Additions", lambda t, s, u, w: t == "Bldg-Addition"),
    ("Pools and spas", lambda t, s, u, w: t == "Swimming-Pool/Spa"),
    ("Solar", lambda t, s, u, w: "SOLAR" in w.upper() or "PHOTOVOLTAIC" in w.upper()),
    ("Remodels and repairs", lambda t, s, u, w: t == "Bldg-Alter/Repair"),
    ("Demolitions", lambda t, s, u, w: t == "Bldg-Demolition"),
]


def load_permits(con: sqlite3.Connection, bbox, zips: list[str], today: date) -> dict | None:
    """Permits in the neighborhood's own ZIP codes (the box would pull in neighbouring cities)."""
    west, south, east, north = bbox
    since = (today - timedelta(days=365)).isoformat()
    marks = ",".join("?" for _ in zips)
    rows = con.execute(
        f"""SELECT permit_type, sub_type, use_desc, work_desc, lat, lon, adu_changed, valuation FROM permits
           WHERE zip IN ({marks}) AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND issue_date >= ?""",
        (*zips, south, north, west, east, since),
    ).fetchall()
    if not rows:
        return None
    groups = {name: 0 for name, _ in PERMIT_GROUPS}
    points = []
    adu = 0
    for permit_type, sub_type, use_desc, work_desc, lat, lon, adu_changed, valuation in rows:
        label = "Other"
        for name, test in PERMIT_GROUPS:
            if test(permit_type or "", sub_type or "", use_desc or "", work_desc or ""):
                label = name
                groups[name] += 1
                break
        if adu_changed:
            adu += 1
        points.append([round(lon, 5), round(lat, 5), label])
    return {
        "count12m": len(rows),
        "byGroup": groups,
        "adu": adu,
        "medianValuation": median([r[7] for r in rows if r[7] and r[7] > 1000]),
        "points": points[:1500],
        "source": CITY["sources"].get("permits", "Building permits issued in the last 12 months"),
    }


def load_noise(con: sqlite3.Connection, bbox, sales: list[dict]) -> dict | None:
    row = con.execute("SELECT west, north, cell, width, height, data FROM rasters WHERE name = 'noise'").fetchone()
    if not row:
        return None
    west, north, cell, width, height, blob = row
    grid = zlib.decompress(blob)

    def at(lat: float, lon: float) -> int:
        col = int((lon - west) / cell)
        line = int((north - lat) / cell)
        if col < 0 or line < 0 or col >= width or line >= height:
            return 0
        return grid[line * width + col]

    readings = [at(s["lat"], s["lon"]) for s in sales]
    modelled = [r for r in readings if r > 0]
    quiet = sum(1 for r in readings if r < 50)
    loud = sum(1 for r in readings if r >= 60)
    # A coarse overlay of the noisier cells for the map: 3x3 blocks, max value.
    cells = []
    step = 3
    bw, bs, be, bn = bbox
    col0 = max(0, int((bw - west) / cell))
    col1 = min(width, int((be - west) / cell) + 1)
    row0 = max(0, int((north - bn) / cell))
    row1 = min(height, int((north - bs) / cell) + 1)
    for line in range(row0, row1, step):
        for col in range(col0, col1, step):
            value = 0
            for dl in range(step):
                for dc in range(step):
                    l2, c2 = line + dl, col + dc
                    if l2 < height and c2 < width:
                        value = max(value, grid[l2 * width + c2])
            if value >= 55:
                cells.append([round(west + (col + step / 2) * cell, 5), round(north - (line + step / 2) * cell, 5), value])
    return {
        "cell": cell * step,
        "cells": cells,
        "stats": {
            "shareQuiet": quiet / len(readings) if readings else None,
            "shareLoud": loud / len(readings) if readings else None,
            "medianDb": median(modelled) if modelled else None,
        },
        "source": "U.S. DOT Bureau of Transportation Statistics, National Transportation Noise Map 2022",
    }


POI_RULES = [
    ("grocery", lambda t: t.get("shop") in ("supermarket", "greengrocer", "grocery")),
    ("cafe", lambda t: t.get("amenity") == "cafe"),
    ("restaurant", lambda t: t.get("amenity") == "restaurant"),
    ("bar", lambda t: t.get("amenity") in ("bar", "pub")),
    ("park", lambda t: t.get("leisure") == "park"),
    ("beach", lambda t: t.get("natural") == "beach"),
    ("playground", lambda t: t.get("leisure") == "playground"),
    ("dogpark", lambda t: t.get("leisure") == "dog_park"),
    ("rail", lambda t: t.get("railway") in ("station", "halt") or t.get("station") in ("light_rail", "subway")),
    ("bus", lambda t: t.get("highway") == "bus_stop"),
    ("gym", lambda t: t.get("leisure") == "fitness_centre"),
    ("pharmacy", lambda t: t.get("amenity") == "pharmacy"),
    ("library", lambda t: t.get("amenity") == "library"),
    ("hospital", lambda t: t.get("amenity") == "hospital"),
    ("market", lambda t: t.get("amenity") == "marketplace"),
]
POI_QUERY = """[out:json][timeout:90];
(
  nwr["shop"~"^(supermarket|greengrocer|grocery)$"]({bbox});
  nwr["amenity"~"^(cafe|restaurant|bar|pub|pharmacy|library|hospital|marketplace)$"]({bbox});
  nwr["leisure"~"^(park|playground|dog_park|fitness_centre)$"]({bbox});
  nwr["natural"="beach"]({bbox});
  nwr["railway"~"^(station|halt)$"]({bbox});
  nwr["station"~"^(light_rail|subway)$"]({bbox});
  nwr["highway"="bus_stop"]({bbox});
);
out center tags;"""
PARK_QUERY = """[out:json][timeout:90];
(
  way["leisure"="park"]({bbox});
  way["natural"="beach"]({bbox});
);
out geom;"""


def overpass(key: str, query: str) -> dict:
    last: Exception | None = None
    for endpoint in OVERPASS:
        try:
            return fetch_json(key, endpoint, data=urllib.parse.urlencode({"data": query}).encode(), timeout=150, tries=2)
        except Exception as error:  # noqa: BLE001
            last = error
    raise RuntimeError(f"overpass: {last}")


def load_pois(slug: str, bbox, sales: list[dict]) -> dict | None:
    west, south, east, north = bbox
    box = f"{south},{west},{north},{east}"
    tag = hashlib.sha1(box.encode()).hexdigest()[:6]
    try:
        raw = overpass(f"{slug}-pois-{tag}", POI_QUERY.format(bbox=box))
    except Exception as error:  # noqa: BLE001
        warn(f"{slug}: places failed ({error})")
        return None
    categories: dict[str, list[dict]] = {name: [] for name, _ in POI_RULES}
    for element in raw.get("elements", []):
        tags = element.get("tags") or {}
        lat = element.get("lat") or (element.get("center") or {}).get("lat")
        lon = element.get("lon") or (element.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue
        for name, test in POI_RULES:
            if test(tags):
                categories[name].append({"name": tags.get("name") or "", "lat": round(lat, 5), "lon": round(lon, 5), "brand": tags.get("brand") or None})
                break
    # Beach polygons as areas (an OSM beach may be a way without a name).
    parks = None
    try:
        raw_parks = overpass(f"{slug}-parks-{tag}", PARK_QUERY.format(bbox=box))
        features = []
        for element in raw_parks.get("elements", []):
            geometry = element.get("geometry") or []
            if len(geometry) < 4:
                continue
            ring = [[round(p["lon"], 5), round(p["lat"], 5)] for p in geometry]
            if ring[0] != ring[-1]:
                ring.append(ring[0])
            tags = element.get("tags") or {}
            features.append({"type": "Feature", "properties": {"name": tags.get("name") or "", "kind": "beach" if tags.get("natural") == "beach" else "park"}, "geometry": {"type": "Polygon", "coordinates": [ring]}})
        parks = {"type": "FeatureCollection", "features": features}
    except Exception as error:  # noqa: BLE001
        warn(f"{slug}: park outlines failed ({error})")

    def nearest(points: list[dict], lat: float, lon: float) -> float | None:
        return min((haversine_m(lat, lon, p["lat"], p["lon"]) for p in points), default=None)

    def share_within(category: str, metres: float) -> float | None:
        points = categories[category]
        if not points or not sales:
            return None
        return sum(1 for s in sales if (nearest(points, s["lat"], s["lon"]) or 1e9) <= metres) / len(sales)

    stats = {
        "shareNearGrocery800m": share_within("grocery", 800),
        "shareNearPark400m": share_within("park", 400),
        "shareNearRail800m": share_within("rail", 800),
        "shareNearCafe400m": share_within("cafe", 400),
        "shareNearBeach1600m": share_within("beach", 1600),
        "counts": {name: len(points) for name, points in categories.items()},
    }
    trimmed = {name: (points if name not in ("bus", "restaurant", "cafe", "bar") else points[:400]) for name, points in categories.items()}
    return {"categories": trimmed, "stats": stats, "parks": parks, "source": "OpenStreetMap contributors (ODbL)"}


def load_hazards(slug: str, bbox, sales: list[dict]) -> dict:
    points = [(s["lon"], s["lat"]) for s in sales]
    out: dict = {"stats": {}, "source": {
        "flood": "FEMA National Flood Hazard Layer",
        "fire": "CAL FIRE Fire Hazard Severity Zones (state and local responsibility areas)",
        "seismic": "California Geological Survey seismic hazard and Alquist-Priolo zones",
    }}
    try:
        flood = arcgis_query(f"{slug}-flood", LAYERS["flood"], bbox, "FLD_ZONE,ZONE_SUBTY,SFHA_TF", offset=0.00005)
        for feature in flood["features"]:
            props = feature["properties"]
            subtype = str(props.get("ZONE_SUBTY") or "")
            props["cls"] = "sfha" if props.get("SFHA_TF") == "T" else "moderate" if "0.2 PCT" in subtype.upper() else "minimal"
        flood["features"] = [f for f in flood["features"] if f["properties"]["cls"] != "minimal"]
        out["flood"] = flood
        out["stats"]["shareInFloodZone"] = share_inside(points, flood, lambda f: f["properties"]["cls"] == "sfha")
        out["stats"]["shareInModerateFlood"] = share_inside(points, flood, lambda f: f["properties"]["cls"] == "moderate")
    except Exception as error:  # noqa: BLE001
        warn(f"{slug}: flood zones failed ({error})")
        out["flood"] = None
    california = CITY.get("state", "CA") == "CA"
    if not california:
        warn(f"{slug}: fire and seismic hazard layers are California-only; written as null for {CITY['state']}")
    fire_features = []
    fire_ok = california
    for name in ("fireState", "fireLocal") if california else ():
        try:
            layer = arcgis_query(f"{slug}-{name}", LAYERS[name], bbox, "FHSZ,FHSZ_Description", offset=0.00005)
            for feature in layer["features"]:
                code = feature["properties"].get("FHSZ")
                try:
                    code = int(code)
                except (TypeError, ValueError):
                    code = 0
                if 1 <= code <= 3:
                    feature["properties"] = {"severity": code, "area": "state" if name == "fireState" else "local"}
                    fire_features.append(feature)
        except Exception as error:  # noqa: BLE001
            fire_ok = False
            warn(f"{slug}: {name} failed ({error})")
    fire = {"type": "FeatureCollection", "features": fire_features} if fire_ok else None
    out["fire"] = fire
    out["stats"]["shareInFireZone"] = share_inside(points, fire)
    out["stats"]["shareInHighFireZone"] = share_inside(points, fire, lambda f: f["properties"]["severity"] >= 2)
    for name in ("liquefaction", "landslide", "fault"):
        if not california:
            out[name] = None
            out["stats"][f"shareIn{name.capitalize()}"] = None
            continue
        try:
            layer = arcgis_query(f"{slug}-{name}", LAYERS[name], bbox, "OBJECTID", offset=0.00005)
            for feature in layer["features"]:
                feature["properties"] = {"kind": name}
            out[name] = layer
            out["stats"][f"shareIn{name.capitalize()}"] = share_inside(points, layer)
        except Exception as error:  # noqa: BLE001
            warn(f"{slug}: {name} failed ({error})")
            out[name] = None
            out["stats"][f"shareIn{name.capitalize()}"] = None
    return out


def load_walkability(slug: str, bbox, sales: list[dict]) -> dict | None:
    try:
        layer = arcgis_query(f"{slug}-walk", LAYERS["walkability"], bbox, "GEOID10,NatWalkInd,D3B,D4A", offset=0.00008)
    except Exception as error:  # noqa: BLE001
        warn(f"{slug}: walkability failed ({error})")
        return None
    scored = []
    for feature in layer["features"]:
        value = feature["properties"].get("NatWalkInd")
        feature["properties"] = {"walk": round(float(value), 2) if value is not None else None}
    # Score each sale by its block group, so the headline matches where homes actually are.
    indexed = [(f["geometry"], geometry_bbox(f["geometry"]), f["properties"]["walk"]) for f in layer["features"] if f["properties"]["walk"] is not None]
    for s in sales:
        for geometry, box, walk in indexed:
            if box and box[0] <= s["lon"] <= box[2] and box[1] <= s["lat"] <= box[3] and point_in_geometry(s["lon"], s["lat"], geometry):
                scored.append(walk)
                break
    return {
        "polygons": layer,
        "medianAtHomes": median(scored),
        "shareWalkable": (sum(1 for w in scored if w >= 13) / len(scored)) if scored else None,
        "source": "EPA National Walkability Index (1 to 20, block groups)",
    }


CENSUS_TABLES = ["B01003", "B19013", "B25003", "B01002", "B08301", "B25077", "B25064"]


def load_census(slug: str, zips: list[str]) -> dict | None:
    geo_ids = ",".join(f"86000US{z}" for z in zips)
    url = f"{CENSUS_REPORTER}?table_ids={','.join(CENSUS_TABLES)}&geo_ids={geo_ids}"
    try:
        payload = fetch_json(f"{slug}-census", url)
    except Exception as error:  # noqa: BLE001
        warn(f"{slug}: census failed ({error})")
        return None
    data = payload.get("data") or {}

    def estimate(geo: str, table: str, column: str) -> float | None:
        try:
            value = data[geo][table]["estimate"][column]
            return float(value) if value is not None else None
        except (KeyError, TypeError, ValueError):
            return None

    rows = []
    for z in zips:
        geo = f"86000US{z}"
        if geo not in data:
            continue
        pop = estimate(geo, "B01003", "B01003001") or 0
        rows.append({
            "zip": z, "population": pop,
            "income": estimate(geo, "B19013", "B19013001"),
            "ownerShare": (estimate(geo, "B25003", "B25003002") or 0) / (estimate(geo, "B25003", "B25003001") or 1),
            "age": estimate(geo, "B01002", "B01002001"),
            "value": estimate(geo, "B25077", "B25077001"),
            "rent": estimate(geo, "B25064", "B25064001"),
            "workers": estimate(geo, "B08301", "B08301001") or 0,
            "drove": estimate(geo, "B08301", "B08301002") or 0,
            "transit": estimate(geo, "B08301", "B08301010") or 0,
            "walked": estimate(geo, "B08301", "B08301019") or 0,
            "wfh": estimate(geo, "B08301", "B08301021") or 0,
        })
    if not rows:
        return None
    total_pop = sum(r["population"] for r in rows) or 1
    workers = sum(r["workers"] for r in rows) or 1

    def weighted(key: str) -> float | None:
        pairs = [(r[key], r["population"]) for r in rows if r[key] is not None]
        weight = sum(p for _, p in pairs)
        return sum(v * p for v, p in pairs) / weight if weight else None

    return {
        "population": total_pop,
        "medianIncome": weighted("income"),
        "ownerShare": weighted("ownerShare"),
        "medianAge": weighted("age"),
        "medianHomeValue": weighted("value"),
        "medianGrossRent": weighted("rent"),
        "commute": {
            "drove": sum(r["drove"] for r in rows) / workers,
            "transit": sum(r["transit"] for r in rows) / workers,
            "walked": sum(r["walked"] for r in rows) / workers,
            "workFromHome": sum(r["wfh"] for r in rows) / workers,
        },
        "zips": [r["zip"] for r in rows],
        "source": "U.S. Census Bureau, American Community Survey 5-year, by ZIP code tabulation area (via Census Reporter)",
    }


def load_trend(dev: sqlite3.Connection | None, zips: list[str]) -> dict | None:
    if dev is None:
        return None
    series: dict[int, list[float]] = {}
    used = []
    for z in zips:
        rows = dev.execute("SELECT year, hpi FROM hpi_zip5 WHERE zip = ? ORDER BY year", (z,)).fetchall()
        if rows and rows[-1][0] >= 2024 and len(rows) >= 11:
            used.append(z)
            for year, hpi in rows:
                series.setdefault(year, []).append(hpi)
    label = f"ZIP codes {', '.join(used)}" if used else f"{CITY['name']} County"
    if not used and CITY.get("countyFips"):
        rows = dev.execute("SELECT year, hpi FROM hpi_county WHERE fips = ? ORDER BY year", (CITY["countyFips"],)).fetchall()
        for year, hpi in rows:
            series.setdefault(year, []).append(hpi)
    if not series:
        return None
    points = [{"year": year, "index": statistics.mean(values)} for year, values in sorted(series.items())]
    latest = points[-1]
    by_year = {p["year"]: p["index"] for p in points}

    def change(years: int) -> float | None:
        base = by_year.get(latest["year"] - years)
        return latest["index"] / base - 1 if base else None

    window = [p for p in points if p["year"] >= latest["year"] - 10]
    return {"label": label, "series": window, "change5y": change(5), "change10y": change(10), "latestYear": latest["year"],
            "source": "FHFA House Price Index, annual"}


def load_mortgage(dev: sqlite3.Connection | None) -> dict | None:
    if dev is None:
        return None
    row = dev.execute("SELECT payload FROM mortgage_rates ORDER BY id DESC LIMIT 1").fetchone()
    if not row:
        return None
    payload = json.loads(row[0])
    return {"week": payload.get("week"), "rate30": payload.get("rate30"), "rate15": payload.get("rate15"),
            "source": "Freddie Mac Primary Mortgage Market Survey"}


def payment(price: float, rate: float, down: float = 0.2, years: int = 30) -> float:
    principal = price * (1 - down)
    monthly = rate / 100 / 12
    n = years * 12
    return principal * monthly / (1 - (1 + monthly) ** -n)


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    from math import asin, cos, radians, sin, sqrt
    dlat = radians(b[1] - a[1])
    dlon = radians(b[0] - a[0])
    h = sin(dlat / 2) ** 2 + cos(radians(a[1])) * cos(radians(b[1])) * sin(dlon / 2) ** 2
    return 2 * 6371 * asin(sqrt(h))


def load_routes(slug: str, center: list[float]) -> list[dict] | None:
    """Driving routes along real streets from the neighborhood centre to each destination (OSRM, no traffic)."""
    destinations = [dict(d) for d in CITY["destinations"]]
    if CITY["beaches"]:
        beach = min(CITY["beaches"], key=lambda b: haversine_km((center[0], center[1]), (b["lon"], b["lat"])))
        destinations.append({**beach, "kind": "beach"})
    if not destinations:
        return None
    routes = []
    for dest in destinations:
        try:
            url = f"{OSRM}/{center[0]},{center[1]};{dest['lon']},{dest['lat']}?overview=full&geometries=geojson"
            raw = fetch_json(f"{slug}-route-full-{dest['name']}", url)
            route = raw["routes"][0]
        except Exception as error:  # noqa: BLE001
            warn(f"{slug}: route to {dest['name']} failed: {str(error)[:120]}")
            return None
        routes.append({
            "to": dest["name"],
            "label": dest.get("label", dest["name"]),
            "kind": dest.get("kind", "city"),
            "lon": dest["lon"],
            "lat": dest["lat"],
            "km": round(route["distance"] / 1000, 1),
            "minutes": round(route["duration"] / 60),
            "line": [[round(lon, 5), round(lat, 5)] for lon, lat in route["geometry"]["coordinates"]],
        })
    return routes


def build(config: dict, con: sqlite3.Connection, dev: sqlite3.Connection | None, today: date) -> dict | None:
    slug = config["slug"]
    print(f"{config['name']}:")
    by_zip = bool(config.get("byZip"))
    sales = load_sales(con, config["cities"], config["zips"], by_zip)
    if len(sales) < 20:
        warn(f"{slug}: only {len(sales)} sales, skipped")
        return None
    bbox = bbox_of(sales)
    center = [round((bbox[0] + bbox[2]) / 2, 5), round((bbox[1] + bbox[3]) / 2, 5)]
    print(f"  {len(sales)} sales, box {bbox}")
    market = market_stats(sales, today)
    mortgage = load_mortgage(dev)
    if mortgage and mortgage.get("rate30") and market["all"]:
        market["paymentAtMedian"] = {
            "rate": mortgage["rate30"], "down": 0.2, "monthly": payment(market["all"]["medianPrice"], mortgage["rate30"]),
            "week": mortgage["week"],
        }
    market["trend"] = load_trend(dev, config["zips"])
    market["rentals"] = load_rentals(con, config["cities"], config["zips"], by_zip, bbox)
    schools = load_schools(con, bbox)
    print(f"  {len(schools)} schools")
    result = {
        "slug": slug,
        "name": config["name"],
        "region": config["region"],
        "tagline": config["tagline"],
        "zips": config["zips"],
        "camera": config.get("camera") or {},
        "center": center,
        "bounds": [[round(bbox[0], 5), round(bbox[1], 5)], [round(bbox[2], 5), round(bbox[3], 5)]],
        "builtAt": today.isoformat(),
        "market": market,
        "sales": compact_sales(sales, today),
        "schools": schools,
        "zones": load_zones(con, bbox, schools),
        "permits": load_permits(con, bbox, config["zips"], today),
        "noise": load_noise(con, bbox, sales),
        "pois": load_pois(slug, bbox, sales),
        "hazards": load_hazards(slug, bbox, sales),
        "walkability": load_walkability(slug, bbox, sales),
        "census": load_census(slug, config["zips"]),
        "routes": load_routes(slug, center),
        "sources": {
            "sales": "MLS closed sales, last 12 months, one row per sale (via the data extraction team)",
            "schools": CITY["sources"].get("schools", "State school directory and attendance zones"),
            "routes": "Driving routes and times without traffic: OSRM on OpenStreetMap",
        },
    }
    pois = result["pois"]
    if pois:
        print("  places: " + ", ".join(f"{k} {v}" for k, v in pois["stats"]["counts"].items() if v))
    print("  hazards: " + json.dumps({k: (round(v, 3) if isinstance(v, float) else v) for k, v in result["hazards"]["stats"].items()}))
    return result


def main() -> int:
    global OFFLINE, CITY
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--city", default="la", help="city folder under cities/ (default la)")
    parser.add_argument("--only", help="build one neighborhood by slug")
    parser.add_argument("--offline", action="store_true", help="use cached responses only")
    parser.add_argument("--skip-existing", action="store_true", help="leave neighborhoods that already have a data file alone")
    parser.add_argument("--db", default=str(CMA_DB), help="path to cma-local.db")
    parser.add_argument("--dev-db", default=str(DEV_DB), help="path to the link analyser's dev.db (price index, mortgage rates)")
    parser.add_argument("--out", help="output folder (default cities/<city>/data)")
    args = parser.parse_args()
    OFFLINE = args.offline
    CITY = load_city(args.city)
    print(f"city: {CITY['name']} ({args.city})")
    if not Path(args.db).exists():
        print(f"database not found: {args.db}", file=sys.stderr)
        return 1
    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    dev = sqlite3.connect(f"file:{args.dev_db}?mode=ro", uri=True) if Path(args.dev_db).exists() else None
    if dev is None:
        warn("dev.db not found: no price trend or mortgage rate")
    configs = json.loads((CITIES / args.city / "neighborhoods.json").read_text(encoding="utf-8"))
    if args.only:
        configs = [c for c in configs if c["slug"] == args.only]
        if not configs:
            print(f"no neighborhood called {args.only}", file=sys.stderr)
            return 1
    out_dir = Path(args.out) if args.out else CITIES / args.city / "data"
    out_dir.mkdir(parents=True, exist_ok=True)
    today = date.today()
    index = []
    index_path = out_dir / "index.json"
    if index_path.exists():
        index = json.loads(index_path.read_text(encoding="utf-8"))
    for config in configs:
        if args.skip_existing and (out_dir / f"{config['slug']}.json").exists():
            print(f"{config['name']}: already built, skipped")
            continue
        try:
            result = build(config, con, dev, today)
        except Exception as error:  # noqa: BLE001 - one bad neighborhood must not sink a county-wide run
            warn(f"{config['slug']}: build failed ({error})")
            continue
        if not result:
            continue
        path = out_dir / f"{config['slug']}.json"
        path.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
        print(f"  wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")
        entry = {"slug": result["slug"], "name": result["name"], "region": result["region"], "center": result["center"],
                 "medianPrice": result["market"]["all"]["medianPrice"], "sales": len(result["sales"])}
        index = [e for e in index if e["slug"] != entry["slug"]] + [entry]
    order = {c["slug"]: i for i, c in enumerate(json.loads((CITIES / args.city / "neighborhoods.json").read_text(encoding="utf-8")))}
    index.sort(key=lambda e: order.get(e["slug"], 99))
    index_path.write_text(json.dumps(index, indent=2), encoding="utf-8")
    if WARNINGS:
        print(f"{len(WARNINGS)} warning(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
