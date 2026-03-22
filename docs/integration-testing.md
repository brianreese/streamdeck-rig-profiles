# Integration Testing — streamdeck-rig-profiles

This document covers how to run automated unit tests and how to perform manual integration tests as the plugin matures. Update this doc whenever a new feature or hardware integration is added.

---

## 1. Automated Unit Tests

### Setup

```bash
cd streamdeck-rig-profiles
npm install
npm test
```

`npm test` runs `vitest run` — a single pass over all `src/**/*.test.js` files.

```bash
npm run test:watch    # re-runs on every file save (recommended during development)
```

### Current test coverage

| Test file | What it covers |
|---|---|
| `src/configLoader.test.js` | YAML loading, required-field validation, default hydration, `content_filter_tags` coercion, settings loading, defensive copies, `getProfileById`, `onUpdate` API, `close()` safety |
| `src/setup.test.js` | First-run template copy, existing file preservation, missing template handling, shared state dir creation, `SHARED_STATE_DIR` value |

### Adding tests for new modules

Each new source file in `src/` should have a co-located `.test.js` file in the same directory. Follow the same pattern:

- Use real temp directories (avoid filesystem mocking where possible — it makes tests harder to read)
- Clean up in `afterEach` with `rmSync(tmpDir, { recursive: true, force: true })`
- Call `close()` on any module that starts a watcher

---

## 2. Manual Integration Tests

These tests require the Stream Deck software, the physical hardware, and the plugin installed via `npm run link`. Work through the checklist below in order.

### Environment

- [ ] Stream Deck XL connected
- [ ] Stream Deck software running (version ≥ 6.4)
- [ ] `npm run link` completed without errors
- [ ] `config/profiles.yaml` customised with real FanaLab hotkeys, Govee scene names, and SD profile names

---

### T-01 — First run: template auto-copy

**Steps:**
1. Delete `config/profiles.yaml` if it exists
2. Start the plugin (or reload via Stream Deck software)

**Expected:**
- `config/profiles.yaml` is created, contents match `profiles.yaml.template`
- Plugin loads without error (check plugin logs)
- Toggle button appears on the Stream Deck (may show placeholder color/name until profiles.yaml is configured)

---

### T-02 — Plugin startup: correct profile restored

**Steps:**
1. Ensure a valid `config/profiles.yaml` and a `state.json` with a known `activeProfile` value exist
2. Start / reload the plugin

**Expected:**
- Toggle button immediately shows the correct profile's color and name (no flicker to a default state first)

---

### T-03 — Short press: profile cycle

**Steps:**
1. With two or more profiles configured, short-press the toggle button repeatedly

**Expected:**
- Each press cycles to the next profile in list order
- After the last profile, the next press returns to the first
- Button color and label update immediately on each press
- `state.json` is updated after each switch
- `active-profile.json` in the shared state directory is updated after each switch

---

### T-04 — Short press: hardware actions fire

**Steps:**
1. Switch profiles via short press

**Expected (per step in the macro chain — check each independently):**
- **Fanatec:** FanaLab changes to the configured preset (verify in FanaLab UI)
- **Moza:** Logged as "not yet implemented" (Phase 1 stub — no action expected)
- **Govee:** Lighting scene changes on all discovered devices (verify visually or in Govee app)
- **Stream Deck profile:** SD switches to the configured profile name

---

### T-05 — Long press: picker opens

**Steps:**
1. Press and hold the toggle button for ≥ 600 ms

**Expected:**
- The bottom row (positions 24–31) is replaced with one colored button per profile
- Buttons are labeled with the profile name
- Empty slots are blank

---

### T-06 — Picker: select a profile

**Steps:**
1. Open the picker (T-05)
2. Tap one of the profile buttons in the bottom row

**Expected:**
- The selected profile becomes active
- Macro chain fires (same as T-04)
- Bottom row is restored to its previous state
- Picker dismisses immediately after tap

---

### T-07 — Picker: auto-dismiss

**Steps:**
1. Open the picker (T-05)
2. Do not press anything for 5 seconds

**Expected:**
- Picker dismisses automatically
- Active profile does not change
- Bottom row is restored

---

### T-08 — Partial failure resilience

**Steps:**
1. Disconnect from the network (so Govee API calls fail)
2. Switch profiles via short press

**Expected:**
- Toggle button flashes red briefly on the Govee step failure
- Button resolves to the new profile's color/name regardless
- Fanatec and Stream Deck profile steps still complete
- Error logged for the Govee step (check plugin logs)

---

### T-09 — Config hot-reload

**Steps:**
1. Plugin running with two profiles
2. Open `config/profiles.yaml` and change the `color` of the active profile
3. Save the file

**Expected:**
- Plugin detects the change within ~1 second
- Toggle button updates to the new color without restarting the plugin

---

### T-10 — Govee auto-discovery

**Steps:**
1. Set `govee_api_key` in `config/profiles.yaml` to a valid key
2. Reload the plugin

**Expected:**
- Log shows: `[govee] Discovered N device(s).`
- On the next profile switch, Govee scenes change on all discovered devices

**If Govee is unconfigured (empty key):**
- Log shows Govee step skipped (no error)

---

### T-11 — Invalid profiles.yaml resilience

**Steps:**
1. Introduce a YAML syntax error into `config/profiles.yaml` (e.g. remove a colon)
2. Save the file

**Expected:**
- Plugin logs a parse error
- The previous valid configuration remains active (no crash)
- Button continues to show the last-known profile

---

### T-12 — Shared state written correctly

**Steps:**
1. Switch profiles

**Expected:**
- File exists at the platform-appropriate shared path:
  - macOS: `~/Library/Application Support/streamdeck-rig-shared/active-profile.json`
  - Windows: `%APPDATA%\streamdeck-rig-shared\active-profile.json`
- Content: `{"activeProfile":"<id>","lastSwitched":"<ISO timestamp>"}`

---

## 3. Future Test Areas (not yet implemented)

Add integration tests here as new features are implemented:

| Area | When to add |
|---|---|
| Moza serial protocol activation | When `moza.js` is fully implemented |
| SD profile switch via `switchToProfile` event | When action handler is wired up in `plugin.js` |
| Button canvas rendering | When `buttonRenderer.js` is implemented |
| Picker position mapping to profiles | When `pickerMode.js` is implemented |
| `state.js` read/write round-trip | When `state.js` is implemented |
| Govee scene name mismatch handling | When `govee.js` is implemented |
| AC mid-session handoff (T-04 while acs.exe running) | Phase 3 |
