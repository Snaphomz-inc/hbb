"""
Refresh the homes for sale in each neighborhood's data file.

The story's closed sales come from the data extraction team's CMA database (build_neighborhood.py).
Active listings change daily and are not in that database, so they come from the MLS feed the main
site uses: RealEstateAPI's MLSSearch (the same call behind www.snaphomz.com/api/mls/search and
/api/get_nearby_homes). One search per neighborhood, centred on it with a radius that covers its
bounds, `active: true`, paged until the feed runs out; the records are kept to the neighborhood's
bounds, de-duplicated across MLS boards (the same house is often listed twice with a different
listing id), and written as `active` in `cities/<city>/data/<slug>.json` in the same tuple shape as
`sales`:

    [lon, lat, list price, sqft, kind (0 house, 1 condo, 2 other), beds,
     months before the end of the sales window it was listed (negative = after), listing id, street address]

Usage:
    python scripts/fetch_active_listings.py            # every neighborhood in cities/la
    python scripts/fetch_active_listings.py glendale   # one slug

Needs REAPI_API_KEY in the environment or in neighborhood-aerial/.env (the key the main site keeps
as REAPI_API_KEY in its server environment). Calling www.snaphomz.com's own route from a script is
not an option: Cloudflare in front of the site only lets browsers through.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "cities" / "la" / "data"
BASE = os.environ.get("REAPI_BASE_URL", "https://api.realestateapi.com").rstrip("/")
PAGE = 250
MAX_PAGES = 12
HOUSE = {"Single Family Residence", "Single Family", "SingleFamilyResidence", "Residential", "Manufactured Home"}
CONDO = {"Condominium", "Townhouse", "Townhome", "Condo", "Stock Cooperative", "Own Your Own", "Apartment"}


def load_env() -> None:
    """Read neighborhood-aerial/.env for REAPI_API_KEY without overriding a real environment variable."""
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def post(endpoint: str, body: dict) -> dict:
    key = os.environ.get("REAPI_API_KEY")
    if not key:
        sys.exit("REAPI_API_KEY is not set. Put it in neighborhood-aerial/.env (never commit it) and run again.")
    req = urllib.request.Request(
        f"{BASE}{endpoint}",
        data=json.dumps(body).encode(),
        headers={"x-api-key": key, "content-type": "application/json", "accept": "application/json"},
        method="POST",
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            if error.code == 429 and attempt < 2:
                time.sleep(3 * (attempt + 1))
                continue
            raise SystemExit(f"{endpoint} returned {error.code}: {error.read()[:200]!r}")
    raise SystemExit("gave up after three rate-limit retries")


def kind_of(sub_type) -> int:
    name = sub_type[0] if isinstance(sub_type, list) and sub_type else sub_type
    if name in HOUSE:
        return 0
    if name in CONDO:
        return 1
    return 2


def address_key(address: str) -> str:
    """'1650 Capistrano Avenue' and '1650 Capistrano Ave Unit 2' collapse to one key per unit-less street line."""
    text = address.lower().replace(",", " ")
    text = re.sub(r"\b(unit|apt|#)\b", " ", text)
    text = re.sub(r"\b(street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|place|pl|terrace|ter|lane|ln|way|court|ct|north|east|west|south|n|e|w|s)\b", " ", text)
    return " ".join(text.split())


def listed_month(record: dict) -> str | None:
    listing = record.get("listing") or {}
    for field in ("listingContractDate", "onMarketDate", "modificationTimestamp"):
        value = listing.get(field) or record.get(field)
        if isinstance(value, str) and re.match(r"\d{4}-\d{2}", value):
            return value[:7]
    return None


def is_home(record: dict) -> bool:
    listing = record.get("listing") or {}
    prop = listing.get("property") or {}
    text = " ".join(str(v) for v in (prop.get("propertyType"), prop.get("propertySubType"), listing.get("standardStatus")))
    if re.search(r"lease|rental|commercial|land|lot\b|business|industrial", text, re.I):
        return False
    return bool(prop.get("latitude") and prop.get("longitude") and listing.get("listPriceLow"))


def fetch_neighborhood(slug: str) -> None:
    path = DATA / f"{slug}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    (west, south), (east, north) = data["bounds"]
    lat0 = (south + north) / 2
    lon0 = (west + east) / 2
    # A circle that reaches the bounds' corners, in miles (the feed's unit).
    half_h = (north - south) / 2 * 69.0
    half_w = (east - west) / 2 * 69.0 * math.cos(math.radians(lat0))
    radius = round(math.hypot(half_h, half_w) + 0.3, 2)
    end_year, end_month = map(int, data["market"]["window"]["to"].split("-")[:2])

    seen: dict[tuple, list] = {}
    index = 0
    for _ in range(MAX_PAGES):
        payload = post("/v2/MLSSearch", {"latitude": lat0, "longitude": lon0, "radius": radius, "active": True, "size": PAGE, "resultIndex": index, "include_photos": False})
        records = payload.get("data") or []
        for record in records:
            if not is_home(record):
                continue
            listing = record["listing"]
            prop = listing["property"]
            address = (listing.get("address") or {}).get("unparsedAddress") or ""
            lat, lon = float(prop["latitude"]), float(prop["longitude"])
            if not (west <= lon <= east and south <= lat <= north):
                continue
            month = listed_month(record)
            if not month:
                continue
            year, mon = map(int, month.split("-"))
            months_ago = (end_year * 12 + end_month) - (year * 12 + mon)
            row = [lon, lat, int(listing["listPriceLow"]), int(prop.get("livingArea") or 0), kind_of(prop.get("propertySubType")), int(prop.get("bedroomsTotal") or 0), months_ago, str(record.get("listingId") or ""), address]
            key = (address_key(address), round(lat, 3), round(lon, 3))
            # Across boards the newest listing of a home wins.
            if key not in seen or months_ago < seen[key][6]:
                seen[key] = row
        if len(records) < PAGE:
            break
        index += len(records)

    data["active"] = list(seen.values())
    path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"{slug}: {len(data['active'])} homes for sale")


def main() -> None:
    load_env()
    slugs = sys.argv[1:] or sorted(p.stem for p in DATA.glob("*.json"))
    for slug in slugs:
        fetch_neighborhood(slug)


if __name__ == "__main__":
    main()
