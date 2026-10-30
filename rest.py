"""REST-Client fuer verkehrslage.bahnhof.de (Linien, Regionen, Strecken).

Die API verlangt die F5-Session-Cookies der Website; ein einfacher GET auf eine
Regionsseite genuegt. CSRF wird nicht geprueft.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path

import requests

import config

log = logging.getLogger("rest")


class RisRest:
    def __init__(self, cache_dir: str = config.CACHE_DIR) -> None:
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": (
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/141.0 Safari/537.36"
                ),
                "Accept-Language": "de-DE,de;q=0.9",
                "DB-Api-Key": config.RIS_API_KEY,
                "DB-Client-Id": config.RIS_CLIENT_ID,
                "X-TS-AJAX-Request": "true",
                "Referer": f"{config.RIS_BASE}/de/region/DB_SBahn_RheinMain",
            }
        )
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        (self.cache_dir / "geo").mkdir(exist_ok=True)
        self._lock = threading.Lock()
        # Begrenzt parallele REST-Aufrufe (Geometrie-Prefetch), statt alles
        # zu serialisieren: 3 gleichzeitige Requests sind hoeflich und schnell.
        self._req_sem = threading.BoundedSemaphore(3)
        self._ready = False
        self._cleanup_geo_cache()

    def _cleanup_geo_cache(self) -> None:
        cutoff = time.time() - 3 * 86400
        for p in (self.cache_dir / "geo").glob("*.json"):
            try:
                if p.stat().st_mtime < cutoff:
                    p.unlink()
            except OSError:
                pass

    # -- Session ------------------------------------------------------------
    def _bootstrap(self) -> None:
        url = f"{config.RIS_BASE}/de/region/DB_SBahn_RheinMain"
        log.info("Hole Session-Cookies von %s", url)
        r = self.session.get(url, timeout=20)
        r.raise_for_status()
        self._ready = True

    def _call(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        body: dict | None = None,
        accept: str = "application/vnd.de.db.ris+json",
        timeout: int = 25,
    ) -> requests.Response:
        with self._lock:
            if not self._ready:
                self._bootstrap()
        headers = {"Accept": accept}
        url = path if path.startswith("http") else config.RIS_BASE + path
        for attempt in (1, 2):
            with self._req_sem:
                r = self.session.request(
                    method, url, params=params, json=body, headers=headers, timeout=timeout
                )
            if r.status_code in (401, 403) and attempt == 1:
                log.warning("REST %s -> %s, erneuere Session", path, r.status_code)
                with self._lock:
                    self._ready = False
                    self._bootstrap()
                continue
            break
        if r.status_code >= 400:
            log.warning("REST %s %s -> %s %s", method, path, r.status_code, r.text[:200])
        r.raise_for_status()
        return r

    # -- Cache --------------------------------------------------------------
    def _read_cache(self, name: str, max_age: float) -> dict | list | None:
        p = self.cache_dir / name
        try:
            if p.exists() and time.time() - p.stat().st_mtime < max_age:
                return json.loads(p.read_text())
        except Exception:
            pass
        return None

    def _write_cache(self, name: str, data) -> None:
        try:
            (self.cache_dir / name).write_text(json.dumps(data, ensure_ascii=False))
        except Exception as exc:
            log.debug("Cache schreiben fehlgeschlagen: %s", exc)

    # -- Organisational Units ----------------------------------------------
    def organizational_units(self, names: list[str] | None = None) -> dict[str, list[str]]:
        names = names or config.REGION_NAMES
        cached = self._read_cache("ou_map.json", max_age=7 * 86400)
        if isinstance(cached, dict) and all(n in cached for n in names):
            return {n: cached[n] for n in names}

        result = dict(cached) if isinstance(cached, dict) else {}
        fails = 0
        for name in names:
            if name in result:
                continue
            try:
                r = self._call(
                    "POST",
                    "/api/core-data/configuration/organizational-units/by-name",
                    body={
                        "organizationalUnitNames": [name],
                        "include": ["ADMINISTRATION_IDS"],
                    },
                )
                data = r.json()
                if data:
                    result[name] = data[0].get("administrationIds", [])
                fails = 0
            except Exception as exc:
                fails += 1
                log.warning("OU %s fehlgeschlagen: %s", name, exc)
                if fails >= 3:
                    log.warning("REST nicht erreichbar - breche OU-Abfrage ab")
                    break
        if result:
            self._write_cache("ou_map.json", result)
        return {n: result.get(n, []) for n in names}

    # -- Linien -------------------------------------------------------------
    def line_catalog(self) -> list[dict]:
        cached = self._read_cache("lines.json", max_age=86400)
        if isinstance(cached, list) and cached:
            return cached

        lines: dict[tuple, dict] = {}
        fails = 0
        for name in config.REGION_NAMES:
            try:
                r = self._call(
                    "GET",
                    "/api/lines/lines/find-by-organizational-units",
                    params={"organizationalUnitNames": name},
                )
                for ln in r.json().get("lines", []):
                    line_name = ln.get("lineName")
                    color = (ln.get("primaryColor") or "").lstrip("#")
                    if not line_name or not color:
                        continue
                    key = (line_name, color, ln.get("productClass"))
                    entry = lines.setdefault(
                        key,
                        {
                            "line": line_name,
                            "color": "#" + color,
                            "productClass": ln.get("productClass"),
                            "admins": set(),
                        },
                    )
                    for sec in ln.get("lineSections") or []:
                        entry["admins"].update(sec.get("administrationIds") or [])
                fails = 0
            except Exception as exc:
                fails += 1
                log.warning("Linien fuer %s fehlgeschlagen: %s", name, exc)
                if fails >= 3:
                    log.warning("REST nicht erreichbar - breche Linienabfrage ab")
                    break

        catalog = [
            {
                "line": v["line"],
                "color": v["color"],
                "productClass": v["productClass"],
                "admins": sorted(v["admins"]),
            }
            for v in lines.values()
        ]
        if catalog:
            self._write_cache("lines.json", catalog)
        return catalog

    # -- Streckengeometrie --------------------------------------------------
    def journey_geometry(self, journey_id: str) -> dict:
        safe = "".join(ch for ch in journey_id if ch.isalnum() or ch in "-_")
        cache_file = f"geo/{safe}.json"
        cached = self._read_cache(cache_file, max_age=3 * 86400)
        if isinstance(cached, dict) and cached.get("coordinates"):
            return cached

        r = self._call(
            "GET",
            f"/api/journey-railway-sections/internal/railway-sections/{journey_id}",
        )
        data = r.json()
        sections = data.get("sections") or []
        if not sections:
            raise ValueError("keine Streckenabschnitte fuer diese Journey")

        r = self._call(
            "POST",
            "/api/pathfinder-routing/railway/sections/between-operating-units",
            body={"sections": sections},
            accept="application/geo+json",
            timeout=40,
        )
        geo = r.json()

        coords: list[list[float]] = []
        for resp in geo.get("railwaySectionsResponses") or []:
            paths = resp.get("paths") or []
            if not paths:
                continue
            path = min(paths, key=lambda p: p.get("length") or 0)
            for sec in path.get("sections") or []:
                for c in ((sec.get("geometry") or {}).get("coordinates") or []):
                    if isinstance(c, list) and len(c) >= 2:
                        pt = [float(c[0]), float(c[1])]
                        if not coords or coords[-1] != pt:
                            coords.append(pt)

        if not coords:
            raise ValueError("keine Geometrie in der Antwort")

        out = {"journeyId": journey_id, "coordinates": coords, "length": len(coords)}
        self._write_cache(cache_file, out)
        return out
