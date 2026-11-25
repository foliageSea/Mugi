import assert from 'node:assert/strict'
import test from 'node:test'
import { WebUsbConnection } from '../dist/index.js'
import { parseAppIconVersions } from '../dist/app-icons.js'

const pngBytes = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZKx8AAAAASUVORK5CYII=',
    'base64',
  ),
)
function stream(bytes = new Uint8Array()) {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

function connectionWithIconOutput(output) {
  let uploads = 0
  const commands = []
  const dex = new Uint8Array(112)
  dex.set(new TextEncoder().encode('dex\n035\0'))
  const adb = {
    serial: 'fixture',
    disconnected: new Promise(() => {}),
    subprocess: {
      shellProtocol: {
        async spawn(command) {
          commands.push(command)
          return {
            stdout: stream(command.includes('dev.mugi.icons.Main') ? output : undefined),
            stderr: stream(),
            exited: Promise.resolve(0),
            kill() {},
          }
        },
      },
    },
    async sync() {
      return {
        async write({ filename, file }) {
          assert.match(filename, /app-icons-[a-f0-9]{64}\.dex\./)
          for await (const chunk of file) assert.deepEqual(chunk, dex)
          uploads++
        },
        async dispose() {},
      }
    },
  }
  const connection = new WebUsbConnection({}, adb, 'Phone', 0, 0, {
    appIconSource: async () => dex,
  })
  return { connection, commands, uploads: () => uploads }
}

test('pm package output preserves long version codes and equals signs in install paths', () => {
  const versions = parseAppIconVersions(
    [
      'package:/data/app/~~abc==/com.example.photos-x==/base.apk=com.example.photos versionCode:9223372036854775807',
      'package:/system/app/Settings.apk=com.android.settings versionCode:20',
      'package:/broken.apk=com.example.unversioned',
      'Error: unsupported option',
    ].join('\r\n'),
  )
  assert.deepEqual(
    [...versions],
    [
      [
        'com.example.photos',
        JSON.stringify([
          '9223372036854775807',
          '/data/app/~~abc==/com.example.photos-x==/base.apk',
        ]),
      ],
      ['com.android.settings', JSON.stringify(['20', '/system/app/Settings.apk'])],
    ],
  )
})

test('WebUSB shares one DEX upload and returns raw unmodified icon bytes', async () => {
  const { connection, commands, uploads } = connectionWithIconOutput(pngBytes)
  const icons = await Promise.all([
    connection.appIcon('com.android.settings'),
    connection.appIcon('com.example.photos'),
  ])
  assert.equal(uploads(), 1)
  assert.equal(commands.filter((command) => command.startsWith('chmod 444 ')).length, 1)
  assert.equal(commands.filter((command) => command.includes('dev.mugi.icons.Main')).length, 2)
  for (const icon of icons) {
    assert.equal(icon.type, 'image/png')
    assert.deepEqual(new Uint8Array(await icon.arrayBuffer()), pngBytes)
  }
  const before = commands.length
  await assert.rejects(connection.appIcon('com.example; whoami'), /应用包名无效/)
  await assert.rejects(connection.appIcon('com.example', AbortSignal.abort()), {
    name: 'AbortError',
  })
  assert.equal(commands.length, before)
})

test('WebUSB rejects malformed and oversized icon output', async () => {
  const malformed = connectionWithIconOutput(Uint8Array.of(65, 66))
  await assert.rejects(malformed.connection.appIcon('com.example.photos'), /PNG/)
  const oversized = connectionWithIconOutput(new Uint8Array((256 << 10) + 1))
  await assert.rejects(oversized.connection.appIcon('com.example.photos'), /大小限制/)
  const largePng = pngBytes.slice()
  new DataView(largePng.buffer).setUint32(16, 129)
  await assert.rejects(connectionWithIconOutput(largePng).connection.appIcon('android'), /尺寸无效/)
})
