// buttonRenderer.js — renders key images as SVG data URIs.
//
// Why SVG rather than node-canvas (which the original plan called for): the
// Stream Deck accepts `data:image/svg+xml;base64,...` from setImage directly,
// so there is no native module to compile. node-canvas has no prebuild for
// Node 24 and fails to load on this rig; this approach has no build step at
// all and stays legible as text.
//
// Legibility rule: state is carried by BRIGHTNESS, not by a subtle border.
// These keys have to be readable across a room by a child who cannot yet read
// the label, so "off" is genuinely dark and "on" is genuinely saturated.

import { STATUS } from './providers/index.js';
import { readableTextColor } from './contrast.js';

const SIZE = 144;

/** Accent stripe drawn along the bottom edge, by state. */
const STRIPE = {
  [STATUS.MISMATCH]: '#E8A317',
  [STATUS.APPLIED_UNVERIFIED]: '#E8A317',
  [STATUS.FAILED]: '#D64545',
  [STATUS.UNREACHABLE]: '#D64545',
};

const escapeXml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Fit a label to the key by stepping the font size down for long names. */
function labelSize(text) {
  const n = String(text ?? '').length;
  if (n <= 6) return 22;
  if (n <= 9) return 18;
  if (n <= 12) return 15;
  return 13;
}

function initial(name) {
  return String(name ?? '?')
    .trim()
    .charAt(0)
    .toUpperCase();
}

/**
 * The two dark grounds an inactive or activating key sits on.
 *
 * Colour is carried by the monogram rather than the tile. Tinting the whole
 * tile with the profile colour was tried and read as too much colour: it cost
 * the thing a dark ground buys, which is that the one lit key is the only lit
 * thing on the deck.
 */
const OFF_BG = '#131519';
const WAIT_BG = '#1B1F26';

/** Darken a #rrggbb toward black by `amount` (0..1). */
function dim(hex, amount) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return '#333333';
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.max(0, Math.round(v * (1 - amount))),
  );
  return `#${ch.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Lighten a #rrggbb toward white by `amount` (0..1). */
function lift(hex, amount) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return '#FFFFFF';
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.min(255, Math.round(v + (255 - v) * amount)),
  );
  return `#${ch.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Render one profile key.
 *
 * @param {object} opts
 * @param {object} opts.profile        { name, color, avatarDataUri }
 * @param {boolean} opts.active        is this the profile currently in effect
 * @param {string} [opts.status]       aggregate STATUS when active
 * @param {boolean} [opts.switching]   mid-transition
 * @param {boolean} [opts.unknown]     state could not be read at all
 * @param {number}  [opts.holdProgress] 0..1 while a restricted key is held
 * @param {number}  [opts.dotFrame]  0..2, which dot is lit while switching
 */
export function renderProfileKey({
  profile,
  active,
  status,
  switching = false,
  unknown = false,
  holdProgress = null,
  dotFrame = null,
}) {
  const name = escapeXml(profile?.name ?? '');
  const color = profile?.color ?? '#2255CC';
  const avatar = profile?.avatarDataUri;

  if (unknown) return svg(unknownKey(name));
  if (!profile) return svg(unconfiguredKey());

  // A hold gate with no feedback is indistinguishable from a broken key, so
  // show the profile lighting up as the hold completes.
  if (holdProgress !== null) {
    const p = Math.max(0, Math.min(1, holdProgress));
    const bg = dim(color, 0.75 - p * 0.75);
    return svg(
      bodyKey({
        name,
        bg,
        // The sweep ends on the full profile colour, so a pale one needs dark
        // ink by the time it gets there.
        fg: readableTextColor(bg),
        avatar,
        fade: 0.4 + p * 0.6,
        progress: p,
      }),
    );
  }

  // Working: the name steps aside for the dots rather than sharing the key
  // with them. During a switch you already know which key you pressed, so the
  // name is the least useful thing on it — and the monogram, which answers
  // "whose key is this", stays.
  if (switching) {
    return svg(
      bodyKey({
        name,
        bg: WAIT_BG,
        fg: lift(color, 0.1),
        avatar,
        fade: 0.6,
        dotFrame: dotFrame ?? 0,
        dotColor: lift(color, 0.35),
      }),
    );
  }

  if (!active) {
    // Off: a dark tile, with the profile colour in the monogram. A grey box
    // with a "C" on it does not say Carter; a green C does.
    return svg(
      bodyKey({
        name,
        bg: OFF_BG,
        fg: color,
        label: '#868C97',
        avatar,
        fade: 0.42,
        // An avatar key has no monogram to carry the colour, so it keeps the chip.
        swatch: avatar ? color : null,
      }),
    );
  }

  const stripe = STRIPE[status];
  const confirmed = status === STATUS.VERIFIED;
  const ink = readableTextColor(color);
  return svg(
    bodyKey({
      name,
      bg: color,
      fg: ink,
      avatar,
      fade: 1,
      stripe,
      dot: confirmed ? ink : null,
    }),
  );
}

