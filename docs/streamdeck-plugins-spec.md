# Stream Deck Custom Plugins — Design Spec
**Rig:** TRX V2 / Fanatec ClubSport DD+ / Moza AB9 + Active Pedals
**Device:** Stream Deck XL (32 keys, 4×8)
**Stack:** Node.js, Stream Deck Plugin SDK
**Version:** 0.5
**Repo structure:** Polyrepo — two independent GitHub projects

---

## Overview

| Plugin | Repo | Purpose |
|---|---|---|
| Race Launcher | `streamdeck-ac-launcher` | Dynamic race browser powered by YAML config and/or CM presets |
| Profile Toggle | `streamdeck-rig-profiles` | Named user profile toggle with hardware macro orchestration |

Both plugins are independently useful and independently installable. Shared code (Govee client) is duplicated for now; extract to a shared npm package if a third plugin warrants it.

---

## Plugin 1: Race Launcher (`streamdeck-ac-launcher`)

### Goal

A multi-step race browser on the Stream Deck XL. Reads from a YAML config and/or existing Content Manager presets — both are optional, either is a valid starting point. Presents a navigable **Format → Track → Car → Options → GO** flow. Generates `race.ini` and `entry_list.ini` on the fly and launches `acs.exe` directly.

Designed for public GitHub release: portable, human-readable config, zero CM dependency at launch time.

---

### How AC Launching Works

AC reads two INI files at launch:
```
%USERPROFILE%\Documents\Assetto Corsa\cfg\race.ini
%USERPROFILE%\Documents\Assetto Corsa\cfg\entry_list.ini
```
The plugin writes these from the user's selections, then calls `acs.exe`. CM is not involved in the launch path but remains a useful configuration tool.

> **Implementation note:** Validate `race.ini` format against a CM-generated file on the target install before finalizing `iniGenerator.js`. Format is community-documented and stable but not officially specced.

---

### Data Sources

Two optional sources, both normalized to the same internal shape:

| Source | File | Notes |
|---|---|---|
| YAML config | `config/races.yaml` | Primary authoring surface for new setups |
| CM Presets | Scanned from CM presets dir | Great for users with existing CM libraries |

Neither source is "more important." Both are shown together in the UI. A `source` field (`"yaml"` or `"cm"`) is preserved for display. When both sources produce an identical track/car/format combination, both entries are shown — no silent deduplication.

CM preset entries can be tagged via a sidecar file (`config/cm-tags.yaml`) since CM's preset format has no native tags field.

---

### Content ID Discovery

Track and car IDs are **folder names** in the AC install:
```
content\tracks\monza\              → id: monza
content\tracks\silverstone\layouts\gp\  → id: silverstone, layout: gp
content\cars\ferrari_488_gt3\      → id: ferrari_488_gt3
```

The plugin ships a CLI scanner to help users discover IDs without manual folder browsing:
```bash
node tools/scan-content.js --ac-path "C:\...\assettocorsa"
# Outputs a ready-to-paste YAML block of all installed tracks and cars
```
This ships in Phase 1. It's the primary onboarding tool for new users.

---

### YAML Configuration

All fields except `id` are optional. The plugin infers display name from `id` if `name` is omitted.

