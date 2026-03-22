# Human Implementation Guide
## Stream Deck AC Launcher + Rig Profiles — Agent-Assisted Build

This guide walks you through building both plugins using an AI coding agent (Copilot, Claude in VSCode, Cursor, etc.). Each section is a discrete chunk of work with a suggested agent prompt and a review checklist before moving on.

Work through the plugins in this order:
1. **Rig Profiles first** — it's smaller, self-contained, and the profile state it produces is consumed by the Race Launcher
2. **Race Launcher second** — larger, builds on the profile system

---

## Before You Start

### One-time setup
```bash
npm install -g @elgato/cli
# Verify Stream Deck software is running and XL is connected
streamdeck version  # should print a version number
```

### Create your repos
Create two empty GitHub repos:
- `streamdeck-rig-profiles`
- `streamdeck-ac-launcher`

Clone both locally.

### Have these files open in your editor
- `streamdeck-plugins-spec.md` — the design spec
- `rigprofiles-impl-plan.md` — implementation plan for profiles plugin
- `racelauncher-impl-plan.md` — implementation plan for launcher plugin

---

# Part 1: streamdeck-rig-profiles

---

## Chunk 1 — Scaffold + YAML config

### What you do
```bash
cd streamdeck-rig-profiles
streamdeck create
# Answer prompts: ID = com.rig.profiles, Name = Rig Profile Toggle, JS/Node
npm install js-yaml chokidar robotjs node-fetch canvas
```

### Agent prompt
```
I'm building a Stream Deck plugin called "Rig Profile Toggle" (com.rig.profiles).
I've scaffolded it with the @elgato/cli tool. The plugin lets users define named
profiles (like user accounts for a sim rig) in a YAML file, and toggle between
them with a Stream Deck button.

Please create:
1. config/profiles.yaml.template — a well-commented YAML template with 3 example
   profiles (one adult, two kids with different settings). Each profile has: id,
   name, color (hex), fanatec_preset_hotkey (e.g. "ctrl+alt+f1"), moza_profile
   (string), govee_scene (string), sd_profile (string, must match SD profile name
   exactly), and optional filter tags: track_filter_tag, car_filter_tag,
   format_filter_tag, skip_options_step (bool), default_format (string).
   A `settings` section has: default_profile (id string), govee_api_key (string).

2. src/configLoader.js — loads and validates profiles.yaml using js-yaml. Watches
   for file changes using chokidar. Validates that each profile has id, name, color.
   Fills sensible defaults for missing optional fields. Exposes: getProfiles(),
   getProfileById(id), getSettings(), onUpdate(callback).

3. On first run (plugin startup), if config/profiles.yaml doesn't exist, auto-copy
   the template. Implement this in a setup.js helper.

Use the attached spec and implementation plan as your reference.
```

### Review checklist
- [ ] Template has clear inline comments on every field
- [ ] `configLoader.js` doesn't crash on missing optional fields
- [ ] File watcher triggers callback when you save a change to the yaml
- [ ] Auto-copy template works when yaml is absent

---

## Chunk 2 — Persistent state + shared directory

### Agent prompt
```
In the streamdeck-rig-profiles plugin, create src/state.js.

It manages two state files:
1. Plugin-local state: `<plugin-data-dir>/state.json` — used to restore button
   appearance on SD restart
2. Shared state: `%APPDATA%/streamdeck-rig-shared/active-profile.json` — read
   by the companion Race Launcher plugin to apply profile filtering

Both files have shape: { "activeProfile": "profile-id", "lastSwitched": "ISO timestamp" }

The module should:
- Create the shared directory if it doesn't exist (mkdirSync recursive)
- readState(): returns parsed state, returns { activeProfile: null } gracefully if
  either file is missing or malformed
- writeState(profileId): writes both files atomically (write to .tmp then rename)
- Export both functions

Also create a small integration test (state.test.js) that writes, reads back, and
verifies the values. Use Node's built-in assert module, no test framework needed.
```

### Review checklist
- [ ] Test passes: `node state.test.js`
- [ ] Shared directory created automatically
- [ ] Handles missing/corrupt files gracefully

---

## Chunk 3 — Hardware integration (Fanatec + Govee)

