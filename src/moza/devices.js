// moza/devices.js — which MOZA device is on which serial port, on any machine.
//
// COM numbers are not identity. They move when a device is replugged, when it
// goes into a different socket, and sometimes across a reboot. Nothing here or
// in any provider may hardcode one; every lookup enumerates by USB vendor and
// product id, which are assigned per product by the vendor and are therefore
// the same on every machine and every user's rig.
//
// The product id table below is the identity mechanism. It was wrong once, in a
// way worth recording: 0x1100 was assumed to be the AB9 and probed at length
// before Windows' own bus-reported name showed it was the throttle panel, and
// that the AB9 had been sitting on a port nothing had touched. USB says which
// product it is; assumptions about which socket things are in do not.
//
// Windows exposes the real product string through
// DEVPKEY_Device_BusReportedDeviceDesc, but `serialport` does not surface it —
// it reports the CDC driver's manufacturer ("Microsoft") and a port-derived
// instance id rather than a device serial. `describeAttached()` reads it via
// PowerShell as a cross-check when confirming a mapping; nothing at runtime
// depends on it, because it is Windows-only.

import { SerialPort } from 'serialport';
import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

export const VENDOR_ID = '346E';

/**
 * Known MOZA products, keyed by USB product id.
 *
 * `protocolDevice` is the device id used inside the wire protocol, which is a
 * different thing from the USB product id and is only known where it has been
 * confirmed against hardware.
 */
export const DEVICES = {
  '0008': {
    key: 'mbooster',
    model: 'mBooster Pedals',
    // Confirmed: reads and writes its force curve, verified against hardware.
    protocolDevice: 0x12,
    supported: true,
  },
  '1000': {
    key: 'ab9',
    model: 'MOZA AB9 FFB Base',
    // Not yet established. The keepalive probe that found 0x10 and 0x12 was
    // run against the throttle panel by mistake and says nothing about this.
    protocolDevice: null,
    supported: false,
  },
  '1100': {
    key: 'mtp',
    model: 'MOZA MTP Throttle Panel',
    // Answers keepalives addressed to 0x10 and 0x12 but returned no data for
    // any command 0x00-0xFF read at width 4.
    protocolDevice: null,
    supported: false,
  },
};

/** Look a product up by the short key a script or provider would use. */
export function deviceByKey(key) {
  const entry = Object.entries(DEVICES).find(([, d]) => d.key === key);
  return entry ? { productId: entry[0], ...entry[1] } : null;
}

/**
 * Every MOZA serial port attached right now, with the product identified.
 *
 * An unknown product id is reported rather than dropped: MOZA ships hardware
 * this table has never heard of, and a rig with one should say so instead of
 * appearing to have nothing plugged in.
 */
export async function listMozaDevices({ list = () => SerialPort.list() } = {}) {
  const ports = await list();
  return ports
    .filter((p) => (p.vendorId ?? '').toUpperCase() === VENDOR_ID)
    .map((p) => {
      const productId = (p.productId ?? '').toUpperCase();
      const known = DEVICES[productId];
      return {
        path: p.path,
        productId,
        key: known?.key ?? null,
        model: known?.model ?? `unknown MOZA device (PID ${productId})`,
        protocolDevice: known?.protocolDevice ?? null,
        supported: Boolean(known?.supported),
        known: Boolean(known),
      };
    });
}

/**
 * The port for one product, or null when it is not attached.
 *
 * Refuses to guess when two of the same product are present. Windows reports a
 * port-derived instance id rather than a device serial for these, so there is
 * genuinely nothing to tell two identical devices apart, and picking the first
 * would mean writing settings to whichever enumerated first.
 */
export async function findDevicePort(key, opts) {
  const matches = (await listMozaDevices(opts)).filter((d) => d.key === key);
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} ${key} devices found (${matches.map((m) => m.path).join(', ')}). ` +
        'Refusing to guess which one to write to — pass an explicit port.',
    );
  }
  return matches[0]?.path ?? null;
}

/**
 * What Windows says each attached MOZA device calls itself.
 *
 * A cross-check for the table above, not a runtime dependency: it shells out to
 * PowerShell and only works on Windows. Returns an empty map on any failure.
 */
export async function describeAttached({ exec = run } = {}) {
  const script =
    "Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'USB\\VID_346E*' -and " +
    "$_.InstanceId -notlike '*MI_*' } | ForEach-Object { " +
    "$d = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName " +
    "'DEVPKEY_Device_BusReportedDeviceDesc' -ErrorAction SilentlyContinue).Data; " +
    "if ($_.InstanceId -match 'PID_([0-9A-F]{4})' -and $d) { $matches[1] + '=' + $d } }";

  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', script]);
    const out = {};
    for (const line of stdout.split(/\r?\n/)) {
      const [pid, ...rest] = line.trim().split('=');
      if (pid && rest.length) out[pid.toUpperCase()] = rest.join('=').trim();
    }
    return out;
  } catch {
    return {};
  }
}
