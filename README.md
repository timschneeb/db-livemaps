# Zuglage – Live-GPS im DB-Netz

Die Deutsche Bahn zeigt auf [verkehrslage.bahnhof.de](https://verkehrslage.bahnhof.de)
Live-Positionen nur für ausgewählte Regionen. Der zugrundeliegende MQTT-Broker
erlaubt jedoch ein Wildcard-Abo auf **alle** Journeys aller EVUs – inklusive
S-Bahnen, DB Regio, Fernverkehr, Bus/SEV und Partnern (SBB, SNCF, go.on,
deu.mobil, Arverio, SWEG …).

![Screenshot: Live-Karte mit rund 790 Zügen](docs/screenshot.png)

> **English summary:** Zuglage is an unofficial live map of trains across the
> German railway network. The MQTT broker behind
> [verkehrslage.bahnhof.de](https://verkehrslage.bahnhof.de) accepts a wildcard
> subscription for all journey positions, so this project shows every vehicle
> of every operator – far beyond the few regions the website exposes. Backend:
> FastAPI + paho-mqtt, frontend: Leaflet with CARTO Positron tiles.

Dieses Projekt macht diese Daten sichtbar:

* `probe/gps_dump.py` – eigenständiges Demo-Skript, das 45 s lang alle
  Positionen mitschreibt und einen Report ausgibt.
* `server.py` – FastAPI-Backend: hält eine MQTT-Verbindung, verteilt die
  Positionen einmal pro Sekunde per WebSocket und reichert sie über die
  REST-API der Website mit Linienfarben und Streckengeometrie an.
* `web/` – Leaflet-Karte (CARTO Positron/light) mit Filtern, Popups und Zugstrecken.
  Optional lassen sich die Strecken **aller** Züge dünn einblenden; die
  Geometrien werden dafür im Hintergrund (max. 3 parallel) geladen und
  serverseitig gecacht.

## Aufbau

```
config.py          Broker-/REST-Zugangsdaten (aus dem Website-Frontend)
store.py           In-Memory-Store: letzte Position je Journey + Statistik
feed.py            MQTT-Thread (paho, WebSocket + TLS), Wildcard-Abo
rest.py            REST-Client mit Session-Cookies und Datei-Cache
server.py          FastAPI: /ws-Snapshot, /api/regions, /api/catalog, /api/geometry
probe/gps_dump.py  eigenstaendiges Demo-Skript
web/               index.html, app.js, style.css
cache/             automatisch angelegter Cache (Linien, Regionen, Geometrie)
```

## Start

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn server:app --host 127.0.0.1 --port 8000
```

Dann <http://127.0.0.1:8000> öffnen.

Demo ohne Server:

```bash
python3 probe/gps_dump.py --duration 60 --out positions.jsonl
```

## Wie es funktioniert

1. **MQTT-over-WSS** zum Broker aus der Nuxt-Config der Website
   (`config.py`): `wss://amlen-prod-nlb-ext.service.deutschebahn.com:1877`,
   Abo auf `RISSERVICES/PROD/journey-positions/v1/#`.
   Die ACL erlaubt genau diesen Zweig; breitere Wildcards werden mit
   `SUBACK 0x80` abgelehnt.
2. **REST** (`https://verkehrslage.bahnhof.de`) liefert
   * die 17 Regionen → Administration-IDs,
   * Liniennamen, Farben und Produktklassen,
   * die Streckengeometrie je Journey (zwei Requests, gecacht unter `cache/`).
   Benötigt wird nur ein Session-Cookie von der Website; die Header stehen in
   `rest.py`.
3. **WebSocket** `/ws` schickt jede Sekunde einen Snapshot
   `{stats, positions[]}`. Der Client filtert lokal und zeichnet mit
   Leaflet/Canvas.

## Grenzen

* Inoffizielle, aber öffentlich im Frontend veröffentlichte Zugangsdaten.
  Bitte sparsam nutzen; keine Garantie auf Verfügbarkeit.
* Der Broker liefert keine retained messages – nach dem Start füllt sich die
  Karte innerhalb weniger Sekunden.
* `metaSource: SIGNALLING` kennzeichnet geschätzte Positionen; die Karte
  markiert sie im Popup.
* Die CARTO-Kacheln in `web/app.js` nutzen einen kostenlosen API-Key
  (5 Mio. Kacheln/Monat); Attribution bleibt sichtbar.

## Lizenz

Der Quellcode steht unter der **GNU General Public License v3.0** – siehe
[LICENSE](LICENSE). Copyright (C) 2026 Tim Schneeberger.

Dieses Projekt ist ein inoffizielles Hobbyprojekt und steht in keiner
Verbindung zur Deutschen Bahn AG oder den beteiligten EVUs. Die abgerufenen
Live-Daten, Linien- und Streckeninformationen sowie alle Marken- und
Kennzeichenrechte verbleiben bei den jeweiligen Rechteinhabern. Die Nutzung
erfolgt auf eigenes Risiko; bitte die Schnittstelle sparsam belasten.