### Agent prompt
```
In the streamdeck-rig-profiles plugin, create two hardware integration modules:

1. src/fanatec.js
   - parseHotkey(str): parses "ctrl+alt+f1" → { mods: ['control', 'alt'], key: 'f1' }
     Handle variations: "ctrl" → "control", "cmd" → "command"
   - activatePreset(hotkeyStr): if hotkeyStr is null/undefined, return silently (no-op).
     Otherwise use robotjs to fire the hotkey.
   - Export: { activatePreset }

2. src/govee.js
   Uses auto-discovery — no device IDs are configured anywhere; the API key is
   sufficient. Design from the impl plan (Step 6):

   - init(apiKey): call once at plugin startup.
     1. GET /user/devices → discover all devices linked to the API key
     2. POST /device/scenes per device → build a scene name → capability cache
     Log count of devices discovered.

   - activateScene(apiKey, sceneName, allowlist = null):
     Iterate the device cache (filtered to allowlist if provided).
     Look up sceneName in each device's cache; warn + skip if not found.
     POST /device/control per device. Use Promise.allSettled so one device
     failure does not cancel others.

   - Export: { init, activateScene }

   API base: https://openapi.api.govee.com/router/api/v1
   Auth header: Govee-API-Key

   Write a manual test script (test-govee.js) that accepts --key as a CLI arg
   (never hardcode keys). It should call init(), log discovered devices, then
   call activateScene() with a scene name passed via --scene.

3. src/moza.js
   - activateProfile(profileName): stub only for now. Log the intent with console.log.
     Return a resolved promise. Add a TODO comment explaining what needs to be
     implemented once Pit House profile file location is confirmed.
   - Export: { activateProfile }

No test framework — write simple manual test scripts (test-fanatec.js, test-govee.js)
that can be run with node to verify each module works against real hardware.
For test-govee.js, accept API key and device info as command line args so the
key isn't hardcoded.
```

### Review checklist
- [ ] `node test-govee.js --key YOUR_KEY --scene "Racing"` discovers devices and triggers the scene on all of them
- [ ] Govee: `init()` logs the correct device count
- [ ] Fanatec: hotkey fires (verify FanaLab changes preset)
- [ ] Govee: one unreachable/missing-scene device doesn't crash the others (Promise.allSettled)
- [ ] Moza stub: no crash, logs message

---

## Chunk 4 — Profile switch orchestrator + button renderer

### Agent prompt
```
In the streamdeck-rig-profiles plugin, create:

1. src/profileSwitch.js
   Exports: switchProfile(profile, settings, onStepResult)
   - Runs 5 steps in sequence: fanatec, moza, govee, sd_profile_switch, write_state
   - Each step is independently try/caught
   - onStepResult(stepName, 'ok' | 'error') is called after each step
   - sd_profile_switch is a placeholder for now — accept a switchSDProfile(name)
     function as a parameter so plugin.js can inject the real SD SDK call later

2. src/buttonRenderer.js
   Uses the `canvas` npm package to generate button images as base64 PNG strings.
   Exports:
   - renderActiveButton(profile): colored background (profile.color), white bold
     profile name centered, 144x144px
   - renderTransitioning(): dark grey background, white "..." centered
   - renderError(): red background, white "!" centered
   - renderPickerButton(profile): same as renderActiveButton but slightly smaller
     text to fit within a picker context

All render functions return a base64 string (without the data:image/png;base64, prefix).
```

### Review checklist
- [ ] Run a quick visual test: `node -e "const r = require('./src/buttonRenderer'); require('fs').writeFileSync('test.png', Buffer.from(r.renderActiveButton({name:'Brian',color:'#2255CC'}), 'base64'))"` — open test.png and verify it looks right
- [ ] Transitioning and error buttons render without crash

---

## Chunk 5 — plugin.js: short press, long press, picker

