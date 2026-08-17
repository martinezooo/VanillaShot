#!/usr/bin/env node
/**
 * Regenerates the VanillaShot app icon.
 *
 *   node scripts/generate-icon.mjs icon.svg
 *   rsvg-convert -w 1024 -h 1024 icon.svg -o icon.png
 *   npm run tauri icon -- icon.png
 *
 * A viewfinder bracket frame around a vanilla bloom, with the wordmark below.
 * The wordmark stops being readable below roughly 48px - the cost of putting
 * the full name in an icon - while the bloom and brackets still read at 32px.
 */
import { writeFileSync } from "node:fs";

const S = 1024;
const CREAM = "#f2dfb0";
const AMBER = "#ffab2e";

// Viewfinder frame ---------------------------------------------------------
const FRAME_L = 214;
const FRAME_R = S - FRAME_L;
const FRAME_T = 172;
const FRAME_B = 636;
const ARM = 96;
const STROKE = 20;

const bracket = (x, y, dx, dy) =>
  `<path d="M ${x + dx * ARM} ${y} H ${x} V ${y + dy * ARM}" />`;

const brackets = [
  bracket(FRAME_L, FRAME_T, 1, 1),
  bracket(FRAME_R, FRAME_T, -1, 1),
  bracket(FRAME_L, FRAME_B, 1, -1),
  bracket(FRAME_R, FRAME_B, -1, -1),
].join("\n    ");

// Vanilla bloom ------------------------------------------------------------
// Five petals swept around the centre, plus a small throat. Kept as plain
// ellipses so the shape still reads at 32px.
const CX = S / 2;
const CY = 398;
const PETAL_RX = 53;
const PETAL_RY = 99;
const PETAL_OFFSET = 88;

const petals = Array.from({ length: 5 }, (_, i) => {
  const angle = -90 + i * 72;
  return `<g transform="rotate(${angle} ${CX} ${CY})"><ellipse cx="${CX}" cy="${CY - PETAL_OFFSET}" rx="${PETAL_RX}" ry="${PETAL_RY}"/></g>`;
}).join("\n      ");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#241d14"/>
      <stop offset="100%" stop-color="#0f0c08"/>
    </linearGradient>
  </defs>

  <rect width="${S}" height="${S}" rx="${S * 0.22}" fill="url(#tile)"/>

  <g fill="none" stroke="${AMBER}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">
    ${brackets}
  </g>

  <g fill="${CREAM}">
      ${petals}
  </g>
  <circle cx="${CX}" cy="${CY}" r="39" fill="${AMBER}"/>

  <text x="${CX}" y="812" text-anchor="middle"
        font-family="Helvetica Neue, Helvetica, Arial, sans-serif"
        font-size="104" font-weight="600" letter-spacing="1" fill="${CREAM}">VanillaShot</text>
</svg>
`;

writeFileSync(process.argv[2], svg);
console.log(`wrote ${process.argv[2]}`);
