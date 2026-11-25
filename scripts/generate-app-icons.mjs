// Regenerate the checked-in desktop icons from the web SVG with Playwright Chromium.
import { readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const root = new URL('../', import.meta.url)
const svg = await readFile(new URL('web/public/mugi.svg', root), 'utf8')
const windowsSizes = [16, 24, 32, 48, 64, 128, 256]
const macTypes = new Map([
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
])
const pngs = new Map()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
  await page.setContent('<style>body { margin: 0 } svg { display: block }</style>' + svg)
  const icon = page.locator('svg')
  for (const size of new Set([...windowsSizes, ...macTypes.values()])) {
    await icon.evaluate((element, pixels) => {
      element.setAttribute('width', String(pixels))
      element.setAttribute('height', String(pixels))
    }, size)
    pngs.set(size, await icon.screenshot({ omitBackground: true, animations: 'disabled' }))
  }
} finally {
  await browser.close()
}

const ico = Buffer.alloc(6 + 16 * windowsSizes.length)
ico.writeUInt16LE(1, 2)
ico.writeUInt16LE(windowsSizes.length, 4)
let offset = ico.length
for (const [index, size] of windowsSizes.entries()) {
  const entry = 6 + 16 * index
  const png = pngs.get(size)
  ico[entry] = ico[entry + 1] = size % 256
  ico.writeUInt16LE(1, entry + 4)
  ico.writeUInt16LE(32, entry + 6)
  ico.writeUInt32LE(png.length, entry + 8)
  ico.writeUInt32LE(offset, entry + 12)
  offset += png.length
}
await writeFile(
  new URL('build/windows/mugi.ico', root),
  Buffer.concat([ico, ...windowsSizes.map((size) => pngs.get(size))]),
)

function icnsChunk(type, payload) {
  const header = Buffer.alloc(8)
  header.write(type, 'ascii')
  header.writeUInt32BE(header.length + payload.length, 4)
  return Buffer.concat([header, payload])
}
const chunks = [...macTypes].map(([type, size]) => icnsChunk(type, pngs.get(size)))
await writeFile(new URL('build/macos/mugi.icns', root), icnsChunk('icns', Buffer.concat(chunks)))