/**
 * Render a mode key.
 *
 * A Mode may or may not be able to say whether it is currently on — that
 * depends on whether any of its providers can answer, which is not something
 * the key decides. So there are three looks, not two:
 *
 *   active === true   it reports itself on: lit, like an active profile
 *   active === false  it reports itself off: dark, but still identifiable
 *   active === null   nothing in it can tell, so it claims nothing and sits
 *                     between the two — live enough not to read as disabled,
 *                     dim enough that the one active profile still owns the deck
 *
 * @param {object} opts
 * @param {object} opts.mode        { name, color, avatarDataUri }
 * @param {boolean|null} [opts.active]  reported state, or null when unknowable
 * @param {boolean} [opts.running]  mid-run
 * @param {number}  [opts.dotFrame] 0..2, which dot is lit while running
 */
export function renderModeKey({ mode, active = null, running = false, dotFrame = null }) {
  if (!mode) return svg(unconfiguredKey());

  const name = escapeXml(mode.name ?? '');
  const color = mode.color ?? '#2255CC';

  // A Mode that reports itself on is lit like an active profile: the deck
  // should read the same way whatever kind of thing is switched on.
  if (active === true && !running) {
    const ink = readableTextColor(color);
    return svg(
      bodyKey({ name, bg: color, fg: ink, avatar: mode.avatarDataUri, fade: 1, dot: ink }),
    );
  }
  if (active === false && !running) {
    return svg(
      bodyKey({
        name,
        bg: OFF_BG,
        fg: color,
        label: '#868C97',
        avatar: mode.avatarDataUri,
        fade: 0.42,
      }),
    );
  }

  const bg = dim(color, running ? 0.5 : 0.68);

  return svg(
    bodyKey({
      name,
      bg,
      fg: lift(color, running ? 0.45 : 0.3),
      label: running ? undefined : '#B9BFC9',
      avatar: mode.avatarDataUri,
      fade: running ? 0.85 : 0.7,
      dotFrame: running ? (dotFrame ?? 0) : null,
      dotColor: lift(color, 0.55),
    }),
  );
}

