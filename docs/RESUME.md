# Resume point — paused 2026-08-27

Branch `feat/provider-architecture`. Everything below is **uncommitted**.
Test suite is green: 285 tests across 16 files, and every modified module
imports cleanly.

## MOZA mBooster — done, and verified on real hardware

The brake force curve is solved. `0xAB`, addressed by a 16-bit point index,
values scaled `kg × 65536 / 200`. Protocol details are in
`src/moza/README.md`; the unmapped remainder is BACKLOG section 9.

Two protocol bugs were found and fixed along the way, both of which had been
corrupting reads across the whole plugin:

- **0x7E is escaped by doubling**, after the leading start byte and including
  the checksum, with the checksum computed over the escaped bytes. Both
  directions. A value like 6.63kg encodes to `08 7E`, so that write was ignored
  and the reply behind it was swallowed.
- **Writes were never verified.** Points quietly fail to take, which on a force
  curve leaves a pedal that gets *lighter* part way down. Every point now reads
  itself back and retries.

Confirmed by hand on the pedal:

| Peak | Result |
|---|---|
| 12kg | Stepped, detents through the travel — below what the motor can hold |
| 24kg | Smooth. Pit House's own slider floor, now enforced as `CURVE_MIN_PEAK_KG` |
| 43kg | Normal |
| 50kg | Normal |

Scaling a curve linearly reproduces MOZA's factory 24kg preset to within half a
kilogram, so the shape is not being invented.

### Not yet verified — needs the pedal

- **The identity guard's accepting path.** `identify()` is proven to *reject*
  (pointing `withDevice` at COM12, another MOZA device, fails with "did not
  answer as an mBooster"). It has never run against the mBooster itself,
  because Pit House held COM6 throughout. Margins are comfortable — the
  observed axis differs from nominal by 0-2 against a tolerance of 32.
- **The provider end to end.** `apply()` and `verify()` are covered by tests
  with a mocked pedal, never against the hardware.

Both are settled by one command, with Pit House closed:

```
node scripts/moza-profile.mjs apply "Carter Brake"
```

### Pedal's physical state right now

Peak 50kg, but carrying the *shape* from the 30kg slider drag on "Test Preset
Unlinked" — so it is lighter early in the travel than Brian Brake Hybrid (18kg
against 22kg at point 1). Opening Pit House restores normal, because it
auto-applies Brian Brake Hybrid on start via `[DefaultGamePreset_1]` regardless
of the "Auto Load Preset" checkbox.

`scripts/scans/force-curve.json` holds the 30kg curve as the baseline that
`moza-force.mjs restore` returns to. It is per-machine, not per-profile — the
provider does not use it, and it should not grow into a source of truth.

### A design finding worth keeping

"Point the kid profile at the grown-up preset and lower the force" works, but
does not reproduce Carter's own preset:

| | point 1 | peak | travel |
|---|---|---|---|
| Brian Hybrid scaled to 24kg | 10.76kg (44.8%) | 24.0 | 3.8-19.8mm |
| Carter Brake as authored | 8.60kg (35.8%) | 24.0 | 3.8-8.1mm |

Same peak, 25% heavier to initiate, and nearly four times the travel. For
Carter specifically, pointing his profile straight at `Carter Brake` with no
override is probably the better setup.

Also: `0xB3` (relabelled "Load cell threshold") is **inert** whenever
`brake_press_combine` is 0, because output then comes from pedal angle and the
load cell contributes nothing. That is why Carter's inherited 200kg threshold
is harmless rather than broken, and why `0xB3` is not the lever for making a
pedal usable by a child.

## Browser profile editor — INCOMPLETE, stopped mid-task

A background agent was building this and was stopped before finishing. Treat
everything here as unfinished until reviewed.

New: `src/editorServer.js`, `src/editorServer.test.js`, `ui/editor.html`.
Modified: `src/piBridge.js`, `src/actions/profileKey.js`, `ui/profile-key.html`.

Its 16 tests pass and every file imports, but **it has never been launched end
to end inside Stream Deck**, so passing tests here mean less than usual.

Its final report, unverified by me:

> Found a real bug while testing: two unsaved profiles both have an empty id,
> so identity by id picks the wrong one. Switching selection to the object
> itself.

Assume that change is half-applied. Before trusting the editor, re-check how
profile identity and selection work in `ui/editor.html` and `src/editorServer.js`.

The agreed design is BACKLOG section 1: bind 127.0.0.1 on an ephemeral port,
start on demand and stop when the page disconnects, reuse `piBridge.js`'s
vocabulary, and keep global settings as the source of truth via `saveProfiles`.

## Next, in order

1. Run the hardware test above — it closes out the two unverified MOZA items.
2. Finish the editor, starting with the profile-identity bug.
3. Find the four unmapped settings (BACKLOG section 9): `brake_stroke_curve`,
   `brake_forcelimit_min`, `brake_press_combine`, `brake_nonlinear1..5`. Each is
   one USB capture away now that `scripts/moza-decode-capture.mjs` works.
4. Still untouched from much earlier: the Playnite launcher plugin, and the
   Stream Deck profile-switch provider parked in BACKLOG section 5.
