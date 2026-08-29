# MOZA mBooster support

The pedal is controlled directly over its USB CDC serial port. Pit House is
not involved at runtime.

| File | Role |
|---|---|
| `frame.js` | Wire format: framing, escaping, checksum, value scaling |
| `mbooster.js` | Serial session, confirmed parameters, Pit House control |
| `presetStore.js` | Reads Pit House's preset library (both container formats) |

## Confirmed parameters

Read, written, read back and restored on real hardware:

| Parameter | Command | Width | Scaling |
|---|---|---|---|
| Brake force curve | `0xAB` | 2, indexed | `kg × 65536 / 200` |
| Output saturation | `0xB3` | 4 | `kg × 65536 / 200` |
| Travel start | `0x84` | 2 | `mm × 65536 / 53.5` |
| Travel end | `0x85` | 2 | `mm × 65536 / 53.5` |

Friction (`0xAE`), end-stop stiffness (`0xB2`) and segmented damping (`0xB7`)
write and read back correctly but produce no perceptible change in feel, so
they are not exposed.

## The brake force curve — `0xAB`

This is the control that actually makes the pedal lighter, and it is what Pit
House's right-hand Pedal Feel slider drives. It is addressed by a 16-bit point
index:

```
7e 05 24 12 ab 00 08 0dca 50
            │  └─┬─┘ └─┬─┘
            cmd  idx   value
```

| Index | Meaning |
|---|---|
| 0–6 | Travel axis, evenly spaced at `65536/7`. Fixed; never written. |
| 8–14 | The seven force points, in kg. Point 7 is `forcelimit_max`. |
| 7, 15+ | Genuinely zero — confirmed by reading four value bytes, not two. |

Moving the slider rewrites all seven points at once, keeping the curve's shape
and scaling its height. Scaling them together is what makes the pedal lighter
through the whole travel rather than merely saturating earlier.

Scaling linearly reproduces MOZA's own presets closely. Against the factory
24kg "Carter Brake" curve, the largest error is under half a kilogram:

```
MOZA   8.603  13.735  16.800  19.274  20.898  22.560  24.0
ours   8.62   13.27   16.47   18.91   20.90   22.57   24.00
```

### Do not go below 24kg

Pit House's slider stops at 24kg. The firmware does not, and a lower peak
writes and reads back perfectly — while feeling stepped, like detents through
the travel. The motor cannot hold a force that small smoothly, so its cogging
stops being a rounding error. At 12kg it is unmistakable. `MIN_KG` in
`scripts/moza-force.mjs` exists for this reason.

## Three protocol details found by testing

- **A read must reserve space for the answer.** Sending only the command id
  gets a valid reply with no value bytes. For `0xAB` the request also has to
  carry the point index, which is why a bare sweep of the command space never
  found the curve: `0xAB` with no index answers with zeros.
- **0x7E is escaped by doubling it**, everywhere after the leading start byte
  and including the checksum, and the checksum is computed over the escaped
  bytes. Both directions do this. Missing it is not subtle: 6.63kg encodes to
  `08 7E`, so that write is silently ignored and the reply after it is
  swallowed whole.
- **Writes must be verified by reading back.** Some points quietly fail to
  take. On a force curve that is not cosmetic — a partial write leaves a
  non-monotonic curve, a pedal that gets *lighter* part way down.

Values read back up to one raw unit low (0.003kg on the force scale). The
firmware stores them as floats: a write of 2175 logged
`Table 2, Param 42 Written: 1079273428`, which is `3.318830` — the value as a
percentage of full scale. The read path truncates on the way back.

## Preset files

Pit House 1.4 repackaged every preset as `<uuid>.mzpreset` — a ZIP holding a
single `preset.json`. The directory and the uuid filenames are unchanged, and
so is the JSON inside, so only the wrapper needed handling.

Both forms are read: the upgrade leaves the pre-upgrade files in a `Backup`
folder, and another machine may not have upgraded yet. Where both exist for one
id the archive wins and the preset is listed once rather than twice under the
same name.

The archive is parsed directly. One small entry means a local file header, a
length and an inflate — less code than justifying a dependency for it.

