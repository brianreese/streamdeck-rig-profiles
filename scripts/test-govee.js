#!/usr/bin/env node
// test-govee.js — manual smoke-test for src/govee.js
//
// Usage (from repo root):
//   node scripts/test-govee.js --key <YOUR_GOVEE_API_KEY> [options]
//
// Options:
//   --key          <KEY>    Govee Developer API key (required)
//   --scene        <NAME>   Activate this scene after discovery
//   --devices      <N,N,..> Comma-separated device names to target (optional; omit = all)
//   --list-scenes           Print every scene name found per device (good for debugging)
//   --list-devices          Print discovered device names (copy-paste for govee_devices config)
//   --refresh               Bypass the disk cache and re-fetch from the Govee API
//   --clear-cache           Delete CACHE_PATH (PLUGIN_DATA_DIR/govee-cache.json) and exit
//
// Examples:
//   node scripts/test-govee.js --key abcd-1234 --list-devices
//   node scripts/test-govee.js --key abcd-1234 --list-scenes
//   node scripts/test-govee.js --key abcd-1234 --scene "Racing"
//   node scripts/test-govee.js --key abcd-1234 --scene "Racing" --devices "Strip Light,Lightbar"
//   node scripts/test-govee.js --key abcd-1234 --scene "Racing" --refresh
//   node scripts/test-govee.js --key abcd-1234 --clear-cache
//
// This works from any machine with internet access — the Govee API is
// cloud-based.  You do not need to be at the sim rig to run this test.

import { init, activateScene, getDiscoveredDevices, clearCache, CACHE_PATH } from '../src/govee.js';

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function argValue(flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}
const hasFlag = f => argv.includes(f);

const apiKey       = argValue('--key');
const sceneName    = argValue('--scene');
const devicesArg   = argValue('--devices');  // comma-separated device names
const deviceNames  = devicesArg ? devicesArg.split(',').map(s => s.trim()).filter(Boolean) : null;
const listScenes   = hasFlag('--list-scenes');
const listDevices  = hasFlag('--list-devices');
const forceRefresh = hasFlag('--refresh');
const doClear      = hasFlag('--clear-cache');

if (!apiKey) {
  console.error('Error: --key <GOVEE_API_KEY> is required.');
  console.error('  Get your key from https://developer.govee.com/');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// --clear-cache shortcut (no discovery needed)
// ---------------------------------------------------------------------------

if (doClear) {
  clearCache();
  console.log(`[test-govee] Deleted ${CACHE_PATH}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

console.log(forceRefresh
  ? '[test-govee] Force-refreshing from network...'
  : '[test-govee] Starting discovery (use --refresh to bypass cache)...');

try {
  await init(apiKey, { forceRefresh });

  const devices = getDiscoveredDevices();

  if (devices.length === 0) {
    console.warn('[test-govee] No devices discovered. Check that your API key is correct.');
    process.exit(0);
  }

  console.log(`\n[test-govee] Discovered ${devices.length} device(s):`);
  for (const d of devices) {
    console.log(`  • ${d.name}  (id: ${d.id})`);
  }

  // --list-devices: print names in a format ready to paste into govee_devices config
  if (listDevices) {
    console.log('\n[test-govee] Device names for govee_devices in profiles.yaml:');
    console.log('  govee_devices:');
    for (const d of devices) console.log(`    - "${d.name}"`);
  }

  // --list-scenes: dump every scene name for each device
  if (listScenes) {
    // Access sceneMap by re-importing the raw cache (we only export device snapshots)
    // Easiest: re-read the cache file that was just written.
    const fs = await import('fs');
    if (fs.existsSync(CACHE_PATH)) {
      const cacheData = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      console.log('\n[test-govee] Scene catalog per device:');
      for (const dev of cacheData.devices) {
        const names = Object.keys(dev.sceneMap ?? {});
        console.log(`\n  ${dev.deviceName} (${names.length} scenes):`);
        for (const n of names.sort()) console.log(`    - ${n}`);
      }
    }
  }

  if (!sceneName) {
    console.log('\n[test-govee] No --scene provided — discovery only. Done.');
    process.exit(0);
  }

  if (deviceNames) {
    console.log(`[test-govee] Targeting devices: ${deviceNames.join(', ')}`);
  }
  console.log(`\n[test-govee] Activating scene "${sceneName}"...`);
  await activateScene(apiKey, sceneName, deviceNames);
  console.log('[test-govee] activateScene() returned — check your lights!');
} catch (err) {
  console.error(`[test-govee] Fatal error: ${err.message}`);
  process.exit(1);
}
