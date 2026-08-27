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
| Max force | `0xB3` | 4 | `kg × 65536 / 200` |
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
