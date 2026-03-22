// moza.js — Moza sim hardware profile activation.
//
// Current status: STUB — logs intent only, does not control hardware.
//
// Background
// ----------
// Moza does not expose a public API for profile switching.  Three viable
// implementation paths have been identified:
//
// Option A – Boxflat serial protocol (preferred long-term)
//   Boxflat (https://github.com/Lawstorant/boxflat) is an open-source Linux
//   app that communicates with Moza hardware over USB serial.  Its protocol
//   has been partially reverse-engineered.  A Node.js implementation using the
//   `serialport` npm package could replay the same commands that Boxflat sends
//   when the user changes a tuning profile.  Requires:
//     - Identifying the correct USB serial port (e.g. /dev/ttyUSB0 or COM port)
//     - Capturing and replaying Boxflat's "load profile X" serial frames
//   Status: protocol not yet fully documented; needs hardware capture session.
//
// Option B – AutoHotkey automation (Windows only, near-term workaround)
//   Moza Pit House (the official Windows tuning software) has a system tray
//   icon and keyboard shortcuts or UI that can be automated via AHK.
//   A small .ahk script could listen for a named pipe or socket message from
//   this plugin and activate the correct profile in Pit House.
//   Status: viable on Windows sim rig; not cross-platform.
//
// Option C – Profile file swap (filesystem hack, last resort)
//   Moza Pit House stores active tuning parameters in config files under
//   %APPDATA%\Moza\.  Swapping the active profile file before launching Pit
//   House (or while it is not running) may work in some scenarios.
//   Status: brittle; behaviour changes across Pit House versions; not recommended.
//
// Implementation plan: prototype Option A during a Windows rig session.  See
// W-2 checkpoint in human-implementation-guide.md.

/**
 * Activate a named Moza tuning profile.
 *
 * Currently a no-op stub.  The call succeeds silently so the rest of the
 * profile-switch flow is unaffected while this module is under development.
 *
 * @param {string} profileName  The Moza tuning profile name (from profiles.yaml).
 */
export async function activateProfile(profileName) {
  if (!profileName) return;

  // TODO: replace this console.log with a real implementation (see options above).
  console.log(`[moza] Would activate profile "${profileName}" — hardware control not yet implemented.`);
}
