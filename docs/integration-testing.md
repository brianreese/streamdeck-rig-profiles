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

All automated tests are platform-independent — run on Mac or Windows with no Stream Deck hardware required.

| Test file | What it covers |
|---|---|
| `src/configLoader.test.js` | YAML loading, required-field validation, default hydration, `content_filter_tags` coercion, settings loading, defensive copies, `getProfileById`, `onUpdate` API, `close()` safety |
| `src/setup.test.js` | First-run template copy, existing file preservation, missing template handling, shared state dir creation, `SHARED_STATE_DIR` value |
| `src/state.integration.test.js` | Round-trip write/read, `lastSwitched` validity, both files match, successive writes, graceful fallback (missing / malformed / empty / wrong shape), no leftover `.tmp` files — run with `node src/state.integration.test.js` |

### Adding tests for new modules

Each new source file in `src/` should have a co-located `.test.js` file in the same directory. Follow the same pattern:

- Use real temp directories (avoid filesystem mocking where possible — it makes tests harder to read)
- Clean up in `afterEach` with `rmSync(tmpDir, { recursive: true, force: true })`
- Call `close()` on any module that starts a watcher

---

## 1.5 — Platform split and Windows checkpoint schedule

You're developing on a Mac; the Stream Deck, Fanatec, and Moza hardware, plus Govee lights, are on a separate Windows sim rig.

### What can be validated on Mac

| Activity | Command | Notes |
|---|---|---|
| All Vitest unit tests | `npm test` | Pure logic + file I/O, no hardware |
| `state.js` integration test | `node src/state.integration.test.js` | File I/O only |
| Govee API discovery + scene activation | `node scripts/test-govee.js --key ... --scene ...` | Cloud API — rig lights will actually respond |
| Fanatec hotkey parsing + local keyfire | `node scripts/test-fanatec.js --hotkey cmd+shift+3` | Fires hotkeys on the Mac desktop; verifies logic. **Requires macOS Accessibility permission** (see §1.7). FanaLab response requires Windows. |
| `buttonRenderer.js` visual output | `node -e "const r = ..."` | Generates a PNG locally — open to verify layout |

> **Govee from Mac:** `scripts/test-govee.js` with a valid API key will trigger real scene changes on the rig lights from anywhere. You do not need to be at the Windows machine to validate Govee integration.
---

## 1.6 — Govee integration script (`scripts/test-govee.js`)

The Govee API is cloud-based, so this script works from any machine with internet access. Use it to discover devices, inspect available scene names, test scene activation, and manage the disk cache — all without touching the sim rig.

### Setup

Set your API key once (do not commit it):
```bash
export GOVEE_KEY="your-key-here"   # optional convenience — the script always needs --key
```

### Flags reference

| Flag | Argument | Description |
|---|---|---|
| `--key` | `<KEY>` | Govee Developer API key (required every time) |
| `--list-devices` | — | Print discovered device names — copy-paste output into `govee_devices` in profiles.yaml |
| `--list-scenes` | — | Print every scene name available per device (both factory and DIY) |
| `--scene` | `<NAME>` | Activate the named scene after discovery |
| `--devices` | `<N1,N2>` | Comma-separated device names to target (tests the `govee_devices` allowlist logic) |
| `--refresh` | — | Bypass the disk cache and re-fetch from the Govee API |
| `--clear-cache` | — | Delete the on-disk cache (`PLUGIN_DATA_DIR/govee-cache.json`) and exit |

### Typical workflow when setting up Govee

```bash
# Step 1: discover your devices and get exact names for govee_devices in profiles.yaml
node scripts/test-govee.js --key YOUR_KEY --list-devices

# Step 2: see what scene names are available (both DIY and factory)
node scripts/test-govee.js --key YOUR_KEY --list-scenes

# Step 3: fire a scene on all devices
node scripts/test-govee.js --key YOUR_KEY --scene "Racing"

# Step 4: fire a scene on specific devices only (verify allowlist logic)
node scripts/test-govee.js --key YOUR_KEY --scene "Racing" --devices "Rig Strip Light,Monitor Lightbar"

# Step 5: force a refresh if you've added/renamed devices in the Govee app
node scripts/test-govee.js --key YOUR_KEY --list-devices --refresh
```

### Caching behaviour

Discovery is cached to `PLUGIN_DATA_DIR/govee-cache.json` after the first successful `init()`. Subsequent runs load from cache instantly. The cache is tied to the last 4 digits of the API key — changing the key automatically triggers a fresh network fetch.