function bodyKey({ name, bg, fg, avatar, fade, stripe, dot, swatch, progress, label, dotFrame = null, dotColor }) {
  const parts = [`<rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>`];

  if (avatar) {
    parts.push(
      `<image href="${avatar}" x="0" y="0" width="${SIZE}" height="${SIZE}" ` +
        `preserveAspectRatio="xMidYMid slice" opacity="${fade}"/>`,
      // Scrim so the label stays readable over any photo.
      `<rect x="0" y="${SIZE - 40}" width="${SIZE}" height="40" fill="#000000" opacity="0.55"/>`,
    );
  } else {
    parts.push(
      `<text x="${SIZE / 2}" y="${SIZE / 2 - 6}" font-family="sans-serif" font-size="58" ` +
        `font-weight="bold" fill="${fg}" text-anchor="middle" dominant-baseline="central" ` +
        `opacity="${fade}">${escapeXml(initial(name))}</text>`,
    );
  }

  if (swatch) {
    // Small colour chip so an inactive key still identifies whose it is.
    parts.push(`<rect x="8" y="8" width="18" height="6" rx="3" fill="${swatch}"/>`);
  }
  if (dot) {
    parts.push(`<circle cx="${SIZE - 16}" cy="16" r="6" fill="${dot}"/>`);
  }

  if (dotFrame === null) {
    parts.push(
      `<text x="${SIZE / 2}" y="${SIZE - 16}" font-family="sans-serif" ` +
        `font-size="${labelSize(name)}" font-weight="600" fill="${label ?? fg}" ` +
        `text-anchor="middle">${name}</text>`,
    );
  } else {
    for (let i = 0; i < 3; i++) {
      const on = i === dotFrame % 3;
      parts.push(
        `<circle cx="${SIZE / 2 - 16 + i * 16}" cy="${SIZE - 22}" r="${on ? 5 : 3.5}" ` +
          `fill="${dotColor ?? fg}" opacity="${on ? 1 : 0.32}"/>`,
      );
    }
  }

  if (stripe) {
    parts.push(`<rect x="0" y="${SIZE - 6}" width="${SIZE}" height="6" fill="${stripe}"/>`);
  }
  if (progress !== undefined && progress !== null) {
    parts.push(
      `<rect x="0" y="${SIZE - 6}" width="${SIZE}" height="6" fill="#000000" opacity="0.5"/>`,
      `<rect x="0" y="${SIZE - 6}" width="${Math.round(SIZE * progress)}" height="6" fill="#FFFFFF"/>`,
    );
  }
  return parts.join('');
}

/**
 * A key with no profile assigned yet.
 *
 * This has to be visibly distinct rather than falling back to the manifest
 * icon: an unassigned key that looks identical to a working one is how a
 * silently-unset dropdown went unnoticed until a press did nothing.
 */
function unconfiguredKey() {
  return (
    `<rect width="${SIZE}" height="${SIZE}" fill="#1E1E1E"/>` +
    `<rect x="6" y="6" width="${SIZE - 12}" height="${SIZE - 12}" rx="8" fill="none" ` +
    `stroke="#E8A317" stroke-width="3" stroke-dasharray="8 6"/>` +
    `<text x="${SIZE / 2}" y="${SIZE / 2 - 10}" font-family="sans-serif" font-size="44" ` +
    `font-weight="bold" fill="#E8A317" text-anchor="middle" dominant-baseline="central">!</text>` +
    `<text x="${SIZE / 2}" y="${SIZE - 30}" font-family="sans-serif" font-size="14" ` +
    `font-weight="600" fill="#E8A317" text-anchor="middle">Pick a</text>` +
    `<text x="${SIZE / 2}" y="${SIZE - 14}" font-family="sans-serif" font-size="14" ` +
    `font-weight="600" fill="#E8A317" text-anchor="middle">profile</text>`
  );
}

function unknownKey(name) {
  return (
    `<rect width="${SIZE}" height="${SIZE}" fill="#1E1E1E"/>` +
    `<text x="${SIZE / 2}" y="${SIZE / 2 - 6}" font-family="sans-serif" font-size="58" ` +
    `font-weight="bold" fill="#666666" text-anchor="middle" dominant-baseline="central">?</text>` +
    `<text x="${SIZE / 2}" y="${SIZE - 16}" font-family="sans-serif" font-size="${labelSize(name)}" ` +
    `font-weight="600" fill="#666666" text-anchor="middle">${name}</text>`
  );
}

function svg(inner) {
  const doc =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" ` +
    `viewBox="0 0 ${SIZE} ${SIZE}">${inner}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(doc, 'utf8').toString('base64')}`;
}