### Agent prompt
```
In the streamdeck-rig-profiles plugin, implement the main logic in src/plugin.js
— the existing entry point using the @elgato/streamdeck SDK.
(The file already exists with a skeleton; fill in the action handlers.)
Do not create a new app.js.

The plugin has a single action: com.rig.profiles.toggle
This action is placed at the same position on every Stream Deck profile.

Implement:
1. On plugin startup:
   - Load config (configLoader.js)
   - Read state (state.js)
   - Set button image to renderActiveButton for the current active profile

2. Short press (keyDown then keyUp within 600ms):
   - Cycle to next profile in the profiles array (wrap around)
   - Call switchProfile with all hardware steps
   - Update button image as chain progresses:
     - During transition: renderTransitioning
     - On any step error: flash renderError for 300ms, then continue
     - On completion: renderActiveButton for new profile

3. Long press (keyDown held 600ms without keyUp):
   - Open profile picker: replace positions 24–31 (bottom row) with one
     renderPickerButton per profile + blank buttons for empty slots
   - Auto-dismiss after 5 seconds if no selection
   - On picker button press: switch to that profile (same chain as short press),
     then restore bottom row

4. On config file update (configLoader onUpdate):
   - Reload profiles
   - If active profile id still exists, re-render button
   - If active profile was removed, switch to settings.default_profile

Keep the long-press timer and picker state in module-level variables.
Add comments explaining each section.
```

### Review checklist
- [ ] Short press cycles profiles: Brian → Kai → Riley → Brian
- [ ] Button color and name update correctly after each cycle
- [ ] Long press shows picker on bottom row within ~600ms
- [ ] Tapping a picker button switches to that profile
- [ ] Picker auto-dismisses after 5 seconds with no input
- [ ] Editing profiles.yaml while plugin runs: changes take effect
- [ ] Stream Deck restart: button shows correct profile immediately

---

## Chunk 6 — Property inspector + README

### Agent prompt
```
In the streamdeck-rig-profiles plugin:

1. Create ui/property-inspector.html — the settings panel shown when a user
   right-clicks the action in Stream Deck.
   Fields:
   - Govee API Key (password type input)
   - "Discover Devices" button — sends the key to plugin.js, which calls
     govee.init(); display the count and names of devices found inline
     (e.g. "Found 3 devices: Strip 1, Lightbar, Desk Lamp")
   - Govee device allowlist (optional, advanced): comma-separated device IDs;
     leave blank to address all discovered devices. Label it clearly as
     optional/advanced so most users skip it.
   - "Test Govee" button — triggers activateScene() with the first available
     scene on all devices as a connectivity check; show success/failure inline
   - An "Open profiles.yaml" button that opens the config file in the default
     system editor (shell.openPath)
   - A note/callout section: "Remember to configure matching hotkeys in FanaLab
     before testing profile switching"

   Use the Stream Deck Property Inspector SDK for two-way communication with plugin.js.
   Settings should persist via sendToPlugin/sendToPropertyInspector pattern.

2. Create README.md covering:
   - What the plugin does (1 paragraph)
   - Installation (npm install, streamdeck link)
   - Configuration: how to edit profiles.yaml, field reference table
   - FanaLab setup: how to configure hotkeys
   - Govee setup: how to get an API key, how device auto-discovery works,
     what scene names must match (Govee app names), optional allowlist
   - Moza: current status (not yet implemented), link to tracking issue
   - Troubleshooting: FanaLab not running, Govee API errors
```

### Review checklist
- [ ] Settings panel opens when right-clicking the action
- [ ] Govee API key saves and reloads correctly
- [ ] "Discover Devices" button finds and displays device names
- [ ] "Test Govee" button triggers a scene change on all discovered devices
- [ ] README is clear enough that a stranger could install and configure the plugin

---

## Chunk 7 — Polish, error handling, publish prep

### Agent prompt
```
In the streamdeck-rig-profiles plugin, do a final pass for robustness:

1. Audit every async call for proper error handling — no unhandled promise rejections
2. If profiles.yaml is deleted while the plugin is running, handle gracefully
   (log warning, maintain last known state, don't crash)
3. Add a manifest.json review: ensure icon, description, and category are set
   appropriately for a public release
4. Add a .gitignore that excludes node_modules, data/state.json (plugin-local
   state written at runtime), any file matching **/config/profiles.yaml (user
   config should not be committed; only the template should be in the repo)
5. Verify package.json has correct main entry, license field (MIT), and a
   "link" script: "streamdeck link" for dev installation
```