## Pit House

The serial port is exclusive, so Pit House must be closed. The provider can
close it, but only when the user opts in — killing an application because a
button was pressed is not a reasonable default.

Turning off "Auto Load Preset" stops Pit House overwriting the live values with
a stored preset when it starts, which makes it usable for inspecting changes
made here.

Protocol facts come from Boxflat and AZOM documentation, plus a USBPcap capture
of Pit House moving the slider. No code is taken from either project; AZOM is
GPL-3.0 and this project is not.

## Talking to the right device

Nothing hardcodes a COM port — they move between reboots and USB sockets. The
port is found by vendor and product id every time, and `346E:0008` is the
mBooster specifically: the wheelbase and flight stick enumerate under different
product ids and are never candidates.

That is not enough on its own, so there are two more layers:

- **Ambiguity is refused, not guessed.** Windows reports a port-derived instance
  id rather than a device serial here, so two mBoosters cannot be told apart.
  Rather than write a brake curve to whichever enumerated first, `findPort`
  throws and asks for an explicit port.
- **The device is asked to prove what it is** before anything is written.
  `identify()` reads the curve's travel axis at indices 1, 3 and 6 and checks
  each lands near `i × 65536/7`. Fixed values in narrow bands are not something
  another device answers by chance, and unlike a serial number this verifies the
  *table layout being written into*. `withDevice` runs it by default; pass
  `{ verify: false }` only for command sweeps.

Confirmed against real hardware: pointing `withDevice` at COM12, another MOZA
device on the same machine, fails with `did not answer as an mBooster (no
answer for curve axis point 1). Nothing was written.`

The axis is not exactly even — the firmware stores floats and reads back
truncated, so observed steps run 9361-9364 against a nominal 9362. Hence the
tolerance rather than an exact match.

## Pit House's settings, mapped

From the preset JSON compared against Pit House's own UI:

| Pit House control | Preset field | Command |
|---|---|---|
| Pedal Feel curve, 7 force points | `brake_forces_curve` | `0xAB` idx 8-14 |
| Pedal Feel curve, 6 travel points | `brake_stroke_curve` | not found |
| Right slider (peak force) | `brake_forcelimit_max` | last curve point |
| Left slider (force before travel) | `brake_forcelimit_min` | not found |
| Pedal Travel, Starting / End | `brake_machinelimit_min` / `_max` | `0x84` / `0x85` |
| Maximum threshold for pressure sensors | `force_max_coef` | `0xB3` |
| Sensor Output Ratio, Angle vs Load cell | `brake_press_combine` | not found |
| Natural Damping, pressed / released | `brake_damping_press` / `_release` | `0xB7` |
| Mechanical Friction strength | `brake_friction_press` | `0xAE` |
| End stop feeling, front / end limit | `brake_softlimit_hardness_*` | `0xB2` |
| Simulator input mapping curve | `brake_nonlinear1..5` | not found |

Preset files are **not** live state. "Test Preset Unlinked" still reads
`brake_forcelimit_max = 79` while the pedal sits at 50, because the slider was
moved without saving. Applying a preset by name is well defined; reporting which
preset is currently active is not, and should not be claimed.

## What `0xB3` is, and when it matters

`0xB3` is Pit House's "Maximum threshold for pressure sensors" — the load at
which the load cell saturates and output reads 100%. It is not resistance: it
read 50.00 across three slider positions while the pedal's feel changed
completely.

Whether it does anything at all depends on `brake_press_combine`, the Sensor
Output Ratio, which blends pedal angle against load cell:

```
Carter Brake        press_combine 0   ->  angle 100%, load cell 0%
F1 25-Brake-Brian   press_combine 50  ->  an even blend
```

At 0 the output comes from travel and the load cell contributes nothing, so
`force_max_coef` is inert — which is why Carter's inherited value of 200kg is
harmless rather than broken. Do not reach for `0xB3` to make a pedal usable by a
child without checking `press_combine` first.

What makes Carter's preset work for a child is three things together: a low
force curve (24kg), a short travel range (4.3mm against 16mm), and angle-based
output.
