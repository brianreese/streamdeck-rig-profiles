# Implementation Plan: streamdeck-rig-profiles

## Prerequisites

- Node.js 18+ installed
- Stream Deck software installed and XL connected
- `@elgato/cli` installed globally
- FanaLab installed and running
- Govee API key in hand (device model numbers needed — check Govee app)

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
- Validate: each profile needs `id`, `name`, `color`; warn on unknown fields
- Watch for changes with `chokidar`, emit `config:updated`
- Expose: `getProfiles()`, `getProfileById(id)`, `getSettings()`

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
const API_BASE = 'https://developer-api.govee.com/v1/devices/control';

const setScene = async (apiKey, device, model, sceneName) => {
  const res = await fetch(API_BASE, {
    method: 'PUT',
    headers: { 'Govee-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device, model, cmd: { name: 'scene', value: sceneName } })
  });
  if (!res.ok) throw new Error(`Govee API error: ${res.status}`);
};

// Call for each device in the profile's govee_devices array
const setSceneAllDevices = async (apiKey, devices, sceneName) => {
  await Promise.allSettled(
    devices.map(d => setScene(apiKey, d.id, d.model, sceneName))
  );
  // allSettled: partial failures don't abort other devices
};
```

Govee device config lives in `property-inspector` settings (API key, device list), not in `profiles.yaml`. Device IDs and model numbers are entered once in the SD settings panel.

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
      fn: () => govee.setSceneAllDevices(settings.govee_api_key, settings.govee_devices, profile.govee_scene)
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
- Govee API key (password input)
- Govee devices: repeatable rows of (Device ID, Model, Label) — add/remove buttons
- "Test Govee" button — sets a neutral scene on all devices as a connectivity test
- FanaLab note: reminder to configure hotkeys in FanaLab matching profiles.yaml entries
- "Open profiles.yaml" button

---

### Step 13 — Shared directory creation

On plugin startup, ensure shared state directory exists:
```javascript
fs.mkdirSync(path.join(process.env.APPDATA, 'streamdeck-rig-shared'), { recursive: true });
```

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

Before implementing `moza.js` properly, find:

1. **Profile file location** — likely somewhere in:
   - `%APPDATA%\MOZA\`
   - `%PROGRAMDATA%\MOZA\`
   - `%USERPROFILE%\Documents\MOZA\`

2. **Profile file format** — probably JSON or XML. Need to confirm:
   - How profiles are identified (by name? by UUID?)
   - What field controls active profile
   - Whether Pit House hot-reloads when the file changes, or needs a signal

3. **Community resources to check:**
   - Moza Racing Discord (look for developer/API channels)
   - GitHub: search "moza pit house" for any community tooling
   - SimHub plugin source code (SimHub integrates with Moza — may reveal the file format)

Once file location and format are confirmed, implement:
```javascript
const activateProfile = async (profileName) => {
  // Option A: swap profile config file + signal reload
  // Option B: AHK window automation (fallback)
};
```
