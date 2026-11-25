import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'mugi-web-adb-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
function run(command, args, cwd = directory) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

const [packed] = JSON.parse(
  run(
    npm,
    [
      'pack',
      '--workspace',
      '@mugi/web-adb',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      directory,
    ],
    root,
  ),
)
assert.ok(packed.files.some((file) => file.path === 'dist/assets/scrcpy-server.bin'))
assert.ok(packed.files.some((file) => file.path === 'dist/index.d.ts'))
assert.ok(
  packed.files.every((file) => !file.path.startsWith('src/') && !file.path.startsWith('web/')),
)

const dependencies = JSON.parse(await readFile(join(root, 'package.json'))).devDependencies
await writeFile(
  join(directory, 'package.json'),
  JSON.stringify({
    private: true,
    type: 'module',
    dependencies: { '@mugi/web-adb': `file:${join(directory, packed.filename)}` },
    devDependencies: { typescript: dependencies.typescript, vite: dependencies.vite },
  }),
)
run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund'])
await writeFile(
  join(directory, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      types: [],
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    },
    include: ['main.ts'],
  }),
)
await writeFile(
  join(directory, 'main.ts'),
  `
import { connectWebUsb, createCredentialStore, operate, openTerminal, readMetrics, LogcatParser } from '@mugi/web-adb'
import { WebUsbSession, ControlEncoder, VideoPlayer } from '@mugi/web-adb/scrcpy'
import { shellQuote } from '@mugi/web-adb/helpers'

document.querySelector('button')!.addEventListener('click', async () => {
  const connection = await connectWebUsb(undefined, console.log, {
    credentialStore: createCredentialStore({ storage: null }),
  })
  if (!connection) return
  await operate(connection, 'home')
  await connection.shell('echo ' + shellQuote('hello'))
  await connection.files('/sdcard/Download')
  await readMetrics(connection, new AbortController().signal)
  const canvas = document.createElement('canvas')
  new VideoPlayer(canvas).close()
  const session = new WebUsbSession(connection, { id: 'test', opts: { mode: 'mirror' } }, canvas)
  session.send(ControlEncoder.text('hello'))
  session.start()
  new LogcatParser().push(new Uint8Array())
  const terminal = await openTerminal(connection, 24, 80, new AbortController().signal, async () => {}, console.log)
  terminal.close()
  await session.close()
  await connection.close()
})
`,
)
await writeFile(
  join(directory, 'index.html'),
  '<button>Connect</button><script type="module" src="/main.ts"></script>',
)
run(npm, ['exec', '--', 'tsc', '-p', 'tsconfig.json'])
run(npm, ['exec', '--', 'vite', 'build'])
const assets = await readdir(join(directory, 'dist/assets'))
assert.ok(assets.some((name) => name.startsWith('scrcpy-server') && name.endsWith('.bin')))
run(process.execPath, [
  '--input-type=module',
  '-e',
  `
  const sdk = await import('@mugi/web-adb')
  const scrcpy = await import('@mugi/web-adb/scrcpy')
  if (sdk.WebUsbConnection.available() || typeof scrcpy.WebUsbSession !== 'function') process.exit(1)
`,
])
console.log(
  `Package consumer typecheck, browser build, asset emission and import passed: ${directory}`,
)
