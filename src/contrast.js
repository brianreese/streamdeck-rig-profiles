// contrast.js — pick a legible foreground for an arbitrary background colour.
//
// Profiles carry a user-chosen colour, and that colour ends up behind text in
// three places: the key on the deck, the swatch in the editor's profile list,
// and the tile preview. White-on-anything was the rule until now, which is
// fine for #2255cc and unreadable on #ffe066.
//
// The rule here is WCAG 2.x relative luminance, not the average of the three
// channels. The difference is not academic: #00ff00 and #0000ff have the same
// naive average (85) but luminances of 0.72 and 0.07 — one needs black text and
// the other needs white. Green is over ten times brighter than blue to the eye,
// and only the weighted formula knows that.
//
// No dependencies and no Node built-ins, deliberately: the browser editor
// imports this exact file over HTTP from editorServer.js, so the deck and the
// editor cannot drift into disagreeing about what is readable.

/** Channels 0-255 from #rgb or #rrggbb, or null if it is not a hex colour. */
export function parseHex(hex) {
  const raw = String(hex ?? '').trim().replace(/^#/, '');
  const full = raw.length === 3 ? raw.replace(/./g, (c) => c + c) : raw;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * WCAG relative luminance, 0 (black) to 1 (white).
 *
 * The per-channel step undoes sRGB's gamma encoding — a byte of 128 is not half
 * the light of 255 — and the weights are how much each primary contributes to
 * perceived brightness.
 */
export function relativeLuminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours: 1 (identical) to 21 (black/white). */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Foreground colours used on top of a profile colour. Not pure black: a hard
 *  #000 on a saturated tile reads as a hole rather than as text. */
export const INK = { dark: '#141414', light: '#FFFFFF' };

/**
 * The more legible of two foregrounds on `background`.
 *
 * Compares actual contrast ratios rather than testing luminance against a
 * threshold, so it stays correct if the two inks are ever changed to something
 * other than near-black and white.
 */
export function readableTextColor(background, { dark = INK.dark, light = INK.light } = {}) {
  if (!parseHex(background)) return light;
  return contrastRatio(background, dark) >= contrastRatio(background, light) ? dark : light;
}

/** True when `background` is light enough to need dark text. */
export function isLight(background) {
  return readableTextColor(background) !== INK.light;
}
