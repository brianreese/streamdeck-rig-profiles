import { describe, it, expect } from 'vitest';
import { listMozaDevices, findDevicePort, deviceByKey, DEVICES } from './devices.js';

const port = (path, productId) => ({ path, vendorId: '346E', productId });
const withPorts = (...ports) => ({ list: async () => ports });

describe('the product id table', () => {
  it('gives every product a distinct key', () => {
    const keys = Object.values(DEVICES).map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('maps the AB9 to 1000 and the throttle panel to 1100', () => {
    // Pinned because they were confidently swapped, and a whole probing session
    // was spent on the throttle panel believing it was the AB9. Windows'
    // bus-reported names settled it: PID 1000 is the base.
    expect(deviceByKey('ab9').productId).toBe('1000');
    expect(deviceByKey('mtp').productId).toBe('1100');
    expect(deviceByKey('mbooster').productId).toBe('0008');
  });

  it('only claims support for hardware actually mapped', () => {
    expect(deviceByKey('mbooster').supported).toBe(true);
    expect(deviceByKey('ab9').supported).toBe(false);
  });
});

describe('discovery', () => {
  it('identifies devices by USB id, whatever COM port they landed on', async () => {
    // The same rig after a replug: every port number has moved.
    const before = await listMozaDevices(withPorts(port('COM6', '0008'), port('COM5', '1000')));
    const after = await listMozaDevices(withPorts(port('COM31', '0008'), port('COM12', '1000')));

    expect(before.map((d) => d.key)).toEqual(after.map((d) => d.key));
    expect(after.find((d) => d.key === 'mbooster').path).toBe('COM31');
  });

  it('ignores anything that is not MOZA', async () => {
    const found = await listMozaDevices(
      withPorts(port('COM6', '0008'), { path: 'COM3', vendorId: '0403', productId: '6001' }),
    );
    expect(found).toHaveLength(1);
  });

  it('reports an unknown MOZA product rather than dropping it', async () => {
    // Someone else's rig will have hardware this table has never seen, and it
    // should say so rather than look like nothing is plugged in.
    const found = await listMozaDevices(withPorts(port('COM9', 'ABCD')));
    expect(found[0].known).toBe(false);
    expect(found[0].model).toMatch(/unknown MOZA device \(PID ABCD\)/);
  });

  it('tolerates lowercase ids from the driver', async () => {
    const found = await listMozaDevices(withPorts({ path: 'COM6', vendorId: '346e', productId: '0008' }));
    expect(found[0].key).toBe('mbooster');
  });
});

describe('finding one product', () => {
  it('returns null when it is not attached', async () => {
    expect(await findDevicePort('ab9', withPorts(port('COM6', '0008')))).toBeNull();
  });

  it('picks the right port when several MOZA devices are present', async () => {
    const ports = withPorts(port('COM12', '1100'), port('COM6', '0008'), port('COM5', '1000'));
    expect(await findDevicePort('ab9', ports)).toBe('COM5');
    expect(await findDevicePort('mbooster', ports)).toBe('COM6');
    expect(await findDevicePort('mtp', ports)).toBe('COM12');
  });

  it('refuses to guess between two of the same product', async () => {
    // Windows reports a port-derived instance id rather than a device serial,
    // so there is nothing here to tell two identical devices apart.
    const ports = withPorts(port('COM6', '0008'), port('COM7', '0008'));
    await expect(findDevicePort('mbooster', ports)).rejects.toThrow(/Refusing to guess/);
  });
});
