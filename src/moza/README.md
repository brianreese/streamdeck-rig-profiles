# MOZA mBooster support

The pedal is controlled directly over its USB CDC serial port. Pit House is
not involved at runtime.

| File | Role |
|---|---|
| `frame.js` | Wire format: framing, checksum, value scaling |
| `mbooster.js` | Serial session, confirmed parameters, Pit House control |
| `presetStore.js` | Reads Pit House's preset library (reference only) |

## Confirmed parameters

Read, written, read back and restored on real hardware:

| Parameter | Command | Width | Scaling |
|---|---|---|---|
| Full-brake force | `0xB3` | 4 | `kg × 65536 / 200` |
| Travel start | `0x84` | 2 | `mm × 65536 / 53.5` |
| Travel end | `0x85` | 2 | `mm × 65536 / 53.5` |

Friction (`0xAE`) and end-stop stiffness (`0xB2`) answer with a selector byte
but their units do not match what Pit House stores, so they are not exposed.

The ~23 vibration effects are synthesised host-side and streamed as amplitude
values; they are not one-shot settings and are out of scope.

## Two protocol details found by testing

- A read must reserve space for the answer. Sending only the command id gets a
  valid reply with no value bytes.
- Writes are acknowledged with the value echoed back (group `0xA4`), so a write
  can be confirmed by the ack and again by a re-read.

## Pit House

The serial port is exclusive, so Pit House must be closed. The provider can
close it, but only when the user opts in — killing an application because a
button was pressed is not a reasonable default.

Protocol facts come from Boxflat and AZOM documentation. No code is taken from
either; AZOM is GPL-3.0 and this project is not.

## What this does not control

The pedal's physical stiffness is a force-vs-travel curve — `forces_curve`
(7 points) paired with `stroke_curve` (6 points). `forcelimit_max` is only that
curve's last point, which is why writing it alone leaves the pedal feeling the
same through most of its travel:

```
Carter Brake : forcelimit_max 24  ->  forces_curve [8.6, 13.7, 16.8, 19.3, 20.9, 22.6, 24]
Brian Hybrid : forcelimit_max 50  ->  forces_curve [22.4, 31.6, 37.1, 41.5, 44.4, 47.4, 50.0]
```

AZOM lists that curve as unmapped: the shape candidate (`0xAB`) is derived from
other settings rather than being a setting itself, so it stays open until
someone captures Pit House writing one.

What `0xB3` genuinely does is set the load at which output reaches 100%. Lower
it and full braking arrives with less pressure — the resistance is unchanged.
For a child that is arguably the more useful control, but it is not a softer
pedal and should not be described as one.
