# Backlog

Captured 2026-08-27, after phase 2 landed.

## 1. Property inspector feels cramped

The Stream Deck inspector panel is short by default, and the profile editor
lives inside it. Reaching the fields means scrolling a small window.

Ideas, roughly in order of effort:

- Accordion the profile cards so only the one being edited is expanded.
  *(Done in phase 3 — biggest win for the least work.)*
- Tighten vertical rhythm; the original spacing was generous for a full page,
  not a 300px-tall panel.
- Hide the key's profile picker while the editor is open, reclaiming its rows.
  *(Done in phase 3.1.)*
- **Configure in a browser window — the real fix, and the agreed direction.**
  The plugin is an ordinary Node process, so it can host a small page on
  localhost and open the user's browser at it. That gives a full-size editor
  with room for search, grouping, drag-to-reorder, live key previews, and
  per-provider UI as complex as the hardware needs — none of which fits a
  ~300px panel. The property inspector keeps only the one thing it is good at:
  picking which profile a key activates.

  Notes for when this is built:
  - Bind to 127.0.0.1 on an ephemeral port; never 0.0.0.0.
  - Start the server on demand (a button in the inspector), not at boot, and
    stop it when the page disconnects.
  - Reuse `piBridge.js` wholesale — the request/reply handlers are transport
    agnostic already, so the browser page can speak the same vocabulary over
    HTTP or a websocket instead of `sendToPlugin`.
  - Global settings remain the source of truth; the page reads and writes them
    through the same `saveProfiles` path, validation included.

## 1a. Multi Action composition — investigated, not viable

Dragging Stream Deck actions into a profile was explored and rejected on
evidence, recorded here so it is not revisited:

- Plugins get exactly one UI surface (`PropertyInspectorPath`). There is no API
  to render into the key grid, so the Multi Action canvas cannot be imitated.
- `MultiActionPayload` has no `coordinates` — an action inside a Multi Action
  has no key, so `setImage` has nothing to target. Every rendered state (the
  confirmation dot, the amber cannot-confirm stripe, the hold progress bar)
  is structurally unavailable there.
- The plugin command vocabulary has no abort/stop/cancel, and no channel for a
  nested action to report failure, so a Multi Action cannot stop early.

Standalone per-provider actions remain worth shipping *for direct placement on
a key*, where coordinates exist and all of the above works normally.

## 2. Providers must be selectable per profile — not assumed

**Status: addressed in phase 3.**

The phase 2 editor hardcoded a "Wheelbase" field on every profile, which bakes
in the assumption that every profile is about a Fanatec wheel. It is not: a
space-sim profile may have nothing to say about the wheelbase, and a profile
that only changes lighting should not imply otherwise.

Each profile now opts in to the providers it cares about, and providers
describe their own fields so the editor renders them generically. Adding
hardware means adding a provider file — the editor, the orchestrator, and the
config schema all pick it up without changes.

## 3. Run apps and scripts as part of a profile

**Status: first cut in phase 3 (`apps` provider).**

Modelled on Playnite's script hooks. "Switch to flight sim" should be able to
open MOZA Cockpit, start eye tracking, and so on — none of which involves the
wheelbase, which is exactly why item 2 had to come first.

Still to do:
- Per-command working directory.
- Commands that run on *leaving* a profile, not just entering it, so a profile
  can clean up after itself.
- A timeout per command, so a hung script cannot stall a profile switch.

## 4. Deferred from earlier phases

- `HOLD_MS` is fixed at 1000ms. Confirmed to feel right, so it stays hardcoded
  until someone wants otherwise.
- Diagnostic logging in `profileKey.js` is verbose (every willAppear, keyDown,
  keyUp, PI request). It earned its place — three bugs were only visible in the
  event trace — but should drop to debug level once this settles.
## 5. Stream Deck profile switching — parked, harder than it looks

