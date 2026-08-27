// fanatecBus.js — shared connection to the local MQTT broker that the Fanatec
// software stack runs.
//
// Background
// ----------
// FanatecApp installs and runs a Mosquitto broker on localhost:1883. The
// FanatecService process owns the hardware; the Fanatec desktop UI, the mobile
// app, and Corsair's own Stream Deck plugin are all just MQTT clients on that
// broker. We are another peer — no HID work, no window automation.
//
// Topics and the command-action vocabulary come from
//   C:\Program Files\Fanatec\FanatecService\Service\FanatecService.dll.config
// and from the service's own dispatch table.
//
// Two findings that cost real time and are easy to re-break:
//
//   1. `TuningMenuRefresh` is NOT in FanatecService's dispatch table. Corsair's
//      plugin publishes it, and the service silently drops it. It does nothing.
//      `LoadDeviceList` is what makes the service enumerate devices, which
//      instantiates the wheel tuning-menu interface and publishes tuning state.
//
//   2. The tuning stream is transient. It is not a always-on telemetry feed —
//      you must ask (via LoadDeviceList) and then read the reply.
//
// Verified working against a ClubSport DD+ (FS_WHEEL_BASETYPE_CSDDPLUS).

import mqtt from 'mqtt';

export const BROKER_URL = 'mqtt://127.0.0.1:1883';

// Shipped defaults, identical to the ones in Corsair's plugin bundle.
const CREDENTIALS = { username: 'pub_client', password: 'password' };

// From FanatecService.dll.config appSettings.
export const TOPIC_TUNING_STATE = 'HW_UI_TuningsSettings_GET';
export const TOPIC_COMMAND = 'UI_HW_FanatecService_POST';
export const TOPIC_ERROR = 'HW_UI_FanatecService_ERROR';

/** Actions accepted by FanatecService, from its dispatch table. */
export const ACTIONS = {
  TUNING_SETTINGS: 'TuningSettings',
  TUNING_INDEX_CHANGED: 'TuningIndexChanged',
  LOAD_DEVICE_LIST: 'LoadDeviceList',
};

const CONNECT_TIMEOUT_MS = 6000;

/**
 * A lazily-connected, shared MQTT client.
 *
 * The client is created on first use and reused. `mqtt.connect` handles
 * reconnection internally, so a broker restart (or FanatecApp reinstall)
 * recovers without the plugin restarting.
 */
export class FanatecBus {
  /**
   * @param {object} [opts]
   * @param {typeof mqtt.connect} [opts.connect] injected for tests
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ connect = mqtt.connect, log = () => {} } = {}) {
    this._connect = connect;
    this._log = log;
    this._client = null;
    this._connecting = null;
    this._lastState = null;
    this._lastError = null;
    this._listeners = new Set();
  }

  /** Connect (idempotent). Resolves once subscribed and ready. */
  async ready() {
    if (this._client?.connected) return this._client;
    if (this._connecting) return this._connecting;

    this._connecting = new Promise((resolve, reject) => {
      const client = this._connect(BROKER_URL, {
        ...CREDENTIALS,
        connectTimeout: CONNECT_TIMEOUT_MS,
        reconnectPeriod: 5000,
      });

      const timer = setTimeout(() => {
        reject(new Error(`no Fanatec broker at ${BROKER_URL} after ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);

      client.on('message', (topic, buf) => this._onMessage(topic, buf.toString()));
      client.on('error', (err) => this._log(`[fanatec-bus] ${err.message}`));

      client.once('connect', () => {
        clearTimeout(timer);
        client.subscribe([TOPIC_TUNING_STATE, TOPIC_ERROR], (err) => {
          if (err) return reject(err);
          this._client = client;
          resolve(client);
        });
      });
    }).finally(() => {
      this._connecting = null;
    });

    return this._connecting;
  }

  _onMessage(topic, raw) {
    if (topic === TOPIC_ERROR) {
      this._lastError = raw;
      this._log(`[fanatec-bus] service error: ${raw}`);
      return;
    }
    if (topic !== TOPIC_TUNING_STATE) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    this._lastState = parsed;
    for (const fn of [...this._listeners]) fn(parsed);
  }

  /** Publish a command. `message` is the inner payload (string or object). */
  async post(action, message) {
    const client = await this.ready();
    const body = typeof message === 'string' ? message : JSON.stringify(message);
    client.publish(TOPIC_COMMAND, JSON.stringify({ Action: action, Message: body }), { qos: 1 });
  }

  /**
   * Ask the service to publish current tuning state.
   *
   * `LoadDeviceList` is the trigger — see the note at the top of this file.
   */
  async requestState() {
    await this.post(ACTIONS.LOAD_DEVICE_LIST, 'Refresh');
  }

  /**
   * Wait for a tuning state satisfying `match`, asking repeatedly until it
   * arrives. Resolves null on timeout.
   *
   * Waiting for a *matching* state rather than simply the next one matters:
   * after a change is published, the service can still emit a state captured
   * before it landed. Accepting the first reply reads that stale snapshot and
   * reports a mismatch for a change that actually succeeded.
   */
  async awaitState(match = () => true, { timeoutMs = 6000, retryEveryMs = 1200 } = {}) {
    await this.ready();
    return new Promise((resolve) => {
      let retry;
      const finish = (val) => {
        clearTimeout(timer);
        clearInterval(retry);
        this._listeners.delete(listener);
        resolve(val);
      };
      const listener = (state) => {
        if (match(state)) finish(state);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);

      this._listeners.add(listener);
      this.requestState();
      retry = setInterval(() => this.requestState(), retryEveryMs);
    });
  }

  /**
   * Read whatever tuning state the base reports next.
   * Resolves null on timeout (base powered off, service down).
   */
  async readState(opts) {
    return this.awaitState(() => true, opts);
  }

  /** Most recent state seen on the bus, if any. */
  get lastState() {
    return this._lastState;
  }

  /** Last error the service reported, if any. */
  get lastError() {
    return this._lastError;
  }

  async close() {
    this._listeners.clear();
    if (this._client) await this._client.endAsync?.();
    this._client = null;
  }
}

/** Process-wide instance. Providers share one connection. */
let shared = null;

export function getBus(opts) {
  if (!shared) shared = new FanatecBus(opts);
  return shared;
}

export function _resetForTesting() {
  shared = null;
}
