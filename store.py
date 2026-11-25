"""In-Memory-Zustand: letzte GPS-Position je Journey + Statistik."""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from dataclasses import dataclass, field

import config


def _dist_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Grobe Entfernung in Metern (ausreichend fuer Spur-Sampling)."""
    dlat = (lat2 - lat1) * 111_320.0
    dlon = (lon2 - lon1) * 111_320.0 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(dlat, dlon)


@dataclass
class Position:
    journey_id: str
    lat: float
    lon: float
    line: str | None = None
    category: str | None = None
    transport_type: str | None = None
    operator: str | None = None
    operator_code: str | None = None
    origin: str | None = None
    destination: str | None = None
    speed: float | None = None
    source: str | None = None
    administrations: list[str] = field(default_factory=list)
    updated: float = field(default_factory=time.time)
    # (timestamp, lat, lon) - aeltere Punkte werden beim Lesen verworfen.
    trail: deque = field(default_factory=lambda: deque(maxlen=config.TRAIL_POINTS))

    def as_dict(self, now: float) -> dict:
        return {
            "id": self.journey_id,
            "lat": round(self.lat, 6),
            "lon": round(self.lon, 6),
            "line": self.line,
            "cat": self.category,
            "op": self.operator,
            "orig": self.origin,
            "dest": self.destination,
            "spd": None if self.speed is None else round(self.speed),
            "src": self.source,
            "adm": self.administrations,
            "age": round(now - self.updated, 1),
        }


def _dig(d: dict | None, *keys, default=None):
    cur = d
    for k in keys:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(k)
    return default if cur is None else cur


class Store:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._positions: dict[str, Position] = {}
        self._msg_times: deque[float] = deque(maxlen=20000)
        self.messages = 0
        self.connected = False
        self.last_message: float | None = None
        self.started = time.time()
        self.suback: int | None = None

    # -- MQTT ---------------------------------------------------------------
    def ingest(self, payload: bytes) -> None:
        try:
            import json

            data = json.loads(payload)
        except Exception:
            return

        jid = data.get("journeyID")
        lon, lat = data.get("longitude"), data.get("latitude")
        if not jid or lon is None or lat is None:
            return

        t = _dig(data, "info", "transportAtStart") or {}
        admin = t.get("administration") or {}
        line = t.get("line") or t.get("journeyDescription") or t.get("journeyName")

        pos = Position(
            journey_id=jid,
            lat=float(lat),
            lon=float(lon),
            line=line or None,
            category=t.get("category"),
            transport_type=t.get("type"),
            operator=admin.get("operatorName"),
            operator_code=admin.get("operatorCode"),
            origin=_dig(data, "info", "origin", "name")
            or _dig(data, "origin", "name"),
            destination=_dig(data, "info", "destination", "name")
            or _dig(data, "destination", "name"),
            speed=data.get("speed"),
            source=data.get("metaSource"),
            administrations=data.get("administrations") or [],
        )

        now = time.time()
        with self._lock:
            old = self._positions.get(jid)
            if old is not None:
                # Historie uebernehmen: jede Nachricht erzeugt ein neues Objekt.
                pos.trail = old.trail
            if not pos.trail:
                pos.trail.append((now, pos.lat, pos.lon))
            else:
                ts, tlat, tlon = pos.trail[-1]
                if now - ts >= config.TRAIL_SAMPLE_SECONDS or _dist_m(
                    tlat, tlon, pos.lat, pos.lon
                ) >= config.TRAIL_MIN_METERS:
                    pos.trail.append((now, pos.lat, pos.lon))

            self._positions[jid] = pos
            self.messages += 1
            self._msg_times.append(now)
            self.last_message = now

    # -- Abfragen -----------------------------------------------------------
    def prune(self) -> None:
        cutoff = time.time() - config.STALE_SECONDS
        with self._lock:
            stale = [k for k, p in self._positions.items() if p.updated < cutoff]
            for k in stale:
                del self._positions[k]

    def snapshot(self) -> list[dict]:
        now = time.time()
        cutoff = now - config.STALE_SECONDS
        with self._lock:
            return [p.as_dict(now) for p in self._positions.values() if p.updated >= cutoff]

    def trails(self) -> dict[str, list[list[float]]]:
        """Spuren aller aktiven Zuege als {journeyID: [[lat, lon], ...]}."""
        now = time.time()
        cutoff = now - config.TRAIL_SECONDS
        out: dict[str, list[list[float]]] = {}
        with self._lock:
            for jid, p in self._positions.items():
                if p.updated < now - config.STALE_SECONDS:
                    continue
                pts = [
                    [round(lat, 5), round(lon, 5)]
                    for ts, lat, lon in p.trail
                    if ts >= cutoff
                ]
                cur = [round(p.lat, 5), round(p.lon, 5)]
                if not pts or pts[-1] != cur:
                    pts.append(cur)
                if len(pts) >= 2:
                    out[jid] = pts
        return out

    def stats(self) -> dict:
        now = time.time()
        with self._lock:
            recent = [t for t in self._msg_times if t >= now - 10]
            count = len(self._positions)
            last = self.last_message
            # Der MQTT-Client reconnectet intern, ohne on_connect erneut zu
            # melden. Fliesen weiter Daten, gilt der Feed trotzdem als live.
            connected = self.connected or (
                last is not None and now - last < 30
            )
        return {
            "connected": connected,
            "messages": self.messages,
            "msg_per_s": round(len(recent) / 10, 1),
            "journeys": count,
            "last_message_age": None if last is None else round(now - last, 1),
            "uptime": round(now - self.started),
            "suback": self.suback,
        }
