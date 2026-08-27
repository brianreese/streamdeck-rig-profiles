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