### Review checklist
- [ ] Delete profiles.yaml while running: no crash, log warning
- [ ] `.gitignore` excludes node_modules and user config
- [ ] `npm run link` installs the plugin into Stream Deck successfully
- [ ] Plugin appears in Stream Deck with correct name, icon, description

---

# Part 2: streamdeck-ac-launcher

Work through this after Rig Profiles is stable and installed.

---

## Chunk 1 — Scaffold + config + scan tool

### Agent prompt
```
I'm building a Stream Deck plugin called "AC Race Launcher" (com.rig.racelauncher).
It reads a YAML config (and optionally scans Content Manager presets) to build
a navigable race browser on the Stream Deck. It generates race.ini and entry_list.ini
and launches acs.exe directly.

Please create:

1. Scaffold: run `streamdeck create` mentally and produce the manifest.json,
   package.json with dependencies (js-yaml, chokidar), and app.js skeleton.

2. config/races.yaml.template — per the spec. Key points:
   - settings section: ac_exe path with %ENV_VAR% support, cm_presets_dir (nullable),
     show_launch_confirm (default true), on_ac_running (default "focus"),
     home_layout (default "dynamic")
   - tracks: id required only; name, layout, tags all optional
   - cars: id required only; name, group, tags optional
   - race_formats: name and laps required; all other fields optional with defaults
   - featured: format, track, car keys (string refs), name, tags
   - Inline comments throughout, especially explaining how to find track/car IDs

3. src/configLoader.js — same pattern as the rig-profiles plugin:
   parse, validate, watch, defaults, onUpdate callback.
   Default for track/car name: use id if name is omitted (apply at render time,
   not parse time — store null).

4. tools/scan-content.js — CLI tool:
   - Accepts --ac-path (optional, tries common Steam paths if omitted)
   - Scans content/tracks/ for track folders; checks each for layouts/ subdirectory
   - Scans content/cars/ for car folders
   - Outputs a YAML snippet ready to paste into races.yaml
   - Usage: node tools/scan-content.js [--ac-path PATH] [--tracks-only] [--cars-only]
```

### Review checklist
- [ ] `node tools/scan-content.js` finds your AC install and outputs valid YAML
- [ ] Output includes layout names for multi-layout tracks
- [ ] Template yaml is comprehensive and well-commented
- [ ] configLoader handles missing optional fields without crash

---

## Chunk 2 — Race index + navigation stack

### Agent prompt
```
In the streamdeck-ac-launcher plugin, create:

1. src/raceIndex.js
   Accepts: { tracks, cars, formats, featured } from configLoader
   Builds lookup maps: tracksById, carsById, formatsById
   Resolves featured entries: replaces string ids with full objects, warns on
   missing refs but doesn't crash (omit broken featured entries)

   Exposes filtered views (Phase 1: profileTags is always null, return all):
   - getTracks(profileTags?)
   - getCars(profileTags?)
   - getFormats(profileTags?)
   - getFeatured(profileTags?)

   Tag filtering logic: if profileTags is null, return all. If profileTags is a
   string, return only entries whose tags array includes that string, OR entries
   with an empty/absent tags array...

   Wait — actually, filtering should be EXCLUSIVE for "kids" profiles:
   only show entries that have the filter tag. Entries with no tags are shown
   to everyone. Implement: if filterTag is set, include entries that either
   have the filterTag OR have an empty tags array.

2. src/navigationStack.js
   A simple stack. Each frame is an object with shape:
   { page, selectedFormat, selectedTrack, selectedCar, optionsOverrides, pageOffset }

   Pages: 'home' | 'track_select' | 'car_select' | 'options' | 'confirm' | 'launching'

   Methods: push(page, partialState), pop(), reset(), current()
   reset() returns to: { page: 'home', selectedFormat: null, selectedTrack: null,
     selectedCar: null, optionsOverrides: {}, pageOffset: 0 }

   Write a simple unit test (nav.test.js) that pushes a few pages and verifies
   pop() returns correct state.
```

### Review checklist
- [ ] `node nav.test.js` passes
- [ ] Tag filtering: empty-tags tracks appear in kid view
- [ ] Tag filtering: untagged tracks appear in adult view
- [ ] Broken featured refs (missing id): warning logged, entry omitted

