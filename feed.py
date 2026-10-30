"""MQTT-over-WebSocket-Client fuer die Live-Positionen."""

from __future__ import annotations

import logging
import ssl
import threading
import time
import uuid

import paho.mqtt.client as mqtt

import config
from store import Store

log = logging.getLogger("feed")


def _new_client() -> mqtt.Client:
    """paho-mqtt 1.x und 2.x kompatibel erzeugen."""
    client_id = config.MQTT_CLIENT_PREFIX + str(uuid.uuid4())
    try:  # paho >= 2.0
        client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION1,
            client_id=client_id,
            transport="websockets",
        )
    except AttributeError:  # paho 1.x
        client = mqtt.Client(client_id=client_id, transport="websockets")

    client.ws_set_options(path=config.MQTT_PATH)
    client.tls_set(cert_reqs=ssl.CERT_REQUIRED)
    client.username_pw_set(config.MQTT_USER, config.MQTT_PASSWORD)
    client.reconnect_delay_set(min_delay=2, max_delay=60)
    return client


class Feed(threading.Thread):
    def __init__(self, store: Store) -> None:
        super().__init__(name="mqtt-feed", daemon=True)
        self.store = store
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:
        backoff = 2
        while not self._stop.is_set():
            client = _new_client()

            def on_connect(c, userdata, flags, rc, _client=client):
                if rc == 0:
                    log.info("MQTT verbunden, abonniere %s", config.MQTT_TOPIC)
                    c.subscribe(config.MQTT_TOPIC, qos=0)
                else:
                    log.error("MQTT-Verbindung abgelehnt (rc=%s)", rc)

            def on_subscribe(c, userdata, mid, granted_qos):
                granted = list(granted_qos)
                log.info("SUBACK %s", granted)
                self.store.suback = int(granted[0]) if granted else None
                if granted and int(granted[0]) == 128:
                    log.error("Abo verweigert - ACL/User pruefen")

            def on_disconnect(c, userdata, rc):
                self.store.connected = False
                if rc != 0:
                    log.warning("MQTT getrennt (rc=%s), reconnect...", rc)

            client.on_connect = on_connect
            client.on_subscribe = on_subscribe
            client.on_disconnect = on_disconnect
            client.on_message = lambda c, u, msg: self.store.ingest(msg.payload)

            try:
                client.connect(config.MQTT_HOST, config.MQTT_PORT, keepalive=45)
                self.store.connected = True
                backoff = 2
                client.loop_forever(retry_first_connection=True)
            except Exception as exc:
                self.store.connected = False
                log.warning("MQTT-Fehler: %s (neuer Versuch in %ss)", exc, backoff)
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
            finally:
                try:
                    client.disconnect()
                except Exception:
                    pass