```yaml
# ============================================================
# races.yaml — streamdeck-ac-launcher
# ============================================================
# Track and car IDs must match folder names in your AC install.
# Run `node tools/scan-content.js` to discover available IDs.
# ============================================================

settings:
  # Path to acs.exe. Supports %ENV_VARS%.
  ac_exe: "%PROGRAMFILES(X86)%\\Steam\\steamapps\\common\\assettocorsa\\acs.exe"

  # CM presets directory. Set null to disable CM preset scanning.
  cm_presets_dir: "%USERPROFILE%\\Documents\\Assetto Corsa\\cfg\\presets"

  # Show a confirmation/summary screen before launching.
  show_launch_confirm: true

  # Behavior when acs.exe is already running (checked at plugin entry, not at launch).
  # "focus"            — bring AC window to foreground immediately
  # "block"            — flash button red, abort
  # "confirm_relaunch" — offer to quit and relaunch
  on_ac_running: focus

  # Home screen layout strategy.
  # "dynamic"  — auto-layout based on deck size and number of featured entries (recommended)
  # "yaml"     — use layout_override section below
  home_layout: dynamic


# --- Tracks ---
# Minimum valid entry: just an id.
# layout: required only for multi-layout tracks (subfolder name under tracks/<id>/layouts/)
# tags: "kids" controls visibility in restricted profiles. Custom tags are allowed.

tracks:
  - id: monza
    name: Monza
    layout: null
    tags: [kids, featured]

  - id: spa
    name: Spa-Francorchamps
    tags: [featured]

  - id: silverstone
    name: Silverstone
    layout: gp

  - id: magione
    name: Magione
    tags: [kids]

  - id: imola

  - id: brands_hatch
    layout: gp

  - id: shutoko_revival_project
    name: Shutoko Revival Project


# --- Cars ---
# Minimum valid entry: just an id.
# group: optional, reserved for future UI grouping/filtering.

cars:
  - id: abarth500
    name: Abarth 500
    group: Road Cars
    tags: [kids]

  - id: bmw_m3_e30
    name: BMW M3 E30
    group: Road Cars
    tags: [kids]

  - id: ferrari_488_gt3
    name: Ferrari 488 GT3
    group: GT3

  - id: porsche_911_gt3_r
    name: Porsche 911 GT3 R
    group: GT3

  - id: ferrari_f2004
    name: Ferrari F2004
    group: Open Wheel

  - id: rss_formula_hybrid_2023
    name: RSS Formula Hybrid 2023
    group: Open Wheel


# --- Race Formats ---
# Values here are defaults — all can be overridden per-race on the Options page.

race_formats:
  sprint:
    name: Sprint
    laps: 5
    ai_count: 10
    ai_level: 85
    ai_aggression: 50
    qualifying: false
    practice: false
    time_of_day: midday
    weather: clear
    tags: [kids]

  full_race:
    name: Full Race
    laps: 20
    ai_count: 16
    ai_level: 90
    ai_aggression: 70
    qualifying: true
    practice: false
    time_of_day: midday
    weather: clear

  endurance:
    name: Endurance
    laps: 40
    ai_count: 20
    ai_level: 92
    ai_aggression: 60
    qualifying: true
    practice: true
    time_of_day: afternoon
    weather: cloudy

  quick_blast:
    name: Quick Blast
    laps: 3
    ai_count: 8
    ai_level: 80
    ai_aggression: 40
    qualifying: false
    practice: false
    time_of_day: midday
    weather: clear
    tags: [kids]


# --- Featured Combos ---
# Appear on the home screen before the full browser.
# format + track + car are resolved against entries above.
# tags: controls visibility per profile (same tag system as tracks/cars).

featured:
  - name: Monza Sprint
    format: sprint
    track: monza
    car: ferrari_488_gt3

  - name: Magione — Abarth
    format: quick_blast
    track: magione
    car: abarth500
    tags: [kids]

  - name: Spa Full Race
    format: full_race
    track: spa
    car: porsche_911_gt3_r
```

---

### Navigation Flow

```
[Plugin entry]
  → Check if acs.exe running → handle per on_ac_running (abort or continue)

HOME SCREEN
  ┌─────────────────────────────────────┐
  │  Featured combos  (rows 1–2 on XL) │
  │  Format row       (row 3)           │
  │  [Browse] [Back] [Profile] [...]    │  ← control row, always row 4
  └─────────────────────────────────────┘

  [Featured combo] → OPTIONS PAGE (track/car/format pre-filled, all adjustable)
  [Format button]  → TRACK SELECT

TRACK SELECT
  Up to 30 tracks + [Back] + pagination if needed

CAR SELECT  (track locked)
  Up to 30 cars + [Back] + pagination

OPTIONS PAGE  (format + track + car locked, all values overridable)
  ┌────────────────────────────────────────────────────┐
  │ [-] [85] [+] [AI Level ]  [-] [16] [+] [AI Count] │
  │ [-] [50] [+] [AI Aggr. ]  [Clear ◄►] [  Weather ] │
  │ [Midday◄►] [ Time/Day  ]  [OFF] [Practice]         │
  │ [OFF] [Qualifying]  [Back]  ...  ...  [🚦 GO ]     │
  └────────────────────────────────────────────────────┘

  Numeric controls: [-] shows current value as button label, [+] increments
  Toggle controls:  single button cycles ON/OFF, label shows current state
  Cycle controls:   single button cycles through options, label shows current value

  [GO] → generate race.ini + entry_list.ini → launch acs.exe
       → Stream Deck returns to calling profile
```

