import assert from 'node:assert/strict'
import test from 'node:test'
import {
  operate,
  operationCommand,
  screenshot,
  installAPKSet,
  parseDeviceInfo,
  parseControlState,
  parseSnapshot,
  calculateMetrics,
  LogcatParser,
  filterLogcat,
} from '../dist/index.js'

const signal = () => new AbortController().signal
const stream = (bytes) =>
  new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })

test('device operations validate arguments and report Android failures', async () => {
  assert.throws(() => operationCommand('app-clear', 'com.example;reboot'))
  assert.throws(() => operationCommand('brightness', '256'))
  assert.equal(operationCommand('home'), 'input keyevent 3')
  await assert.rejects(
    operate({ shell: async () => 'Failure [restricted]' }, 'app-clear', 'com.example.app'),
  )
  const calls = []
  await operate(
    { adb: { power: { reboot: async () => calls.push('reboot') } } },
    'reboot',
    '',
    signal(),
  )
  assert.deepEqual(calls, ['reboot'])
  assert.equal(parseDeviceInfo('').battery.percent, null)
})

test('control state and absolute media volume entry points are allowlisted', async () => {
  assert.throws(() => operationCommand('control-state', '0'))
  for (const value of ['', '-1', '-0', '01', '+1', '1.0', '1e1', ' 1', '1\n', '1;id', '256']) {
    assert.throws(() => operationCommand('media-volume', value))
  }
  for (const value of ['0', '53', '255']) {
    assert.equal(
      operationCommand('media-volume', value),
      "cmd media_session volume --stream 3 --set '" + value + "'",
    )
  }
  const read = operationCommand('control-state')
  assert.match(read, /wifi_connected=/)
  const calls = []
  const usb = {
    shell: async (command) => {
      calls.push(command)
      return command === read ? 'volume=53,0,150\n' : ''
    },
  }
  assert.equal(await operate(usb, 'control-state'), 'volume=53,0,150\n')
  await operate(usb, 'media-volume', '53')
  assert.deepEqual(calls, [read, "cmd media_session volume --stream 3 --set '53'"])
})

test('control-state parser preserves real ranges and represents unknowns independently', () => {
  assert.deepEqual(
    parseControlState(
      'wifi=1\r\nwifi_connected=0\r\nbluetooth=true\r\nairplane=false\r\nbrightness=81\r\nauto_brightness=1\r\nvolume=53,0,150\r\n',
    ),
    {
      wifi: true,
      wifiConnected: false,
      bluetooth: true,
      airplane: false,
      brightness: 81,
      autoBrightness: true,
      volume: { level: 53, min: 0, max: 150 },
    },
  )
  const unknown = {
    wifi: null,
    wifiConnected: null,
    bluetooth: null,
    airplane: null,
    brightness: null,
    autoBrightness: null,
    volume: null,
  }
  assert.deepEqual(parseControlState(''), unknown)
  assert.deepEqual(
    parseControlState(
      'wifi=enabling\nwifi_connected=\nbluetooth=null\nairplane=4\nbrightness=999\nauto_brightness=2\nvolume=5',
    ),
    unknown,
  )
  assert.equal(parseControlState('brightness=0').brightness, 0)
  assert.deepEqual(parseControlState('volume=5,1,15').volume, { level: 5, min: 1, max: 15 })
  assert.deepEqual(parseControlState('volume=0,0,0').volume, { level: 0, min: 0, max: 0 })
  for (const raw of ['5,6,15', '5,0,4', '5,15,0', '-1,0,15', '5,0,9007199254740993']) {
    assert.equal(parseControlState('volume=' + raw).volume, null)
  }
})

test('screenshots preserve binary data and always kill the shell', async () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255])
  let killed = 0
  const usb = {
    adb: {
      subprocess: {
        shellProtocol: {
          spawn: async () => ({
            stdout: stream(png),
            stderr: stream(new Uint8Array()),
            exited: Promise.resolve(0),
            kill: async () => {
              killed++
            },
          }),
        },
      },
    },
  }
  const result = await screenshot(usb, signal())
  assert.equal(result.type, 'image/png')
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), png)
  assert.equal(killed, 1)
})

test('failed split installs abandon Android sessions and clean temporary files', async () => {
  const commands = []
  let disposed = 0
  const usb = {
    shell: async (command) => {
      commands.push(command)
      if (command.startsWith('pm install-create')) return 'Success: created install session [42]'
      if (command.startsWith('pm install-write')) return 'Success'
      if (command.startsWith('pm install-commit')) return 'Failure [INSTALL_FAILED_MISSING_SPLIT]'
      return ''
    },
    adb: {
      sync: async () => ({
        write: async ({ file }) => {
          for await (const _ of file) {
            /* drain */
          }
        },
        dispose: async () => {
          disposed++
        },
      }),
    },
  }
  await assert.rejects(
    installAPKSet(usb, [new File(['apk'], 'base.apk')], { test: true, downgrade: false }, () => {}),
  )
  assert.ok(commands.includes('pm install-abandon 42'))
  assert.ok(commands.at(-1).startsWith('rm -rf -- '))
  assert.equal(disposed, 1)
})

test('metrics and log parsing work without application state', () => {
  const snapshot = parseSnapshot(
    '__UPTIME__\n1 0\n__CPU__\ncpu 10 0 5 85\n__MEMORY__\nMemTotal: 100 kB\nMemAvailable: 40 kB\n__NETWORK__\n__END__',
  )
  assert.deepEqual(snapshot.memory, { total: 102400, used: 61440 })
  assert.equal(calculateMetrics(snapshot).cpu, null)
  const parser = new LogcatParser()
  const bytes = new TextEncoder().encode('09-26 10:20:30.001 42 42 E App: 日志\n')
  const rows = [...parser.push(bytes.slice(0, -2)), ...parser.push(bytes.slice(-2))]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].pid, 42)
  assert.equal(filterLogcat(rows, 'E', '日志', '').length, 1)
})
