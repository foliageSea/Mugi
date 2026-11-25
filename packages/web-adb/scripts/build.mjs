import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const root = new URL('../', import.meta.url)
const read = (path) => readFile(new URL(path, root))
const server = await read('assets/scrcpy-server.bin')
const expected = (await read('assets/SHA256SUMS.txt')).toString().trim().split(/\s+/)[0]
if (createHash('sha256').update(server).digest('hex') !== expected) {
  throw new Error('scrcpy-server does not match assets/SHA256SUMS.txt')
}
const definitions = JSON.parse(await read('assets/operations.json'))
const infoCommand = (await read('assets/device-info.sh')).toString()
const metricsCommand = (await read('assets/metrics.sh')).toString()
await mkdir(new URL('dist/assets/', root), { recursive: true })
await copyFile(
  new URL('assets/scrcpy-server.bin', root),
  new URL('dist/assets/scrcpy-server.bin', root),
)
await writeFile(
  new URL('dist/resources.js', root),
  Object.entries({ definitions, infoCommand, metricsCommand })
    .map(([key, value]) => `export const ${key} = ${JSON.stringify(value)}\n`)
    .join(''),
)
await copyFile(new URL('src/resources.d.ts', root), new URL('dist/resources.d.ts', root))
