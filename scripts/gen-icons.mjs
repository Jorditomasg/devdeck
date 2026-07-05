// Generates the DevDeck "dd" monogram icon set from a single vector path.
// Source of truth for the artwork lives here (no committed SVG files).
//
//   node scripts/gen-icons.mjs
//
// Dev-only deps (@resvg/resvg-js, png-to-ico) — pure JS/wasm, no system libs.
// Outputs land in src-tauri/icons/. Static app icons + idle tray use the white
// glyph; the tray swaps to green (running) / red (error) at runtime (lib.rs).
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ICONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons')

// One lowercase "d": bowl (disk) + ascender stem, with an even-odd counter hole.
// Local box ~ x:20..180, y:15..250. The mark is two of these, 190u apart.
const D =
  'M140,35 A20,20 0 0 1 180,35 L180,170 A80,80 0 1 1 140,100.72 Z' + // outer silhouette
  'M142,170 A42,42 0 1 0 58,170 A42,42 0 1 0 142,170 Z' // counter (hole via evenodd)

// Diagonal light→dark gradient per glyph (objectBoundingBox: identical on both
// d's) for a professional sense of depth. `stroke` keeps the outline.
const svg = ({ from, to, stroke, sw = 20 }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/>
      <stop offset="1" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <g transform="translate(11,86) scale(1.3)" fill="url(#g)" fill-rule="evenodd"
     stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round" paint-order="stroke">
    <path d="${D}"/>
    <path transform="translate(190,0)" d="${D}"/>
  </g>
</svg>`

const INK = '#141414'
const VARIANTS = {
  idle: svg({ from: '#FFFFFF', to: '#D4D4D8', stroke: INK }), // static app icons + idle tray
  green: svg({ from: '#4ADE80', to: '#15803D', stroke: INK }), // tray: something running
  red: svg({ from: '#F87171', to: '#DC2626', stroke: INK }), // tray: something errored
}

const png = (variant, size) =>
  Buffer.from(new Resvg(VARIANTS[variant], { fitTo: { mode: 'width', value: size } }).render().asPng())

const ico = (variant, sizes) => pngToIco(sizes.map((s) => png(variant, s)))

const out = (name, buf) => writeFileSync(join(ICONS, name), buf)

// --- static app icons (idle look) ---
out('32x32.png', png('idle', 32))
out('128x128.png', png('idle', 128))
out('128x128@2x.png', png('idle', 256))
out('icon.ico', await ico('idle', [16, 24, 32, 48, 64, 128, 256])) // app + idle tray
out('installer.ico', await ico('idle', [16, 32, 48, 256]))

// --- dynamic tray variants ---
out('icon-green.ico', await ico('green', [16, 24, 32, 48, 64]))
out('icon-red.ico', await ico('red', [16, 24, 32, 48, 64]))

console.log('icons written to', ICONS)