`profileSwitch.js` reserves `streamdeck` in its DEFERRED ordering, but the
provider does not exist, and the original spec's `sd_profile: "Kid Desktop"`
cannot work as written. From the SDK:

> Plugins may only switch to profiles distributed with the plugin, as defined
> within the manifest, and cannot access user-defined profiles.

So a profile the user made in the Stream Deck app is unreachable. What is
actually possible:

- `switchToProfile(deviceId, undefined)` — return to the previously active
  profile. Works with no bundling at all.
- Switch to a profile **bundled in our own manifest**, which the user then
  customises in place.

The bundled route means shipping `.streamDeckProfile` files. Format, from
unpacking Corsair's (they are ZIPs):

```
package.json        {AppVersion, DeviceModel, FormatVersion, OSType,
                     RequiredPlugins:["com.rig.profiles"], ...}
Profiles/<GUID>.sdProfile/manifest.json      {Device:{Model,UUID}, Name,
                                              Pages:{Current,Default,Pages[]}}
Profiles/<GUID>.sdProfile/Profiles/<GUID>/manifest.json   (per page)
```

`DeviceModel` is device-specific (`20GAT9902` is the XL), so supporting more
than one deck size means one bundled file per model. Doable, fiddly, and it
puts generically-named profiles in the user's app that they must then populate.

Parked deliberately: the value (kids see a restricted deck) is real, but the
cost is out of proportion to everything else outstanding. Revisit after the
browser editor.
- Moza pedals: protocol unknown. `MOZA Pit House` writes a `COAP_Log.log`,
  suggesting CoAP to the device — a lead, not a plan.

## 6. MOZA provider — research findings (2026-08-27)

Investigated a preset-based provider for the MBooster active pedal. Not built;
these are the findings so the next attempt starts informed.

### Hardware present

`MOZA AB9 FFB Base`, `Booster Pedals`, `MOZA MTP Throttle Panel` — all
VID_346E. Each composite device exposes a **USB CDC serial port** (MI_00, seen
as COM5/6/12) alongside its HID interface (MI_02).

### How MOZA presets actually work — and why this is harder than Fanatec

MOZA calls them *presets*, and they are plain JSON on disk:

```
Documents\MOZA Cockpit\PresetLibrary\
  PresetIndex.index    catalog: uuid, name, device_type, devices, product_type
  {uuid}.preset        { device_params: {...}, telemetry_params: {...} }
  lastLoadPresets.json device serial -> device type
```

**The critical difference from the Fanatec wheelbase:** Fanatec stores its five
setups *on the base*, so switching is one atomic index change that the hardware
confirms back. MOZA stores presets *on the PC* as a flat bag of parameters, and
applying one means pushing every parameter to the device. There is no on-device
slot to select, so "switch to preset X" is not a single command — it is a
replay of a config file.

That has consequences for the provider contract: `verify()` cannot simply read
back an index. It would have to read back parameters and compare, or settle for
`applied-unverified`.

Note: only one preset currently exists here ("Handbrake", for the AB9). **No
MBooster presets are saved yet** — they must be created in the app first,
exactly as the Fanatec setup slots had to be dialled in.

### Control channels found

| Channel | Detail | Assessment |
|---|---|---|
| **CoAP** | Pit House hosts a CoAP server on UDP `0.0.0.0:40266` (`COAP_Log.log`, "CoAP server start...version[1.0.3]") | Most promising — same shape as the Fanatec broker win |
| **ZeroMQ** | `tcp://localhost:5554`, MOZA Cockpit | Only alive while Cockpit runs; unexplored |
| **Serial** | COM5/6/12, per device | Robust, app-independent; the Boxflat route |
| `DeviceSdk.dll` | Misleading name — header is `!<arch>`, a 174MB **static library**, not a loadable DLL | No FFI path |

`MOZADriverInterface.h` ships with Pit House but covers key remapping and the
VMOZA virtual device only — nothing about presets.

### CoAP probing so far

`tools/moza-coap-probe.mjs` (in the fanatec-tuning-cli repo) speaks enough CoAP
to explore. Discovery works:

```
GET /.well-known/core -> 2.05
  </MOZARacing/ProductDevice>;obs
  </MOZARacing/ProductDevice/7401671685c890ef>
  </MOZARacing/ProductDevice/0f7d598567382e66>
```

But `GET` on the device resources returns only an empty `0.00` ACK and no
separate response, with or without a token. Likely an app-level pairing or auth
step (Pit House keeps an empty `token` file), or a required content-format.

### CORRECTION: the real preset store is Pit House, not Cockpit

The first pass looked in `DocumentsMOZA CockpitPresetLibrary` and found one
unrelated preset. The actual store for Pit House is:

```
DocumentsMOZA Pit HousePresets\n  config.ini        [LastUsedPreset] <deviceId>=<presetUuid>   <-- current selection
                    [IsAutoLoadPreset] MBoost=true
  favorites.json
  Pedals{uuid}.json   33 presets, incl. the user's own
  Motor{uuid}.json    222
  Steering Wheel{uuid}.json  21
DocumentsMOZA Pit HouseLocalParametersMBoost<serial>.json  <-- live params
```

Preset shape: `{ id, name, deviceType, devices, deviceParams, games, carModels,
tags, isOfficial, lastModified, version }`.

Real presets already defined here include **"Carter Brake"**, **"Brian Brake
 Hybrid"** (currently loaded) and **"F1 25-Brake-Brian"** — so the per-person
pedal profiles the kids need already exist.

Device ids line up across sources: `0f7d598567382e66` in config.ini is the
MBoost, and is also one of the CoAP resources. MBoost USB serial is
`3f003d001951343132393730` (VID_346E PID_0008).

### Prior art: there is already a MOZA Stream Deck plugin

`d-b-c-e/moza-streamdeck-plugin` (GitHub, .NET) does exactly this for **motor**
presets. Its method, per its own docs:

- Reads presets from `%USERPROFILE%DocumentsMOZA Pit HousePresetsMotor*.json`
  (handling OneDrive redirection).
- Applies each supported `deviceParams` entry through the **MOZA SDK**, with
  50ms between calls, steering angle applied last.
- Bundles `MOZA_API_C.dll`, `MOZA_API_CSharp.dll`, `MOZA_SDK.dll`.

So the approach is proven; it simply has not been done for pedals.

### MOZA publishes an official SDK — and it covers mBooster

https://mozaracing.com/pages/sdk — native C++ and C# libraries, "Full Device
Parameter Control" across motor, steering wheel, **pedals**, handbrake and
shifter, with pedal support listed explicitly for **CRP2, SR-P and mBooster**.
Also offers Pit House connectivity and device discovery.

Not currently installed on this machine; it must be downloaded.

### Recommended approach

1. Download the official MOZA SDK; use `MOZA_API_C.dll` (a C API, so callable
   from Node via koffi, which ships prebuilt binaries — no compiler needed).
2. Enumerate presets by reading `PresetsPedals*.json` for `id` and `name`;
   the property inspector offers those names, exactly as the Fanatec provider
   offers slots.
3. Apply by replaying `deviceParams` through the SDK, pacing the calls.
4. Verify by re-reading `[LastUsedPreset]` from config.ini if Pit House updates
   it — `moza-watch.mjs` exists to confirm whether it does.

Verification is explicitly lower stakes here: a stiff pedal is not the hazard a
high-torque wheel is, so `applied-unverified` is an acceptable outcome for this
provider if no clean read-back exists.

### Where to go next

1. Create the MBooster presets in the app — needed whichever route wins.
2. Learn the protocol by observation, as with Fanatec. Loopback UDP capture on
   Windows needs Npcap with loopback support; serial needs a port monitor.
   Apply a preset by hand while capturing.
3. Read Boxflat (open-source, Linux) for the serial protocol — it has already
   reverse-engineered much of MOZA's device layer and is the best reference if
   the CoAP route stays shut.

