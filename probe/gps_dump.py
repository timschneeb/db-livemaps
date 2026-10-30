#!/usr/bin/env python3
"""Demo: Live-GPS aller Zuege aus dem DB-Verkehrslage-Broker dumpen.

Beispiel:
    python3 probe/gps_dump.py --duration 60 --out positions.jsonl

Das Skript abonniert denselben MQTT-Zweig, den die Website fuer S-Bahn
Rhein-Main nutzt - die ACL erlaubt dort jedoch wildcardmaessig *alle*
Journeys aller EVUs (nicht nur die 17 Regionen der Website).
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import signal
import ssl
import sys
import threading
import time
import uuid
from pathlib import Path

import paho.mqtt.client as mqtt

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import config  # noqa: E402


def make_client() -> mqtt.Client:
    client_id = config.MQTT_CLIENT_PREFIX + str(uuid.uuid4())
    try:
        client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION1,
            client_id=client_id,
            transport="websockets",
        )
    except AttributeError:
        client = mqtt.Client(client_id=client_id, transport="websockets")
    client.ws_set_options(path=config.MQTT_PATH)
    client.tls_set(cert_reqs=ssl.CERT_REQUIRED)
    client.username_pw_set(config.MQTT_USER, config.MQTT_PASSWORD)
    return client


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--duration", type=float, default=45, help="Sekunden mitschneiden")
    ap.add_argument("--out", default="positions.jsonl", help="Zieldatei (JSONL)")
    ap.add_argument("--quiet", action="store_true", help="keine Live-Ausgabe")
    args = ap.parse_args()

    positions: dict[str, dict] = {}
    messages = 0
    started = time.time()
    stop = threading.Event()

    def on_connect(c, u, flags, rc):
        if rc != 0:
            print(f"Verbindung abgelehnt: rc={rc}", file=sys.stderr)
            stop.set()
            return
        c.subscribe(config.MQTT_TOPIC, qos=0)
        if not args.quiet:
            print(f"verbunden, abonniert {config.MQTT_TOPIC}")

    def on_message(c, u, msg):
        nonlocal messages
        messages += 1
        try:
            data = json.loads(msg.payload)
        except Exception:
            return
        jid = data.get("journeyID")
        if not jid or data.get("longitude") is None:
            return
        t = (data.get("info") or {}).get("transportAtStart") or {}
        admin = t.get("administration") or {}
        positions[jid] = {
            "journeyID": jid,
            "line": t.get("line") or t.get("journeyDescription"),
            "category": t.get("category"),
            "operator": admin.get("operatorName"),
            "administrationID": admin.get("administrationID"),
            "origin": (data.get("origin") or {}).get("name"),
            "destination": (data.get("destination") or {}).get("name"),
            "latitude": data.get("latitude"),
            "longitude": data.get("longitude"),
            "speed": data.get("speed"),
            "metaSource": data.get("metaSource"),
            "timeInformation": (data.get("meta") or {}).get("timeInformation"),
        }

    client = make_client()
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(config.MQTT_HOST, config.MQTT_PORT, keepalive=45)
    client.loop_start()

    def handle_sigint(signum, frame):
        stop.set()

    signal.signal(signal.SIGINT, handle_sigint)

    try:
        while not stop.is_set() and time.time() - started < args.duration:
            time.sleep(2)
            if not args.quiet:
                rate = messages / max(time.time() - started, 1)
                print(
                    f"\r{time.time() - started:5.1f}s  {messages:6d} msgs  "
                    f"{rate:5.1f}/s  {len(positions):5d} Zuege",
                    end="",
                    flush=True,
                )
    finally:
        stop.set()
        client.loop_stop()
        client.disconnect()

    elapsed = time.time() - started
    if not args.quiet:
        print()

    out = Path(args.out)
    with out.open("w", encoding="utf-8") as fh:
        for pos in positions.values():
            fh.write(json.dumps(pos, ensure_ascii=False) + "\n")

    ops = collections.Counter(p["operator"] for p in positions.values())
    cats = collections.Counter(p["category"] or "?" for p in positions.values())
    srcs = collections.Counter(p["metaSource"] or "?" for p in positions.values())
    lats = [p["latitude"] for p in positions.values()]
    lons = [p["longitude"] for p in positions.values()]

    print(f"\n=== {elapsed:.0f}s, {messages} Meldungen ({messages / max(elapsed, 1):.1f}/s) ===")
    print(f"Zuege: {len(positions)}   EVUs: {len(ops)}   Kategorien: {len(cats)}")
    if lats:
        print(
            f"BBox: lat {min(lats):.2f}..{max(lats):.2f}  "
            f"lon {min(lons):.2f}..{max(lons):.2f}"
        )
    print("Quellen:", dict(srcs))
    print("Kategorien:", ", ".join(f"{k}={v}" for k, v in cats.most_common(12)))
    print("Top-EVUs:")
    for name, n in ops.most_common(12):
        print(f"  {n:4d}  {name}")
    print(f"\nGeschrieben: {out} ({len(positions)} Zeilen)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
