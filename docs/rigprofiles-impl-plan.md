# Implementation Plan: streamdeck-rig-profiles

## Prerequisites

- Node.js 18+ installed
- Stream Deck software installed and XL connected
- `@elgato/cli` installed globally
- FanaLab installed and running
- Govee developer API key (free — https://developer.govee.com/)

---

## Phase 1: Core Toggle

**Goal:** Working profile toggle. Short press cycles profiles. Long press opens picker. Fanatec + Govee switching. Persistent state. Correct button color/label per active profile.

Moza integration deferred pending file location research.

---

### Step 1 — Scaffold

```bash
streamdeck create
# Plugin ID: com.rig.profiles
# Name: Rig Profile Toggle
cd streamdeck-rig-profiles
npm install
npm install js-yaml robotjs node-fetch
```

Note: `robotjs` requires a native build step. Expect to run `npm rebuild` after Node version changes.

---

### Step 2 — `config/profiles.yaml.template`

From spec. Key requirements:
- Each profile must have: `id`, `name`, `color`
- All hardware fields optional (graceful no-op if absent)
- `sd_profile` must exactly match the Stream Deck profile name as configured in the SD app
- Inline comments explain FanaLab hotkey format, color format (hex), Govee scene names
- `default_profile` in `settings` section

On first run, if `config/profiles.yaml` does not exist, copy template automatically.

---

### Step 3 — `src/configLoader.js`

- Parse `profiles.yaml` with `js-yaml`
- Validate: each profile needs `id`, `name`, `color`; warn on unknown fields; skip invalid profiles
- Coerce `content_filter_tags` to `null | string[]`
- Watch for changes with `chokidar`; call registered `onUpdate` callbacks after reload
- Explicit `init(configPath?)` must be called before using any getter (no side effects on import)
- Export `close()` to stop the watcher on teardown
- Expose: `init()`, `close()`, `getProfiles()`, `getProfileById(id)`, `getSettings()`, `onUpdate(callback)`

---

### Step 4 — `src/state.js`

Shared state file path:
```
%APPDATA%\streamdeck-rig-shared\active-profile.json
```

Create directory if it doesn't exist.

```javascript
const STATE_PATH = path.join(
  process.env.APPDATA,
  'streamdeck-rig-shared',
  'active-profile.json'
);

const readState = () => {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { activeProfile: null }; }
};

const writeState = (profileId) => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    activeProfile: profileId,
    lastSwitched: new Date().toISOString()
  }));
};
```

Also write a plugin-local `state.json` in the plugin data directory as a backup — used to restore button appearance on Stream Deck restart before the shared file is read.

---

### Step 5 — `src/fanatec.js`

```javascript
const robot = require('robotjs');

// Parse hotkey string "ctrl+alt+f1" → modifiers array + key
const parseHotkey = (str) => {
  const parts = str.toLowerCase().split('+');
  const key = parts.pop();
  return { mods: parts, key };
};

const activatePreset = (hotkeyStr) => {
  if (!hotkeyStr) return;
  const { mods, key } = parseHotkey(hotkeyStr);
  robot.keyTap(key, mods);
};
```

FanaLab must be running for hotkeys to work. The plugin does not launch FanaLab — document this as a prerequisite.

---

### Step 6 — `src/govee.js`

```javascript
const fetch = require('node-fetch');
const { randomUUID } = require('crypto');
const API_BASE = 'https://openapi.api.govee.com/router/api/v1';

// Device + scene catalog cache. Built at startup; refresh from property inspector.
// Map of deviceId → { sku, sceneMap: { "Racing": <capability object>, ... } }
let deviceCache = new Map();

const discoverDevices = async (apiKey) => {
  const res = await fetch(`${API_BASE}/user/devices`, {
    headers: { 'Govee-API-Key': apiKey }
  });
  if (!res.ok) throw new Error(`Govee discovery failed: ${res.status}`);
  const { data } = await res.json();
  return data; // [{ device, sku, deviceName, ... }]
};

const fetchSceneCatalog = async (apiKey, device, sku) => {
  const res = await fetch(`${API_BASE}/device/scenes`, {
    method: 'POST',
    headers: { 'Govee-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), payload: { sku, device } })
  });
  if (!res.ok) return {};
  const { payload } = await res.json();
  // Flatten all scene capability data points into name → capability object
  const map = {};
  for (const cap of payload?.capabilities ?? []) {
    for (const pt of cap?.parameters?.dataPoints ?? []) {
      if (pt.name) map[pt.name] = { type: cap.type, instance: cap.instance, value: pt.value };
    }
  }
  return map;
};

// Call once at startup (and on "Refresh" from property inspector)
const init = async (apiKey) => {
  const devices = await discoverDevices(apiKey);
  for (const d of devices) {
    const sceneMap = await fetchSceneCatalog(apiKey, d.device, d.sku);
    deviceCache.set(d.device, { sku: d.sku, sceneMap });
  }
  console.log(`[govee] Discovered ${deviceCache.size} device(s).`);
};

// On profile switch: activate named scene on all discovered (or allowlisted) devices
const activateScene = async (apiKey, sceneName, allowlist = null) => {
  const targets = allowlist
    ? [...deviceCache.entries()].filter(([id]) => allowlist.includes(id))
    : [...deviceCache.entries()];

  await Promise.allSettled(
    targets.map(async ([deviceId, { sku, sceneMap }]) => {
      const scene = sceneMap[sceneName];
      if (!scene) {
        console.warn(`[govee] Scene "${sceneName}" not found on device ${deviceId} — skipping.`);
        return;
      }
      const res = await fetch(`${API_BASE}/device/control`, {
        method: 'POST',
        headers: { 'Govee-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: randomUUID(),
          payload: { sku, device: deviceId, capability: scene }
        })
      });
      if (!res.ok) throw new Error(`Govee control failed: ${res.status}`);
    })
  );
};
```

Device configuration is fully automatic: call `init(apiKey)` at plugin startup and the driver discovers all Govee devices and builds their scene catalogs. **No device IDs to configure anywhere.** Scene names in profiles.yaml (`govee_scene: Racing`) must match scene names exactly as named in the Govee app. Scene values are resolved from the cache — users never see raw API compound values.

The optional `allowlist` parameter lets users target specific devices (configured in the property inspector). When absent, all discovered devices are addressed.

---

### Step 7 — `src/moza.js`

Phase 1 stub — logs intent, takes no action:
```javascript
const activateProfile = async (profileName) => {
  console.log(`[moza] Profile switch requested: ${profileName} (not yet implemented)`);
  // TODO: implement after locating Pit House profile files
  // Research: https://github.com/moza-studios (check for community tooling)
};
```

Replace with real implementation once file location is confirmed. See research notes at bottom of this file.

---

### Step 8 — `src/profileSwitch.js`

Orchestrates the macro chain. Each step independently try/caught.

```javascript
const switchProfile = async (profile, settings, onStepResult) => {
  const steps = [
    {
      name: 'fanatec',
      fn: () => fanatec.activatePreset(profile.fanatec_preset_hotkey)
    },
    {
      name: 'moza',
      fn: () => moza.activateProfile(profile.moza_profile)
    },
    {
      name: 'govee',
      fn: () => govee.activateScene(settings.govee_api_key, profile.govee_scene)
    },
    {
      name: 'sd_profile',
      fn: () => switchSDProfile(profile.sd_profile)  // via Stream Deck SDK event
    },
    {
      name: 'state',
      fn: () => state.writeState(profile.id)
    }
  ];

  for (const step of steps) {
    try {
      await step.fn();
      onStepResult(step.name, 'ok');
    } catch (err) {
      console.error(`[profileSwitch] Step ${step.name} failed:`, err.message);
      onStepResult(step.name, 'error');
    }
  }
};
```

`onStepResult` allows `app.js` to update button state during the chain (e.g. flash on error).

---

### Step 9 — `src/buttonRenderer.js`

The toggle button renders in three states:

**Normal (no picker open):**
- Background: active profile's `color`
- Title: active profile's `name`
- Generated as a base64 PNG using Node `canvas`

```javascript
const renderProfileButton = (profile) => {
  const canvas = createCanvas(144, 144);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = profile.color;
  ctx.fillRect(0, 0, 144, 144);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(profile.name, 72, 72);
  return canvas.toDataURL('image/png').split(',')[1]; // base64
};
```

**Transitioning:**
- Pulsing animation: set alternating images on a 200ms interval, clear on completion

**Picker open (bottom row):**
- Positions 24–31 temporarily replaced with profile picker buttons
- One button per profile (up to 8), colored + named
- Blank buttons for empty slots
- Auto-dismiss after 5 seconds of no input

---

### Step 10 — Long Press Detection in `app.js`

Stream Deck SDK fires `keyDown` and `keyUp` events. Long press = `keyDown` held without `keyUp` for > 600ms.

```javascript
let pressTimers = {};

onKeyDown(context, position) {
  pressTimers[position] = setTimeout(() => {
    delete pressTimers[position];
    openProfilePicker(context);
  }, 600);
}

onKeyUp(context, position) {
  if (pressTimers[position]) {
    clearTimeout(pressTimers[position]);
    delete pressTimers[position];
    cycleProfile(context);   // short press = cycle
  }
  // if timer already fired (long press), do nothing here
}
```

---

### Step 11 — `src/pickerMode.js`

```javascript
let pickerTimeout = null;
let pickerActive = false;
let savedBottomRow = null;   // store current bottom row state to restore on dismiss

const openPicker = (profiles, onSelect, onDismiss) => {
  pickerActive = true;
  // Render profile buttons at positions 24–31
  // Set dismiss timer
  pickerTimeout = setTimeout(() => dismissPicker(onDismiss), 5000);
};

const handlePickerPress = (position, profiles, onSelect, onDismiss) => {
  const idx = position - 24;
  if (idx < profiles.length) {
    clearTimeout(pickerTimeout);
    dismissPicker(onDismiss);
    onSelect(profiles[idx]);
  }
};

const dismissPicker = (onDismiss) => {
  pickerActive = false;
  // Restore bottom row
  onDismiss();
};
```

---

### Step 12 — `ui/property-inspector.html`

Fields:
- Govee API key (password input; leave blank to disable Govee integration)
- "Discover Devices" button — calls `govee.init()`, shows count and names of devices found
- Govee device allowlist (optional, advanced): comma-separated device IDs; when empty, all discovered devices are used
- "Test Govee" button — fires the first available scene on all devices as a connectivity check
- FanaLab note: reminder to configure hotkeys in FanaLab matching `fanatec_preset_hotkey` values in profiles.yaml
- "Open profiles.yaml" button

---

### Step 13 — Shared directory creation

Handled by `src/setup.js` — `ensureConfig()` calls `mkdirSync(sharedStateDir, { recursive: true })` where `sharedStateDir` is the cross-platform path exported as `SHARED_STATE_DIR`:

- Windows: `%APPDATA%\streamdeck-rig-shared`
- macOS:   `~/Library/Application Support/streamdeck-rig-shared`

Called automatically in `src/plugin.js` before `configLoader.init()`. No manual setup required.

---

### Step 14 — Validation & Test

Manual test checklist:
- [ ] `profiles.yaml` missing → template auto-copied, plugin loads
- [ ] On startup: button shows correct color + name for active profile from state.json
- [ ] Short press: cycles through all profiles in order, wraps to first after last
- [ ] Long press: bottom row shows profile picker within 600ms
- [ ] Picker: tap profile button → switch fires, picker dismisses
- [ ] Picker: no input for 5 seconds → picker dismisses, no switch
- [ ] Govee: scene changes on profile switch (verify in Govee app)
- [ ] Fanatec: FanaLab preset changes on profile switch (verify in FanaLab)
- [ ] Partial failure: disconnect Govee network, switch profile → button flashes red briefly, rest of chain completes
- [ ] `state.json` written after each switch
- [ ] `active-profile.json` written to shared dir after each switch
- [ ] Stream Deck restart: button immediately shows correct profile (reads state.json)

---

## Moza Research Notes

Moza Pit House has no public API, CLI, or SDK as of March 2026. No official Moza developer GitHub organization exists. No community tooling for programmatic profile switching was found.

---

**Path 1 — USB Serial Protocol (recommended)**

The open-source Boxflat project (`Lawstorant/boxflat`) reverse-engineered Moza’s USB serial communication protocol and documents it in `moza-protocol.md` in that repo. The protocol sends individual FFB parameters directly to device firmware over a virtual COM port — it bypasses Pit House entirely.

A Windows-compatible Node.js client using the `serialport` package and following the Boxflat protocol is the most robust implementation path:
- Activates the hardware profile state directly, regardless of Pit House state
- Works whether or not Pit House is running
- Requires COM port discovery (enumerate ports, identify Moza device)
- Moza firmware updates could break compatibility

See: `https://github.com/Lawstorant/boxflat` → `moza-protocol.md`

---

**Path 2 — AHK Window Automation (fallback)**

AutoHotkey can click through the Pit House UI to select a preset. No protocol reverse-engineering needed, but fragile (depends on UI layout stability across Pit House versions). No working community implementation found — would need to be developed from scratch against a running Pit House instance.

---

**Path 3 — Profile File Swap (not recommended)**

Community investigation (via the `pithouse2boxflat` converter project) confirms preset data is stored as JSON in `%APPDATA%\MOZA\PitHouse\` or similar. However, Pit House writes FFB parameters to device firmware at load time — it does not watch for file changes. Swapping a file while Pit House is running will not produce a live hardware change without also triggering a UI reload action.

---

**Current status:** Stub in `src/moza.js` — logs intent, no-op. Implement Path 1 once the serial protocol is validated against the target hardware.