Realistically this is a larger job than the Fanatec provider was, and the
"apply a named preset" semantic does not exist at device level — expect to be
applying parameter sets, with weaker verification.

## 7. MOZA workaround — game-binding stand-in process (SHIPPED, VERIFIED)

Two experiments, 2026-08-27.

### Option 3 (write config.ini) — dead

`moza-option3-test.mjs` wrote a different preset uuid into
`Presets\config.ini` `[LastUsedPreset]` and waited. Result: **STUCK, NO APPLY**
— the write survived (Pit House did not rewrite it) but no pedal parameter
changed. The file is a record of what was applied, read at startup or device
connect, not an input. Original file restored; a `.claude-backup` copy remains.

### Game binding via a stand-in process — CONFIRMED WORKING

Pit House matches running games by executable **name** only —
`GameConfigInfo.xml` lists 60 games and every `<path>` is empty — and it runs
`bin\ProcessMonitor.exe` to watch for them. A preset can be bound to a game.

`moza-gamebind-test.mjs` copied Windows' own `waitfor.exe` to a temp folder as
`AssettoCorsa.exe` and ran it. Within seconds Pit House applied an
Assetto-Corsa-bound preset:

```
preset before : Brian Brake Hybrid
started AssettoCorsa.exe (pid 36488)
preset changed -> GTR1994-Default
```

Two important properties:

- **Name matching is sufficient.** No real game, no install, no path check.
- **The change is sticky.** The preset did not revert when the process exited,
  so a momentary process is enough — nothing needs to stay running.

### The design this enables

No device protocol work, using only Pit House's own supported feature:

1. In Pit House, bind each person's pedal preset to a *game they will never
   play* — e.g. Carter Brake -> "Tokyo Xtreme Racer", Brian Brake Hybrid ->
   "Formula Legends".
2. The `apps` provider launches a stand-in process named after that game's
   executable (a copy of `waitfor.exe`, or any harmless binary renamed).
3. Pit House sees it and applies the bound preset.
4. `verify()` reads back `[LastUsedPreset]` — already implemented and working.

No MOZA file needs editing if the chosen games already have a `program` entry.
Three entries have none at all (American Truck Simulator, Euro Truck Simulator
2, Formula Legends) and so can never fire accidentally, but using them *would*
require adding a `<program>` to `GameConfigInfo.xml`.

### CORRECTION: the watch list is hardcoded, not extensible

Tested directly. GameConfigInfo.xml does NOT drive which processes Pit House
watches — it is display metadata only:

- Renaming Assetto Corsa's <program> to a name we controlled, restarting Pit
  House, and running a stand-in with that name produced **no reaction**.
- The file survived untouched, and an appended 61st <Game> entry was neither
  removed nor honoured.
- The real list is compiled into the binary: 94 .exe strings including
  AssettoCorsa.exe, acc.exe, F1_25.exe, TokyoXtremeRacer.exe, iRacingSim64DX11.exe.

So arbitrary processes cannot be added. A stand-in must be named after one of
the ~60 built-in game executables.

That is less limiting than it sounds: you are not giving up a game, you are
naming a throwaway process after a game you will never launch. With ~60 to
choose from and a handful of profiles needed, pick from the ones you do not own
— Farming Simulator, Dakar, Tokyo Xtreme Racer, American Truck Simulator. The
only real cost is that if you ever DO play that game, its bound preset applies.

### Caveats

- Only works for presets bound to a game, so each profile needs one sacrificed
  game slot. 60 games available, so there is plenty of room.
- If the sacrificed game is ever actually played, its preset applies. Choose
  accordingly.
- Whether Pit House rewrites `GameConfigInfo.xml` on update is untested; prefer
  games that already carry a `program` so the file is never touched.
- This does not replace the serial protocol work (section 6) — it is a
  workaround that happens to be reliable and cheap.


### End-to-end confirmation (2026-08-27)

