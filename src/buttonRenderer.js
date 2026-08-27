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

/**
 * Render one profile key.
 *
 * @param {object} opts
 * @param {object} opts.profile        { name, color, avatarDataUri }
 * @param {boolean} opts.active        is this the profile currently in effect
 * @param {string} [opts.status]       aggregate STATUS when active
 * @param {boolean} [opts.switching]   mid-transition
 * @param {boolean} [opts.unknown]     state could not be read at all
 */
export function renderProfileKey({ profile, active, status, switching = false, unknown = false }) {
  const name = escapeXml(profile?.name ?? '');
  const color = profile?.color ?? '#2255CC';
  const avatar = profile?.avatarDataUri;

  if (unknown) return svg(unknownKey(name));
  if (switching) return svg(bodyKey({ name, bg: dim(color, 0.55), fg: '#C8C8C8', avatar, fade: 0.6 }));

  if (!active) {
    // Off: near-black, avatar knocked well back, muted label.
    return svg(bodyKey({ name, bg: '#141414', fg: '#7A7A7A', avatar, fade: 0.35, swatch: color }));
  }

  const stripe = STRIPE[status];
  const confirmed = status === STATUS.VERIFIED;
  return svg(
    bodyKey({
      name,
      bg: color,
      fg: '#FFFFFF',
      avatar,
      fade: 1,
      stripe,
      dot: confirmed ? '#FFFFFF' : null,
    }),
  );
}

function bodyKey({ name, bg, fg, avatar, fade, stripe, dot, swatch }) {
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

  parts.push(
    `<text x="${SIZE / 2}" y="${SIZE - 16}" font-family="sans-serif" ` +
      `font-size="${labelSize(name)}" font-weight="600" fill="${fg}" ` +
      `text-anchor="middle">${name}</text>`,
  );

  if (stripe) {
    parts.push(`<rect x="0" y="${SIZE - 6}" width="${SIZE}" height="6" fill="${stripe}"/>`);
  }
  return parts.join('');
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
