# Contributing to streamdeck-rig-profiles

## Getting started

```bash
npm install
npm rebuild robotjs   # required after any Node version change
npm test              # run all unit tests
```

> **macOS accessibility permission** — `robotjs` (used by the Fanatec driver) requires the terminal
> app to have Accessibility access under *System Settings → Privacy & Security → Accessibility*.
> The unit tests bypass this requirement via injectable dependencies; only the live smoke-test
> scripts need the permission.

---

## Driver interface contract

Each hardware integration lives in its own file (`src/<driver>.js`) and must conform to the
following informal interface so that `profileSwitch.js` can call it uniformly.

### Required export

```js
/**
 * Activate the preset/profile/scene that corresponds to the given profile config.
 *
 * Rules that every driver must follow:
 *   1. No-op silently when `value` is falsy (null, undefined, empty string, 0).
 *   2. Never throw — catch and log all errors internally.
 *   3. Return a Promise (async function or explicit Promise chain).
 *
 * @param {*} value  Driver-specific identifier from profiles.yaml.
 *                   String for Fanatec/Moza; object for Govee.
 * @returns {Promise<void>}
 */
export async function activate<Foo>(value) { … }
```

### Injectable dependencies (testing convention)

To keep tests network/hardware-free, drivers accept injectable dependencies as an optional
last-argument options object with `_`-prefixed keys:

```js
// ✅ Good — testable without real hardware or network
export async function activatePreset(hotkeyStr, { _robot = robot } = {}) { … }
export async function activateScene(apiKey, scene, devices, { _fetch = fetch } = {}) { … }

// ❌ Bad — calls real hardware or network in unit tests
export async function activatePreset(hotkeyStr) {
  robot.keyTap(…);   // can't intercept this without monkey-patching
}
```

Production code never passes `_robot` / `_fetch`; the defaults pick up the real
implementations automatically.  Tests pass `vi.fn()` stubs.

### Path-override convention

For functions that read/write the filesystem, use an analogous `_paths` or named override
pattern (see `readState`/`writeState` in `src/state.js` and `ensureConfig` in `src/setup.js`):

```js
export function readState({ localPath = LOCAL_STATE_PATH, sharedPath = SHARED_STATE_PATH } = {}) { … }
```

---

## Adding a new hardware driver

1. **Create `src/mydriver.js`** — implement `async function activateMyDriver(value, { _dep = dep } = {})`.
2. **Create `src/mydriver.test.js`** — cover the pure/injectable surface; no real hardware in CI.
3. **Wire into `src/profileSwitch.js`** — import and call your function alongside the existing drivers.
4. **Document the required config key(s)** in `config/profiles.yaml.template` and `README.md`.
5. **Update `src/configLoader.js`** — add the new key to `SETTINGS_DEFAULTS` with an appropriate default and any needed coercion.

---

## Govee rate limit

The Govee Developer API allows **10,000 requests per account per day**.  Scene-catalog discovery
makes 2 requests per device (one for factory scenes, one for DIY scenes), plus 1 for device
enumeration.  With a typical 2–5 device setup that is ~11 requests per `init()` call.

The on-disk cache (`PLUGIN_DATA_DIR/govee-cache.json`) exists precisely to avoid hitting this
limit on every plugin restart.  Do **not** call `init({ forceRefresh: true })` on a tight loop.

---

## Running the integration smoke tests

These scripts require real credentials and hardware.  They are excluded from `npm test`
(`**/*.integration.test.*` glob).

| Script | Purpose |
|---|---|
| `node scripts/test-govee.js --key <KEY> --list-devices` | List all discovered Govee devices |
| `node scripts/test-govee.js --key <KEY> --list-scenes` | List all scenes per device |
| `node scripts/test-govee.js --key <KEY> --scene "Sunrise"` | Fire a scene on all devices |
| `node scripts/test-fanatec.js --hotkey "ctrl+shift+1"` | Send a hotkey via robotjs |

---

## License

MIT AND Commons Clause (non-commercial).  See [LICENSE](LICENSE) for the full text.