With "Brian Brake Hybrid" set as the Game Default Preset for Assetto Corsa,
running the profile through the real orchestrator:

```
before  : Carter Brake
applying via the orchestrator (stand-in runs ~6s)...
status  : verified
summary : all hardware confirmed
after   : Brian Brake Hybrid
```

The full chain works and reports honestly: profile -> provider -> stand-in
process -> Pit House -> pedal -> read-back from config.ini.

The operative setup step is **Set as Game Default Preset**, not merely binding.
An earlier run with the preset bound but not defaulted applied GTR1994-Default
instead, and verify() caught it.

Each profile therefore needs its own trigger game, each with that profile's
preset set as the game default. Any game works — including ones with dozens of
other presets bound — because the default slot is single-occupancy.

## 8. Profiles were lost across a reboot

After a Windows restart the plugin came back with only "Brian" and "Kai" — the
two profiles in `config/profiles.yaml`. Everything created in the editor was
gone.

That points at Stream Deck's global settings not surviving the reboot, followed
by `migrateIfNeeded` doing exactly what it is told: seeing an empty profile list
and re-importing the YAML. The migration is not the bug, but it does disguise
one, because the result looks like a working plugin with the wrong data rather
than an obvious failure.

Worth fixing regardless of the root cause, because profiles are now the most
valuable state the plugin holds:

- Write a copy of the profile list to the plugin data dir on every save, and
  prefer it over `profiles.yaml` when global settings come back empty. The YAML
  is a seed for first run; a backup is a restore.
- Consider warning rather than silently importing when global settings are empty
  but a backup exists and disagrees with the YAML.
- Log loudly on any migration that overwrites a non-empty profile list.

## 9. MOZA mBooster — settings we can read but cannot yet write (2026-08-27)

The brake force curve is solved: command `0xAB`, addressed by a 16-bit point
index, values in kg scaled `× 65536 / 200`. See `src/moza/README.md` for the
protocol, the 0x7E escaping rule, and the device identity check.

Four settings are understood in Pit House's preset JSON but have no known
command, so a profile cannot yet apply a *whole* preset — only the force curve,
the load cell threshold and the travel range.

Each is one USB capture away. The procedure that found `0xAB`: capture the
mBooster with USBPcap (install it, pick the device from its tree, save to a
.pcap), change only that one control in Pit House, stop the capture, then run
`node scripts/moza-decode-capture.mjs <capture.pcap>`. It lists writes grouped
by command and ranked by distinct-value count, so the control being moved is
normally the top row.

| Preset field | Pit House control | Why it matters |
|---|---|---|
| `brake_stroke_curve` | Pedal Feel curve, 6 travel points | Pairs with the force curve; sets where each force point sits in the travel |
| `brake_forcelimit_min` | Left vertical slider on the curve | Force required before the pedal moves at all |
| `brake_press_combine` | Sensor Output Ratio, Angle vs Load cell | Decides whether output follows travel or force — see below |
| `brake_nonlinear1..5` | Simulator input mapping curve | Shapes the 0-100% output sent to the game |

`brake_press_combine` is the important one. At 0 the output is 100% pedal angle
and the load cell contributes nothing, which makes `force_max_coef` (`0xB3`)
inert. Carter Brake is configured that way, which is why its inherited 200kg
threshold is harmless rather than broken. Any advice about `0xB3` is wrong
without checking `press_combine` first.