**Profile-filtered navigation:** When the active rig profile has `content_filter_tags` set, all Race Launcher pages (tracks, cars, formats) filter to show only content whose tags include **at least one** of the listed tags (OR logic). The same tag list is applied to all three content dimensions simultaneously. A profile with no `content_filter_tags` sees all content. When `skip_options_step: true`, the Options page is skipped and GO fires immediately after car selection.

**State persistence:** Navigation state is held in memory only. Switching away from the plugin (e.g. AC launches and triggers an in-game SD profile) resets the flow. This is intentional — you wouldn't want to be mid-config when you're already in a race. The running AC check at plugin entry handles re-entry gracefully.

---

### Home Screen Layout (Dynamic)

On XL (4×8):
- Rows 1–2: Featured combos (up to 16)
- Row 3: Format buttons (up to 7) + overflow indicator if more formats exist
- Row 4: `[Browse Formats]` `[Browse Tracks]` `[Browse Cars]` `[...]` `[...]` `[...]` `[...]` `[Profile Toggle]`

On smaller decks (3×5, 2×4):
- Row 1: Featured combos only (up to available width)
- Last row: Controls

`home_layout: yaml` enables a `layout_override` block for power users who want full control over key positions.

---

### Architecture

```
streamdeck-ac-launcher/
├── manifest.json
├── package.json
├── README.md
├── app.js                      # WebSocket entry point, SD event loop
├── config/
│   races.yaml                  # User config (copied from template on first run)
│   races.yaml.template         # Shipped default with inline comments
│   cm-tags.yaml                # Optional: tag overrides for CM preset entries
├── src/
│   configLoader.js             # Reads + file-watches races.yaml
│   cmPresetScanner.js          # Scans CM presets dir, normalizes to shared shape
│   raceIndex.js                # Merges both sources, applies profile filters
│   navigationStack.js          # Push/pop page state
│   pageRenderer.js             # Generates SD button layouts per page/state
│   optionsPage.js              # Options page state and control logic
│   iniGenerator.js             # Writes race.ini + entry_list.ini
│   launcher.js                 # acs.exe process management, running-check
│   processChecker.js           # tasklist wrapper for acs.exe detection
├── tools/
│   scan-content.js             # CLI: scans AC install, outputs YAML snippet
├── ui/
│   property-inspector.html     # SD settings panel: paths, profile config
└── assets/
    back.png / browse.png / go.png / placeholder-track.png / placeholder-car.png
```

---

### Phases

| Phase | Scope |
|---|---|
| 1 — MVP | YAML source only. Flat home screen (featured + formats). Full nav flow. Options page. `scan-content.js` tool. Launch AC. |
| 2 — CM Hybrid | Scan + merge CM presets. `cm-tags.yaml` sidecar. Source indicator on buttons. |
| 3 — Profile Filtering | Integrate with `streamdeck-rig-profiles` state. Apply tag filters per active profile. `skip_options_step` support. |
| 4 — Images | Track maps + car previews from AC asset dirs, rendered onto buttons. |
| 5 — Preview Overlay | Companion Electron/web app on secondary display. Local websocket. Track map, car preview, session summary. Controller/wheel navigation. |

---

## Plugin 2: Rig Profile Toggle (`streamdeck-rig-profiles`)

### Goal

A persistent, always-available button that switches the rig between named user profiles. Each profile has a name, color, hardware presets, Govee scene, and Stream Deck profile. Fires a resilient macro chain on each transition. Visible on every Stream Deck profile.

### Named Profiles

Profiles replace the binary kid/adult model. Any number of named profiles can be defined. Each has its own hardware state and optional race launcher filtering rules.