---

## Chunk 3 — Process checker + INI generator

### Agent prompt
```
In the streamdeck-ac-launcher plugin, create:

1. src/processChecker.js
   - isACRunning(): uses `tasklist /FI "IMAGENAME eq acs.exe" /NH`, returns boolean
   - focusACWindow(): PowerShell script that calls SetForegroundWindow on the acs.exe
     main window handle. Wrap in try/catch — non-fatal if it fails.
   - Export both functions

2. src/iniGenerator.js
   Accepts a resolved race config:
   {
     track: { id, layout },
     car: { id },
     format: { laps, ai_count, ai_level, ai_aggression, qualifying, practice,
               time_of_day, weather },
     overrides: {}   // same shape as format fields, overrides format values
   }

   Merges format + overrides (overrides win).

   Writes two files:
   - %USERPROFILE%\Documents\Assetto Corsa\cfg\race.ini
   - %USERPROFILE%\Documents\Assetto Corsa\cfg\entry_list.ini

   Before writing, backs up existing files as .bak.

   For race.ini: generate the [RACE] section with TRACK, TRACK_CONFIG (layout or
   empty), CARS (player car), CARS_COUNT, RACE_LAPS, AI_LEVEL, RACE_EXTRA_LAP=0.
   Add SESSION blocks based on practice/qualifying flags.

   IMPORTANT: leave a clear TODO comment saying "validate these field names against
   a CM-generated race.ini before first real test" — we need to verify the exact
   INI field names from a real file.

   For entry_list.ini: player in [CAR_0] with MODEL=<car_id>, SKIN=, BALLAST=0,
   RESTRICTOR=0. AI entries [CAR_1] through [CAR_N] with same model, DRIVER_NAME
   generated as "AI Driver 1" etc.

   Export: generateIni(raceConfig)
```

### Review checklist
- [ ] `isACRunning()` returns true when AC is running, false when not
- [ ] `focusACWindow()` doesn't crash when AC is not running
- [ ] `generateIni()` produces files in the correct location
- [ ] Backup files created (.bak)
- [ ] TODO comment present in iniGenerator.js reminding to validate field names

---

## Chunk 4 — Page renderer (home + nav pages)

### Agent prompt
```
In the streamdeck-ac-launcher plugin, create src/pageRenderer.js.

This module takes the current navigation state + raceIndex and returns an array
of 32 button descriptors (one per Stream Deck key, 0–31).

Button descriptor shape: { position: number, title: string, action: string, imagePath?: string }
action is a string key that app.js will switch on. Use namespaced format:
  'nav:home', 'nav:back', 'nav:go', 'nav:page_next', 'nav:page_prev'
  'select_format:<id>', 'select_track:<id>', 'select_car:<id>'
  'select_featured:<index>'
  'options:increment:<field>', 'options:decrement:<field>'
  'options:cycle:<field>', 'options:toggle:<field>'

Implement these pages:

HOME (XL, dynamic layout):
  Positions 0–15: featured combos (name as title, action select_featured:N)
                  blank for empty slots
  Positions 16–22: format buttons (name as title, action select_format:id)
  Position 23: blank or "More..." if >7 formats
  Positions 24–26: [Browse Tracks] [Browse Cars] [Browse Formats] (nav:browse_* actions)
  Positions 27–30: blank
  Position 31: { title: '👤', action: 'profile:toggle' }  ← reserved for rig-profiles

TRACK_SELECT / CAR_SELECT (shared layout):
  Items fill positions 0–27 based on pageOffset (28 items per page)
  Position 28: [◀ Prev] if pageOffset > 0, else blank
  Position 29: [Next ▶] if more items exist, else blank
  Position 30: blank
  Position 31: [Back]

OPTIONS:
  Row 1 (0–7):   [-][AI Level][+][AI Level label]   [-][AI Count][+][AI Count label]
  Row 2 (8–15):  [-][AI Aggr.][+][AI Aggr. label]   [Weather value][Weather label][blank][blank]
  Row 3 (16–23): [Time value][Time label][blank][blank]  [Practice state][Practice label][Qual state][Qual label]
  Row 4 (24–31): [Back][blank][blank][blank][blank][blank][blank][GO 🚦]

For numeric controls: center button title is the current value (from optionsOverrides
or format defaults). Bounds: ai_level 0–100 step 5, ai_count 1–30 step 1,
ai_aggression 0–100 step 10.

For cycle controls (weather, time_of_day): button title is current value.
Weather cycle: clear → cloudy → light_rain → heavy_rain → clear
Time of day cycle: dawn → morning → midday → afternoon → dusk → night → dawn

For toggles (practice, qualifying): button title is "ON" or "OFF".
```

