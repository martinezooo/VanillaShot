#!/usr/bin/env node
/**
 * Regenerates the VanillaShot app icon.
 *
 *   node scripts/generate-icon.mjs icon.svg
 *   rsvg-convert -w 1024 -h 1024 icon.svg -o icon.png
 *   npm run tauri icon -- icon.png
 *
 * A viewfinder bracket frame around a vanilla bloom. No wordmark: macOS shows
 * the app name under the icon everywhere, so putting it inside just steals the
 * canvas and turns to mush below ~48px. Dropping it lets the mark fill the
 * frame and stay legible down to 16px.
 */
import { writeFileSync } from "node:fs";

const S = 1024;
const C = S / 2;
const CREAM = "#f4e2b6";
const AMBER = "#ffb23a";
const AMBER_DEEP = "#e2890f";

// Viewfinder frame — a large centred square of corner brackets.
const FRAME = 248;        // distance from centre to each bracket corner
const ARM = 132;          // bracket arm length
const STROKE = 33;

const L = C - FRAME;
const R = C + FRAME;
const T = C - FRAME;
const B = C + FRAME;

const bracket = (x, y, dx, dy) =>
  `<path d="M ${x + dx * ARM} ${y} H ${x} V ${y + dy * ARM}" />`;

const brackets = [
  bracket(L, T, 1, 1),
  bracket(R, T, -1, 1),
  bracket(L, B, 1, -1),
  bracket(R, B, -1, -1),
].join("\n    ");

// Vanilla bloom — five petals swept around the centre. A thin dark gap between
// petals (via the tile-coloured stroke) keeps them from merging into a disc at
// small sizes; the amber centre stays a distinct focal point either way.
const PETAL_RX = 68;
const PETAL_RY = 138;
const PETAL_OFFSET = 118;
const CENTER_R = 52;

const petals = Array.from({ length: 5 }, (_, i) => {
  const angle = -90 + i * 72;
  return `<g transform="rotate(${angle} ${C} ${C})"><ellipse cx="${C}" cy="${C - PETAL_OFFSET}" rx="${PETAL_RX}" ry="${PETAL_RY}"/></g>`;
}).join("\n      ");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2a2118"/>
      <stop offset="100%" stop-color="#0f0b07"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="46%" r="52%">
      <stop offset="0%" stop-color="#ffb23a" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="#ffb23a" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="petal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fbeecb"/>
      <stop offset="100%" stop-color="#eccf90"/>
    </linearGradient>
  </defs>

  <rect width="${S}" height="${S}" rx="${S * 0.22}" fill="url(#tile)"/>
  <rect width="${S}" height="${S}" rx="${S * 0.22}" fill="url(#glow)"/>

  <g fill="none" stroke="${AMBER}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">
    ${brackets}
  </g>

  <g fill="url(#petal)" stroke="#100b07" stroke-width="7">
      ${petals}
  </g>
  <circle cx="${C}" cy="${C}" r="${CENTER_R}" fill="${AMBER}" stroke="${AMBER_DEEP}" stroke-width="6"/>
</svg>
`;

writeFileSync(process.argv[2], svg);
console.log(`wrote ${process.argv[2]}`);
void CREAM;