What makes a preset usable by a child is three things together: a low force
curve (24kg), a short travel range (4.3mm against an adult's 16mm), and
angle-based output. Only the first and the travel range are writable today.

Code carrying this gap is commented and points back here.

### UPDATE 2026-08-30 — two of the four solved, without a capture

`scripts/moza-find-arrays.mjs` reads every command at index 0 and index 1, keeps
the ones that answer differently (an array must; a scalar does not), then deep
probes the survivors and matches them against the preset file, which says what
those arrays should hold for whatever preset is loaded. That removes the human
from the loop: no changing a slider in Pit House and diffing.

It rediscovered `0xAB` indices 8-14 as the force curve on its own, matching the
oracle to two decimals, which is the check that the method works.

**Only two indexed commands exist on the pedal: `0xAB` and `0xAD`.**

`0xAB` is now completely decoded:

```
idx 0     always zero, the curve's origin
idx 1-6   brake_stroke_curve, as a FRACTION of the travel range
          mm = machinelimit_min + f * (machinelimit_max - machinelimit_min)
idx 7     brake_forcelimit_min, kg
idx 8-14  brake_forces_curve, kg
idx 15+   zero
```

Verified against Brian Brake Hybrid to within **0.0005mm** on all six stroke
points. So one command carries the entire Pedal Feel curve — both axes and both
sliders.

Indices 1-6 were previously called a fixed evenly-spaced axis. They were even
observed changing when a preset loaded, 9362 to 9409, and that was dismissed as
float noise from the firmware's storage. It was the stroke curve. The evidence
had been collected and misread.

`0xAD` reads `[26214, 16384, 0, 0, ...]` — as percentages, 40 and 25, which line
up with `brake_damping_press_segment*` and `brake_damping_release_segment*`.
Not confirmed; nothing depends on it.

### Still unmapped, and probably not on the pedal at all

`brake_nonlinear1..5` and `brake_press_combine` matched no command. Given only
two indexed commands exist, and a previous full scalar sweep of 458 values found
neither, the likeliest explanation is that they are **not device settings**.

Both shape what the GAME sees rather than how the pedal feels:
`brake_nonlinear1..5` is the Simulator input mapping curve, and
`brake_press_combine` blends pedal angle against load cell in the reported axis.
Pit House ships a driver that presents a virtual device
(`bin/MOZADriverInterface.h`, `setVMOZAsOnOff`), which is where output shaping
would naturally live.

If that is right, neither is reachable over the serial protocol and no capture
will find them. Confirming it means capturing while changing one of those
sliders and observing that **nothing** is written to the pedal — a negative
result, but a cheap and conclusive one.

### What the Pit House binary did and did not give up

`MOZA Pit House.exe` is Qt/C++, 42MB. It contains a UI-path to preset-key table
(`/pedalPressureBondingPointCommand/point` maps to `brake_press_combine`) and a
Qt type registration table (`MBoostForceCurve`, `MBoostDampingSegment`). Both
are names; neither carries command bytes, which live in compiled code. Useful
for naming things, not for finding ids. The shipped `MOZADriverInterface.h` is
about key mapping and the virtual device, not the serial protocol.


### Also outstanding

- **The identity check's passing path is untested.** `identify()` in
  `src/moza/mbooster.js` is proven to *reject* — pointing `withDevice` at COM12,
  another MOZA device, fails with "did not answer as an mBooster". The accepting
  path has not run end to end because Pit House held COM6 throughout. Margins
  are comfortable (observed axis differs from nominal by 0-2 against a tolerance
  of 32) but it is unexercised.
- **Two mBoosters cannot be told apart.** Windows reports a port-derived
  instance id (`B&16963DC6&0&0000`), not a device serial, so `findPort` refuses
  rather than guessing. The composite parent does carry a real serial
  (`3F003D001951343112970` via `Get-PnpDevice`); walking up to it would allow
  pinning a specific pedal. Not needed with one device.
- **Pit House re-applies a preset on start**, even with "Auto Load Preset"
  unchecked, because `[DefaultGamePreset_1] mBooster=<uuid>` in
  `Presets/config.ini` is a separate mechanism. This makes Pit House unusable
  for verifying what the plugin wrote — verify by reading back from the device
  instead, which is stronger anyway: preset files are not live state
  ("Test Preset Unlinked" read `brake_forcelimit_max = 79` while the pedal sat
  at 50).

## 10. AB9 shifter / flight stick mode — not started (2026-08-30)

Brian wants a provider that switches the AB9 between flight stick and
shifter mode, and picks the shifter pattern (5+R, 6+R, sequential) when in
shifter mode. Pit House exposes these as discrete settings with no preset,
so the MOZA preset store is no help here.

What is known, from a read-only probe:

- The AB9 is `346E:1000`. **An earlier version of this note said `1100`, and
  that was wrong** — 1100 is the MTP Throttle Panel, and a whole probing
  session was spent on it. Windows' bus-reported device name settled it, and
  `src/moza/devices.js` now holds the table with a test pinning it.
- It answers the same wire protocol. Device ids `0x10` AND `0x12` both
  acknowledge a keepalive on it. Everything in this codebase addresses `0x12`,
  the mBooster, which is why a first sweep looked like a dead device — it was
  ignoring frames meant for somebody else.
- Neither id returns data for any command 0x00-0xFF read at width 4. The
  throttle panel behaves identically, so this is not specific to the AB9.
- It has no force curve table, which is why the mBooster identity guard
  correctly refuses COM12. A new provider needs its own fingerprint, and must
  not reuse `identify()` — that one is deliberately mBooster-specific.

The commands are unknown. Finding them is the same job that found `0xAB`:
capture the AB9 with USBPcap, change ONLY the mode setting in Pit House, stop
the capture, then run `node scripts/moza-decode-capture.mjs <file>`. It lists
writes grouped by command and ranked by distinct-value count, so the control
being moved is normally the top row.

Needs Brian present at the rig; not startable unattended.

### UPDATE 2026-08-30 — probed further, still blocked, and here is why

Two new tools, both read-only: `scripts/moza-find-device.mjs` (which device ids
answer on a port) and `scripts/moza-sweep-device.mjs` (read every command from a
chosen device id, with a `--diff` mode for before/after comparison).
`moza-scan.mjs` also gained `--device=ab9`.

What they established:

- **Two device ids answer a keepalive on COM12: `0x10` and `0x12`.** `0x10` had
  never been addressed before — everything in this codebase talks to `0x12`,
  the mBooster. That is why an earlier sweep of the AB9 returned a flat nothing
  and looked like a dead device: it was ignoring frames addressed to somebody
  else.
- **Neither id returns data for any command from 0x00 to 0xFF** read at width 4.
  So knowing the device id was necessary and is not sufficient.

### The oracle trick does not transfer

The pedal's remaining settings were solved without a capture because the preset
file said what the values should be, giving something to match reads against.
**The AB9 has no preset.** Every device with a preset was enumerated — CRP, CS,
ES, R3 through R25, SRP, mBooster and others — and the AB9 is not among them.
Nothing says what any AB9 value ought to be, so a sweep produces numbers with
no meaning attached even when it produces numbers.

### So a capture really is the next step

An earlier note here suggested a before/after read diff might replace the
capture and only cost one toggle of a slider. That was optimistic: a read diff
needs reads to work, and they do not. Capturing what Pit House **sends** does
not depend on being able to read anything back, which is exactly why it is the
right tool here and was the one that cracked `0xAB`.

Procedure unchanged: capture the AB9 with USBPcap, change ONLY the shifter or
flight-stick mode in Pit House, stop the capture, then run
`node scripts/moza-decode-capture.mjs <file>`. The decoder groups writes by
command and ranks them by distinct-value count.

One thing to watch that cost time on the pedal: the decoder must be pointed at
the AB9's USB device, and the frames will be addressed to `0x10` or `0x12`
rather than the pedal's `0x12` only. `src/moza/frame.js` decodes them either
way — it does not filter by device.

### What Pit House's binary contributed

Names, not numbers. `MOZA Pit House.exe` holds a UI-path to preset-key table and
a Qt type registration table, so command *names* like `ShifterCalibState` and
`/steeringProgramParameterCommand/stickMode` are visible. Command bytes live in
compiled C++ and did not come out. Useful for naming a provider's fields once
the ids are known; no help in finding them.