```yaml
# profiles.yaml — streamdeck-rig-profiles

profiles:
  - id: primary
    name: Primary
    color: "#2255CC"          # Button background when this profile is active
    fanatec_preset_hotkey: "ctrl+alt+f1"
    moza_profile: default
    govee_scene: Racing
    sd_profile: "Main Profile"
    # No race filter tags = sees all content in the launcher

  - id: secondary
    name: Secondary
    color: "#22AA44"
    fanatec_preset_hotkey: "ctrl+alt+f2"
    moza_profile: beginner
    govee_scene: "Beginner Mode"
    sd_profile: "Secondary Profile"
    # Applied to tracks, cars, and formats simultaneously (OR logic)
    content_filter_tags: [beginner, guest_profile]
    skip_options_step: true
    default_format: quick_blast

settings:
  # Profile to activate on plugin startup / rig boot
  default_profile: primary
```

---

### Toggle Button UX

**Short press:** Cycle to next profile in list order. Button immediately updates to show new profile name + color.

**Long press (hold ~600ms):** Opens profile picker. The bottom row of the current SD profile temporarily becomes one button per profile (color-coded, named). Tap to select, or wait 5 seconds with no input to dismiss without changing.

The toggle button always occupies **row 4, col 8 (bottom-right)** on every Stream Deck profile. This is a setup convention enforced by documentation, not code.

---

### Profile Switch Macro Chain

On every profile switch:
1. `fanatec.js` — send FanaLab hotkey
2. `moza.js` — swap profile (method TBD, see below)
3. `govee.js` — activate scene on all auto-discovered devices
4. `sdProfileSwitch` — send `switchToProfile` event to Stream Deck
5. `state.js` — write persistent state

Each step is independently try/caught. Failures produce a brief red flash on the button but do not abort the chain. Final button state always reflects the new profile regardless of partial failures.

---

### Persistent State

```json
// state.json (written to plugin data dir)
{
  "activeProfile": "primary",
  "lastSwitched": "2025-03-21T10:00:00Z"
}
```

Read on plugin startup. Button renders immediately to correct profile color and label. Survives reboots.

---

### AC Awareness

If `acs.exe` is running when the toggle fires:
- Hardware presets switch (Fanatec, Moza, Govee)
- Stream Deck profile switches
- No attempt to modify or relaunch AC

Mid-session handoff works correctly — wheel and pedal feel updates, SD profile updates, race continues.

---

### Hardware Integration

The plugin uses a **driver model**: each hardware integration is an independent module. `profileSwitch.js` iterates registered drivers on every profile switch — drivers not configured for a given profile are silently skipped. To add new hardware support, add a driver file and register it in `profileSwitch.js`; no changes to the core orchestration needed. Pull requests for new drivers are welcome.

---

**Fanatec (FanaLab)**

Method: global hotkey via `robotjs`
Profile field: `fanatec_preset_hotkey: "ctrl+alt+f1"`
Prerequisite: FanaLab must be running. Configure a matching hotkey for each FanaLab preset, matching the values in profiles.yaml.

---

**Moza (Pit House)**

Method: TBD — no public CLI or API as of early 2026. Implementation is a no-op stub.
Profile field: `moza_profile: "default"`