### Review checklist
- [ ] Home page: 3 featured entries show in positions 0, 1, 2; rest blank
- [ ] Format row: correct number of format buttons
- [ ] Track select: 30 items paginate correctly (test with >28 tracks)
- [ ] Options page: all controls in correct positions
- [ ] Back button always at position 31 on nav pages
- [ ] GO button always at position 31 on options page (position 31 — wait, check this with options layout above)

> **Note:** Reconcile position 31 conflict between Back/GO on the options page vs. profile toggle. Options page should put GO at position 31, Back at position 24, and leave position 31 free on all non-options pages for the profile toggle.

---

## Chunk 5 — Launcher + app.js

### Agent prompt
```
In the streamdeck-ac-launcher plugin:

1. Create src/launcher.js
   - launch(raceConfig, settings):
     1. Call isACRunning()
     2. If running: handle per settings.on_ac_running
        - 'focus': call focusACWindow(), return { launched: false, reason: 'already_running' }
        - 'block': return { launched: false, reason: 'blocked' }
        - 'confirm_relaunch': return { launched: false, reason: 'needs_confirm' }
           (app.js handles the confirm UI)
     3. Call generateIni(raceConfig)
     4. Resolve ac_exe path (replace %VAR% patterns using process.env)
     5. spawn(acExe, [], { detached: true, stdio: 'ignore' }).unref()
     6. Return { launched: true }
   - Export: { launch }

2. Implement app.js — the main entry point.
   On keyDown for the plugin's single action (com.rig.racelauncher.browse):

   - First keypress (plugin entry): check isACRunning(), handle per config,
     then render home page using pageRenderer

   - Subsequent keypresses: look up the action string for the pressed position
     from the last rendered button descriptor array. Switch on action:

     'select_format:<id>' → push track_select to nav stack, re-render
     'select_track:<id>'  → push car_select to nav stack, re-render
     'select_car:<id>'    → push options page (or skip to confirm if skip_options), re-render
     'select_featured:<n>'→ pre-fill format/track/car from featured[n], push options or confirm
     'nav:back'           → pop nav stack, re-render (if stack empty, reset to home)
     'nav:go'             → call launcher.launch(), on success reset nav and return to SD profile
     'nav:page_next'      → increment pageOffset on current frame, re-render
     'nav:page_prev'      → decrement pageOffset, re-render
     'options:increment:<field>' → update optionsOverrides, re-render options
     'options:decrement:<field>' → update optionsOverrides, re-render options
     'options:cycle:<field>'     → advance cycle, update overrides, re-render
     'options:toggle:<field>'    → flip boolean, update overrides, re-render
     'profile:toggle'     → no-op in this plugin (handled by rig-profiles)

   Use setTitle for all button labels in Phase 1 (no images yet).

   Read active profile from shared state file on startup. Watch the file for changes
   and re-render home if profile changes (filters may change).
```

### Review checklist
- [ ] Tap plugin button → home screen renders on SD
- [ ] Navigate full flow: home → format → track → car → options → GO
- [ ] GO launches acs.exe and SD returns to normal profile
- [ ] Back from each page works correctly
- [ ] AC already running (focus mode): AC comes to foreground, nav resets
- [ ] Pagination works on track/car select pages
- [ ] Featured combo skips to options with correct pre-filled values

---

## Chunk 6 — Validate race.ini against real AC

This chunk is you + the agent working from real data.

### What you do
1. Open Content Manager, set up a simple race (Monza, any car, 5 laps, no practice or quali)
2. Launch the race, immediately quit
3. Open `%USERPROFILE%\Documents\Assetto Corsa\cfg\race.ini`
4. Copy the full contents

