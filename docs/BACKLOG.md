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
- A "pop out" editor. The inspector cannot resize itself, so this would mean a
  separate window, which the SDK does not directly support. Parked.

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