Investigation paths in priority order:
1. **USB serial protocol** — the Boxflat project (`Lawstorant/boxflat`) reverse-engineered Moza’s USB serial protocol and documents it in `moza-protocol.md`. A Windows Node.js client using `serialport` following the same protocol is the most robust option — it communicates directly with device firmware, bypassing Pit House entirely.
2. **AHK window automation** — clicks through the Pit House UI to select a preset. Fragile but requires no protocol work.
3. **Profile file swap** — community points to preset JSON files in `%APPDATA%\MOZA\PitHouse\`, but Pit House does not hot-reload from file changes; it writes parameters to firmware at load time.

See *Moza Research Notes* in the impl plan.

---

**Govee**

Method: Govee Developer REST API (`openapi.api.govee.com/router/api/v1`)
Profile field: `govee_scene: "Racing"` — must match a scene name exactly as configured in the Govee app
Config: `govee_api_key` in the `settings` block of profiles.yaml

Design principle: **all lighting configuration lives in the Govee app.** The plugin never stores colors, brightness, or effect parameters.

The `govee.js` driver auto-discovers all Govee devices linked to the API key (`GET /user/devices`) at plugin startup, then fetches each device’s scene catalog (`POST /device/scenes`) and caches scene name → API value mappings locally. Scene values are device-model-specific compound objects — users never interact with raw IDs. On profile switch, the driver looks up the scene name in each device’s cache and fires one control call per device.

Optional property inspector setting: device allowlist (for users with many Govee devices who want to target only rig-area devices). Default: all discovered devices.

> **Note:** The Govee LAN API does not support scene activation (only on/off, brightness, color). Cloud API is required for scene switching.

---

**Adding a new hardware driver**

Implement the interface in a new source file:

```javascript
export const name = 'yourdevice';
/** Return true if this driver has the config it needs to operate. */
export function isAvailable(settings) { ... }
/** Activate hardware state for this profile. Throw on failure. */
export async function activate(profileConfig, settings) { ... }
```

Register it in `profileSwitch.js` and document required profile field(s) and prerequisites.

---

### Button Appearance

| State | Appearance |
|---|---|
| Profile active | Profile color background, profile name label |
| Transitioning | Pulsing, neutral color |
| Picker open | Bottom row: one button per profile, colored |
| Step failure | Brief red flash, resolves to new profile state |

---

### Architecture

```
streamdeck-rig-profiles/
├── manifest.json
├── package.json
├── config/
│   profiles.yaml.template     # Committed template bundled with plugin
│   profiles.yaml              # User-generated; created/edited on first run
├── README.md
├── src/
│   plugin.js                  # Entry point: setup → config → streamDeck.connect()
│   setup.js                   # First-run helper: copy template, create shared state dir
│   setup.test.js              # Unit tests: first-run copy, shared state dir
│   profileSwitch.js           # Orchestrates macro chain; iterates hardware drivers
│   fanatec.js                 # Driver: FanaLab hotkey bridge (robotjs)
│   moza.js                    # Driver: Pit House (stub — implementation TBD)
│   govee.js                   # Driver: Govee scene client (auto-discovery + cache)
│   state.js                   # Persistent state read/write
│   buttonRenderer.js          # Button image/color/label per profile state
│   pickerMode.js              # Long-press picker overlay logic
│   configLoader.js            # Config loading, validation, hot-reload
│   configLoader.test.js       # Unit tests: loading, validation, defaults, coercion
├── ui/
│   property-inspector.html    # Govee API key; optional device allowlist; FanaLab setup notes
└── assets/
    transitioning.png / error.png
```

---

## Integration Between Plugins

The two plugins communicate via a **shared local state file**:
```
%APPDATA%\streamdeck-rig-shared\active-profile.json
{ "activeProfile": "primary" }
```

`streamdeck-rig-profiles` writes this on every profile switch.
`streamdeck-ac-launcher` reads this on plugin entry to apply the correct tag filters.

No direct websocket coupling between plugins in Phase 1. The file-based approach is simpler, survives independent restarts, and is easy to debug.

---

## Open TODOs Before Implementation

- [ ] Confirm `acs.exe` path and `race.ini` format on target install
- [ ] Configure FanaLab hotkeys for each profile (ctrl+alt+f1, f2, f3...)
- [ ] Investigate Moza: evaluate Boxflat serial protocol vs. AHK automation; confirm which is viable on Windows
- [ ] Set up Govee API key; confirm scene names in Govee app match `govee_scene` values in profiles.yaml
- [ ] Decide GitHub userhandle / org for public repos
- [ ] Decide license (MIT recommended for maximum adoption)

---

## Future Considerations

- SimHub integration in profile switch (bass shaker intensity per profile)
- ACSM integration — "Race Night" button hits AC Server Manager API, also driven by `races.yaml`
- Session logging — profile switches logged with timestamps
- Home Assistant bridge — if adopted, Govee + SD switching route through HA
- Phase 5 overlay — Electron companion with controller/wheel navigation, track map, car preview
