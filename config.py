"""Zentrale Konfiguration.

Alle Werte stammen aus dem oeffentlichen Frontend von verkehrslage.bahnhof.de
(Nuxt-Config `window.__NUXT__.config.public`) und wurden gegen den Broker bzw.
die REST-API verifiziert. Bei Aenderungen der DB-Seite bitte hier nachziehen.
"""

from __future__ import annotations

# --- MQTT (Live-GPS) ---------------------------------------------------------
MQTT_HOST = "amlen-prod-nlb-ext.service.deutschebahn.com"
MQTT_PORT = 1877
MQTT_PATH = "/"  # WebSocket-Pfad
MQTT_USER = "ris-reisendenkarte"
MQTT_PASSWORD = "By*Iua2MuzqQqpa8V4CtZCKF9oES0wMR"
MQTT_CLIENT_PREFIX = "risk_pathfinder_"
# Die ACL erlaubt genau diesen Zweig; breitere Wildcards werden mit SUBACK 0x80
# abgelehnt.
MQTT_TOPIC = "RISSERVICES/PROD/journey-positions/v1/#"

# --- REST (Anreicherung: Linienfarben, Streckengeometrie, Regionen) ----------
# verkehrslage.bahnhof.de leitet inzwischen per 301 auf verkehrslage.db.info um.
# Die API nicht ueber die alte Domain aufrufen: der Redirect macht aus POST ein
# GET, wodurch z. B. die Organisational-Units-Abfrage mit 405 scheitert.
RIS_BASE = "https://verkehrslage.db.info"
RIS_API_KEY = "32a84ba3-de45-46b3-a580-e3cac9591981"
RIS_CLIENT_ID = "ris-api"
RIS_APP_ID = "DKS-DisruptionWebSdk"

# --- Verhalten ---------------------------------------------------------------
STALE_SECONDS = 600        # Zuege ohne Update verschwinden nach 10 min
TRAIL_POINTS = 45          # maximal gespeicherte Punkte je Spur
TRAIL_SECONDS = 900        # Spuren decken die letzten 15 min ab
TRAIL_SAMPLE_SECONDS = 20  # fruehester neuer Spurpunkt pro Zug
TRAIL_MIN_METERS = 100.0   # oder sobald sich der Zug so weit bewegt hat
WS_INTERVAL = 1.0          # Sekunden zwischen Snapshots
CACHE_DIR = "cache"

# Die 17 Regionen, die die Website anbietet (Organisational Units).
REGION_NAMES = [
    "DB_Fernverkehr",
    "Partner_Operator_Arverio",
    "DB_Regio_BadenWuerttemberg",
    "DB_Regio_Bayern",
    "DB_Regio_Mitte",
    "DB_Regio_Nord",
    "DB_Regio_NordOst",
    "DB_Regio_NordrheinWestfalen",
    "DB_Regio_SuedOst",
    "DB_Regio_Suedostbayernbahn",
    "DB_SBahn_Berlin",
    "DB_SBahn_Hamburg",
    "DB_SBahn_Muenchen",
    "DB_SBahn_RheinMain",
    "DB_SBahn_Stuttgart",
    "Partner_Operator_SBB_Deutschland",
    "Partner_Operator_SWEG",
]