- **macOS:** `~/Library/Application Support/com.rig.profiles/govee-cache.json`
- **Windows:** `%APPDATA%\com.rig.profiles\govee-cache.json`

> **Note:** The cache contains device IDs and scene mappings — not credentials. It is not committed to the repo. To clear it, run `node scripts/test-govee.js --key ... --clear-cache` or delete the file directly.

### What to look for

| Check | Expected output |
|---|---|
| `--list-devices` shows your rig devices | Names exactly as they appear in the Govee app |
| `--list-scenes` shows your DIY scene names | Scene names you created in the Govee app |
| `--scene` with a valid name | `activateScene() returned — check your lights!` and lights change |
| `--scene` with an invalid name | Warning per device: `Scene "X" not found on … — skipping.` |
| `--devices` with a name not in cache | Warning: `Device "X" not found in cache — check the name matches the Govee app.` |
| Second run (no `--refresh`) | `Loaded N device(s) from cache` — no network calls |

---

## 1.7 — Fanatec integration script (`scripts/test-fanatec.js`)

This script tests the full robotjs hotkey path on your local machine without needing FanaLab or a sim rig. The hotkey combo is fired exactly as the plugin will fire it — the only difference on Windows is that FanaLab receives it instead of whatever app is in focus.

### macOS Accessibility permission (required)

robotjs synthesises system-level input events. macOS blocks this by default. Before the script can fire any key combo, you must grant Accessibility access to the app running Node:

1. **System Settings → Privacy & Security → Accessibility**
2. Add your terminal app (e.g. iTerm2, Terminal.app) to the list and enable it
3. Re-run the script — no reboot needed

> **Windows:** No equivalent permission required. robotjs works out of the box once `npm rebuild robotjs` has been run.

### Usage

```bash
# Verify with a safe, obvious Mac shortcut first:
node scripts/test-fanatec.js --hotkey cmd+shift+3   # full-screen screenshot → Desktop
node scripts/test-fanatec.js --hotkey cmd+shift+4   # region screenshot (crosshair cursor)

# Verify modifier normalisation (these should all parse correctly):
node scripts/test-fanatec.js --hotkey ctrl+alt+f1   # Windows-style
node scripts/test-fanatec.js --hotkey ctrl+alt+f2
```

### What to look for

| Check | Expected output |
|---|---|
| Parsed key + mods printed | `Parsed: key="3"  mods=[command, shift]` — confirm normalisation is correct |
| `cmd+shift+3` fires | Screenshot file appears on Desktop |
| Wrong/missing modifiers | Check `MOD_ALIASES` in `src/fanatec.js` if a modifier isn't normalised as expected |
| `robotjs error` line | Likely an Accessibility permission issue — see above |
### Windows checkpoint schedule

| Checkpoint | After | What to test | Est. time |
|---|---|---|---|
| **W-1** | Chunk 3 | `scripts/test-fanatec.js` → FanaLab preset changes; plugin loads cleanly in SD software | ~30 min |
| **W-2** | Chunk 5 | Full integration tests **T-01 through T-10** | ~1–2 hrs |
| **W-3** | Chunk 7 | **T-11, T-12**; `.gitignore` clean; manifest review; `npm run link` | ~30 min |

Each checkpoint is marked in `human-implementation-guide.md` at the relevant chunk.

---

## 2. Manual Integration Tests

These tests require the Stream Deck software, the physical hardware, and the plugin installed via `npm run link`. **All T-0x tests run on the Windows sim rig.** Work through the checklist below in order — use the checkpoint schedule above to know when to run each group.

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

> **Pre-validate on Mac:** Run `node scripts/test-govee.js --key YOUR_KEY --scene "Racing"` before this Windows test. If discovery and scene activation succeed there, the API key and scene names are confirmed correct — this test then only verifies the plugin wiring.

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

| Area | When to add | Platform |
|---|---|---|
| Moza serial protocol activation | When `moza.js` is fully implemented | Windows |
| SD profile switch via `switchToProfile` event | When action handler is wired up in `plugin.js` (Chunk 5) | Windows |
| Button canvas rendering visual check | When `buttonRenderer.js` is implemented (Chunk 4) | Mac |
| Picker position mapping to profiles | When `pickerMode.js` is implemented (Chunk 5) | Windows |
| Govee scene name mismatch handling | When `govee.js` is implemented (Chunk 3) | Mac (API) |
| AC mid-session handoff (T-04 while acs.exe running) | Phase 3 | Windows |