### Agent prompt
```
Here is the race.ini that Content Manager generated for a race at Monza:

[paste your actual race.ini contents here]

Compare this against the iniGenerator.js I have in src/iniGenerator.js.
Identify any field names or section names that differ from what we're generating.
Update iniGenerator.js to match the exact format from this real file.
Pay attention to: section names, field name casing, TRACK_CONFIG vs TRACK_LAYOUT,
how AI count is specified, how sessions are structured.
```

### Review checklist
- [ ] Launch a race using the plugin — AC opens and starts the race correctly
- [ ] Correct track loads
- [ ] Correct car loads
- [ ] AI count matches what was configured

---

## Chunk 7 — CM preset scanning (Phase 2)

### Agent prompt
```
In the streamdeck-ac-launcher plugin, add Phase 2: CM preset scanning.

1. src/cmPresetScanner.js
   - Accepts a presets directory path
   - Scans for preset files (research the file extension — likely .ini or no extension)
   - Parses each preset to extract: track id, track layout, car id, laps,
     ai_level, ai_count, ai_aggression, qualifying, practice
   - Returns array of normalized race objects with source: 'cm'
   - Handles parse errors per-file (skip broken presets with a warning, don't crash)
   - Watches directory for changes with chokidar

   NOTE: You'll need to inspect a real CM preset file first. Add a TODO comment
   in the function noting that the field names need to be validated against a
   real preset file. For now, implement based on the assumption that CM presets
   are INI files with the same field names as race.ini.

2. config/cm-tags.yaml — a sidecar file format:
   preset_name_here: [kids, featured]
   another_preset: [kids]

   Create src/cmTagsLoader.js to load this file and expose getTagsForPreset(name).

3. Update src/raceIndex.js to accept a second source array and merge it.
   Add a source field to each entry. Update the render to show a small "(CM)"
   suffix in the button title for CM-sourced entries.
```

---

## Chunk 8 — README + publish prep

### Agent prompt
```
In the streamdeck-ac-launcher plugin, create README.md for public GitHub release.

Cover:
- What it does (2 paragraphs — one for the Stream Deck navigation concept,
  one for the "no CM required at launch time" technical aspect)
- Requirements (Node, Stream Deck software, AC install)
- Installation steps
- Configuration: races.yaml field reference table (all fields, types, defaults,
  descriptions). Note which fields are optional.
- How to find track and car IDs (explain the folder name convention + scan tool)
- CM preset integration: how it works, what the sidecar file is for
- Known limitations / roadmap (Moza not yet implemented, image rendering Phase 4,
  overlay Phase 5)
- Contributing guidelines (brief)

Also add .gitignore excluding node_modules, config/races.yaml (user config),
config/cm-tags.yaml, and any *.bak files.
```

---

## Final Integration Test

Once both plugins are installed and configured:

1. Set profiles.yaml with your 3 profiles
2. Set races.yaml with 3–4 tracks, 3–4 cars, 3 formats, 2–3 featured combos
3. Configure FanaLab hotkeys matching your profiles.yaml entries
4. Configure Govee device IDs in the property inspector

**Test sequence:**
- [ ] Rig profiles: short press cycles Brian → Kai → Riley → Brian, colors change
- [ ] Rig profiles: long press shows 3-button picker on bottom row
- [ ] Race launcher: home screen shows featured combos + format row
- [ ] Race launcher: complete a full flow and verify AC launches correctly
- [ ] Profile switch while in race launcher: home re-renders with Kai's filters
- [ ] Kai's profile: options step skipped, GO appears after car select
- [ ] Kid profile: only kids-tagged tracks/cars appear

---

## Tips for Working with AI Agents

- **Paste relevant spec sections** into the prompt context, not just a description. The more specific the reference, the better the output.
- **One chunk at a time.** Don't ask for multiple modules in one prompt unless they're tightly coupled (like state.js and its test).
- **Always run tests before moving on.** Even a quick `node module.js` smoke test catches import errors early.
- **When the agent gets something wrong**, paste the error back and say "here's the error, fix it" — don't re-explain the whole module.
- **Commit after each chunk** passes review. Small commits make it easy to roll back if a later chunk breaks something.
