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
- The Stream Deck profile-switch provider (`streamdeck`) is referenced by
  `profileSwitch.js` DEFERRED ordering but not yet implemented.
- Moza pedals: protocol unknown. `MOZA Pit House` writes a `COAP_Log.log`,
  suggesting CoAP to the device — a lead, not a plan.
