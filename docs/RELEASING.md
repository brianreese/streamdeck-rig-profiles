# Releasing

The deliverable is a single `com.rig.profiles.streamDeckPlugin` file. Double
clicking it installs the plugin, so a GitHub Release with that file attached is
a complete distribution channel — the Elgato Marketplace is a separate, reviewed
route and is not required.

## The build

Two details make this less obvious than it should be, both learned by hitting
them:

- **`streamdeck pack` requires the directory to be named `com.rig.profiles.sdPlugin`.**
  This repository is not, so packing happens from a staging copy. Packing the
  installed plugin directly does not work either: it is a symlink, and the CLI
  rejects it with "Path must be a directory".
- **Install production dependencies only.** A straight copy of `node_modules`
  carries vitest and its rolldown binary: 75.1 MiB and 6978 files, against
  21.7 MiB and 2544 files for a production install.

```bash
rm -rf dist && mkdir -p dist/com.rig.profiles.sdPlugin
cp -r manifest.json package.json package-lock.json plugin.js src ui assets \
      dist/com.rig.profiles.sdPlugin/
mkdir -p dist/com.rig.profiles.sdPlugin/config
cp config/profiles.yaml.template dist/com.rig.profiles.sdPlugin/config/
find dist/com.rig.profiles.sdPlugin -name "*.test.js" -delete

cd dist/com.rig.profiles.sdPlugin && npm ci --omit=dev --ignore-scripts && cd ..
npx @elgato/cli pack com.rig.profiles.sdPlugin --force
```

`config/profiles.yaml` is deliberately not copied. It is gitignored and holds
whoever built the release's own profiles; `setup.js` recreates it from the
template on first run.

## The native module

`serialport` has a native binding, which is the usual reason a plugin works on
the machine that built it and nowhere else. It is not a problem here, and it is
worth recording why so nobody re-litigates it:

- The bindings are **N-API**, so they are ABI-stable across Node versions. The
  ABI gap between the repo's Node (24, modules 137) and the one Stream Deck
  ships (20.20.0, modules 115) does not apply to them.
- `@serialport/bindings-cpp` ships prebuilds for `win32-x64`, `win32-ia32` and
  `win32-arm64`, and `npm ci --omit=dev` carries them into the package.

Verified rather than assumed: loading `serialport` under Stream Deck's own
`node.exe` enumerates ports and finds the mBooster, and every provider imports
cleanly from the packed tree under that same runtime.

The manifest declares Windows 10+ only, which is honest — the MOZA and Fanatec
paths are Windows-specific (PowerShell toasts, `%ProgramFiles%` lookups).

## Before tagging

- `npx vitest run` — the suite must be green.
- `npx streamdeck restart com.rig.profiles` and exercise a real profile switch.
  Reloading matters more than it sounds: the plugin runs from a symlink so file
  changes are live, but the running Node process is not, and testing against a
  stale process has wasted time here more than once.
- Bump `Version` in `manifest.json`. The CLI reports it as a four-part number
  (`1.0.0` becomes `1.0.0.0`).
- Check GitHub's Dependabot alerts. The default branch has had open advisories
  that are unrelated to this work but would ship with a release.
