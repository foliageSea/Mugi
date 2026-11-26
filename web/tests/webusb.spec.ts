import { test, expect, type Page } from '@playwright/test'

async function usbPage(page: Page, photoVersion?: number) {
  const apiRequests: string[] = []
  // The desktop probes deployment policy even in WebUSB mode; device operations
  // must still stay entirely on USB. Mock that policy independently of hardware.
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({
      json: { network: 'local', adbAllowed: true, webusbAllowed: true },
    }),
  )
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/api/') && path !== '/api/capabilities') apiRequests.push(request.url())
  })
  await page.goto('/?transport=webusb')
  // Fake only the hardware boundary. Real shell/file/session code, stream parsers,
  // API routing and Vue components run against deterministic ADB streams.
  await page.evaluate(async (photoVersion) => {
    const path = '/src/services/webusb.ts'
    const { WebUsbConnection } = await import(path)
    const state = {
      writes: [] as number[][],
      commands: [] as string[],
      controls: {
        wifi: 1,
        wifi_connected: 0,
        bluetooth: 0,
        airplane: 0,
        brightness: 135,
        display_brightness: '0.52755904,0.035433073,1.0',
        auto_brightness: 0,
        volume: '5,0,15',
      },
      uploads: [] as { path: string; size: number }[],
      closedSockets: 0,
      killed: 0,
      disconnected: false,
      failSocket: false,
      holdSocket: false,
      pending: [] as (() => void)[],
      disconnect: () => {},
    }
    ;(window as any).__usb = state
    const encoder = new TextEncoder()
    const textStream = (text: string) =>
      new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(text))
          c.close()
        },
      })
    const image = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZKx8AAAAASUVORK5CYII=',
      ),
      (c) => c.charCodeAt(0),
    )
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const iconImage = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]!), (c) =>
      c.charCodeAt(0),
    )
    const tree: Record<string, { name: string; size: bigint; mtime: bigint; type: number }[]> = {
      '/sdcard/Download': [
        { name: 'report.txt', size: 5n, mtime: 1700000000n, type: 8 },
        { name: 'photo.png', size: BigInt(image.length), mtime: 1700000000n, type: 8 },
      ],
      '/sdcard/Pictures': [
        { name: 'photo.png', size: BigInt(image.length), mtime: 1700000000n, type: 8 },
      ],
    }
    const sockets: { close: () => Promise<void> }[] = []
    const indices: Record<string, number> = {}
    const audioEnabled: Record<string, boolean> = {}
    let resolveDisconnected!: () => void
    const disconnected = new Promise<void>((r) => {
      resolveDisconnected = r
    })
    const adb = {
      serial: 'usb-phone',
      disconnected,
      subprocess: {
        shellProtocol: {
          spawn: async (command: string) => {
            state.commands.push(command)
            let output = ''
            if (command.includes('query-activities'))
              output = 'com.example.photos/Main\ncom.android.settings/Main\n'
            else if (command.includes('list_apps=true'))
              output = ' - 照片  com.example.photos\n * 设置  com.android.settings\n'
            else if (command.includes('getprop ro.build.fingerprint'))
              output =
                '0\nmock/build:fingerprint\n' +
                'package:/data/app/~~id==/photos/base.apk=com.example.photos versionCode:' +
                photoVersion +
                '\n' +
                'package:/system/settings.apk=com.android.settings versionCode:1\n'
            else if (command.includes('echo __ALL__; pm list packages'))
              output =
                '__ALL__\npackage:com.example.photos\npackage:com.android.settings\n' +
                'package:com.example.background\n' +
                '__SYSTEM__\npackage:com.android.settings\n__DISABLED__\n__END__\n'
            if (command.includes('dev.mugi.icons.Main')) {
              return {
                stdout: new ReadableStream({
                  start(c) {
                    c.enqueue(iconImage)
                    c.close()
                  },
                }),
                stderr: textStream(''),
                exited: Promise.resolve(0),
                kill: async () => {},
              }
            } else if (command === 'dumpsys power') output = 'mWakefulness=Awake'
            else if (command === 'dumpsys window') output = 'mShowingLockscreen=false'
            else if (command === 'dumpsys battery')
              output = 'AC powered: false\nUSB powered: true\nstatus: 2\nlevel: 64\nscale: 100\n'
            else if (command.startsWith('pm install')) output = 'Success\n'
            else if (command.includes('wifi_connected=')) {
              output = Object.entries(state.controls)
                .map(([key, value]) => key + '=' + value)
                .join('\n')
            } else if (command === "svc wifi 'disable'") {
              state.controls.wifi = 0
              state.controls.wifi_connected = 0
            } else if (command === 'input keyevent 24' || command === 'input keyevent 25') {
              const [level, min, max] = state.controls.volume.split(',').map(Number)
              const delta = command === 'input keyevent 24' ? 1 : -1
              state.controls.volume = `${Math.min(max, Math.max(min, level + delta))},${min},${max}`
            } else if (command === 'settings put --user current system screen_brightness_mode 1') {
              state.controls.auto_brightness = 1
            } else {
              const brightness =
                command.includes('cmd display set-brightness') && command.match(/-v level='(\d+)'/)
              if (brightness) {
                state.controls.display_brightness = [
                  Number(brightness[1]) / 1_000_000,
                  0.035433073,
                  1,
                ].join(',')
                state.controls.auto_brightness = 0
              }
            }
            if (command.includes(' scid=')) {
              audioEnabled[`localabstract:scrcpy_${command.match(/scid=(\w+)/)![1]}`] =
                command.includes('audio=true')
              let resolve!: (code: number) => void
              const exited = new Promise<number>((r) => {
                resolve = r
              })
              return {
                stdout: textStream(''),
                stderr: textStream(''),
                exited,
                kill: async () => {
                  state.killed++
                  resolve(0)
                },
              }
            }
            return {
              stdout: textStream(output),
              stderr: textStream(''),
              exited: Promise.resolve(0),
              kill: async () => {},
            }
          },
        },
      },
      sync: async () => ({
        dispose: async () => {},
        write: async ({
          filename,
          file,
        }: {
          filename: string
          file: ReadableStream<Uint8Array>
        }) => {
          let size = 0
          const chunks: Uint8Array[] = []
          const reader = file.getReader()
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            size += value!.length
            chunks.push(value!)
          }
          reader.releaseLock()
          const bytes = new Uint8Array(size)
          let offset = 0
          for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.length
          }
          const digest = await crypto.subtle.digest('SHA-256', bytes)
          const sha = Array.from(new Uint8Array(digest), (b) =>
            b.toString(16).padStart(2, '0'),
          ).join('')
          state.uploads.push({ path: filename, size, sha })
        },
        readdir: async (path: string) => tree[path] || [],
        lstat: async () => {
          throw new Error('ENOENT')
        },
        read: (path: string) =>
          new ReadableStream({
            start(c) {
              c.enqueue(path.endsWith('.png') ? image : encoder.encode('hello'))
              c.close()
            },
          }),
      }),
      createSocket: async (address: string) => {
        const index = indices[address] || 0
        if (state.failSocket && index === 1) throw new Error('test socket failure')
        indices[address] = index + 1
        let controller!: ReadableStreamDefaultController<Uint8Array>
        let closed = false
        const readable = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c
            if (index === 0) {
              const bytes = new Uint8Array(81)
              bytes.set(encoder.encode('USB Phone'), 1)
              bytes.set(encoder.encode('h264'), 65)
              const view = new DataView(bytes.buffer)
              view.setUint32(69, 0x80000000)
              view.setUint32(73, 1080)
              view.setUint32(77, 2400)
              c.enqueue(bytes)
            } else if (index === 1 && audioEnabled[address]) c.enqueue(encoder.encode('opus'))
          },
        })
        const socket = {
          readable,
          writable: new WritableStream({
            write: (data: Uint8Array) => {
              state.writes.push([...data])
            },
          }),
          close: async () => {
            if (!closed) {
              closed = true
              state.closedSockets++
              try {
                controller.close()
              } catch {}
            }
          },
        }
        sockets.push(socket)
        if (state.holdSocket) await new Promise<void>((r) => state.pending.push(r))
        return socket
      },
      close: async () => {
        for (const s of sockets) await s.close()
        resolveDisconnected()
      },
    }
    let connection: any
    WebUsbConnection.request = async (_signal: unknown, _progress: unknown, options: unknown) => {
      connection = new WebUsbConnection(
        { raw: { close: async () => {}, serialNumber: 'mock-serial', vendorId: 1, productId: 2 } },
        adb,
        'USB Phone',
        1080,
        2400,
        photoVersion === undefined ? undefined : options,
      )
      ;(window as any).__connection = connection
      return connection
    }
    WebUsbConnection.available = () => true
    state.disconnect = () => {
      state.disconnected = true
      void adb.close()
    }
  }, photoVersion)
  // The capability is captured by DeviceDialog at mount. Chromium normally has
  // navigator.usb; no hardware picker is invoked by the test stub above.
  await page.locator('.device-trigger').click()
  await page.getByRole('button', { name: '选择 USB 设备', exact: true }).click()
  await expect(page.locator('.device-trigger')).toContainText('USB Phone · WebUSB')
  await expect(page.getByRole('img', { name: '电量 64% · 充电中' })).toContainText('64%')
  return apiRequests
}

test('WebUSB launcher keeps PNGs in IndexedDB across reloads and replaces changed revisions', async ({
  page,
}) => {
  const iconCommands = () =>
    page.evaluate(() =>
      ((window as any).__usb.commands as string[]).filter((command) =>
        command.includes('dev.mugi.icons.Main'),
      ),
    )
  const showIcons = async () => {
    await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
    for (const name of ['打开 照片', '打开 设置']) {
      const icon = page.getByRole('button', { name, exact: true }).locator('img')
      await expect(icon).toHaveAttribute('src', /^blob:/)
      await expect.poll(() => icon.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)
    }
  }
  const requests = await usbPage(page, 1)
  expect(await iconCommands()).toEqual([])
  await showIcons()
  expect(await iconCommands()).toHaveLength(2)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const request = indexedDB.open('mugi.app-icons', 1)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => {
              const db = request.result
              const tx = db.transaction('icons', 'readonly')
              const count = tx.objectStore('icons').count()
              count.onsuccess = () => resolve(count.result)
              count.onerror = () => reject(count.error)
              tx.oncomplete = () => db.close()
            }
          }),
      ),
    )
    .toBe(2)
  expect(requests).toEqual([])

  await usbPage(page, 1)
  await showIcons()
  expect(await iconCommands()).toEqual([])

  await usbPage(page, 2)
  await showIcons()
  const refreshed = await iconCommands()
  expect(refreshed).toHaveLength(1)
  expect(refreshed[0]).toContain('com.example.photos')
})

test('WebUSB application manager loads icons and shows placeholders without opening the launcher', async ({
  page,
}) => {
  const requests = await usbPage(page, 1)
  await page.getByRole('button', { name: '应用管理', exact: true }).click()

  const rows = page.locator('.app-manager-row')
  const photos = rows.filter({ hasText: 'com.example.photos' })
  const photosIcon = photos.locator('img.is-loaded')
  await expect(photosIcon).toBeVisible()
  await expect(photosIcon).toHaveAttribute('src', /^blob:/)

  const placeholder = rows.filter({ hasText: 'com.example.background' }).locator('.app-art')
  await expect(placeholder.locator('svg')).toBeVisible()
  await expect(placeholder.locator('img')).toHaveCount(0)

  await photos.click()
  await expect(page.locator('.app-manager-detail img.is-loaded')).toBeVisible()
  await expect(page.getByRole('dialog', { name: '应用启动器', exact: true })).toHaveCount(0)
  expect(requests).toEqual([])
})

test('WebUSB launcher ignores a late icon from an older app refresh', async ({ page }) => {
  await usbPage(page)
  await page.evaluate(async () => {
    const connection = (window as any).__connection
    const request = () =>
      new Promise<Blob>((resolve) => {
        ;(window as any).__oldIcon = resolve
      })
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const icon = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!)))
    let photos = 0
    connection.appIcon = async (pkg: string) => {
      if (pkg !== 'com.example.photos') return undefined
      return ++photos === 1 ? request() : icon
    }
  })
  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  const photos = page.getByRole('button', { name: '打开 照片', exact: true })
  await expect(photos).toBeVisible()
  await expect(photos.locator('img')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => typeof (window as any).__oldIcon)).toBe('function')
  await page.getByRole('button', { name: '刷新应用', exact: true }).click()
  await expect(photos.locator('img')).toHaveAttribute('src', /^blob:/)
  const url = await photos.locator('img').getAttribute('src')
  await page.evaluate(() => {
    ;(window as any).__oldIcon(new Blob(['old icon'], { type: 'image/png' }))
  })
  await expect
    .poll(() => photos.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1)
  await expect(photos.locator('img')).toHaveAttribute('src', url!)
  await page.evaluate(() => (window as any).__usb.disconnect())
  await expect(photos).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(
        async (url) =>
          fetch(url!).then(
            () => false,
            () => true,
          ),
        url,
      ),
    )
    .toBe(true)
})

test('WebUSB Logcat streams without HTTP fallback and kills processes on close', async ({
  page,
}) => {
  const requests = await usbPage(page)
  await page.evaluate(() => {
    const connection = (window as any).__connection
    const original = connection.adb.subprocess.shellProtocol.spawn
    let killed = 0
    ;(window as any).__logcatKilled = () => killed
    connection.adb.subprocess.shellProtocol.spawn = async (command: string) => {
      if (!command.includes('-v threadtime')) return original(command)
      const encode = new TextEncoder()
      let out!: ReadableStreamDefaultController<Uint8Array>
      let err!: ReadableStreamDefaultController<Uint8Array>
      let exit!: (code: number) => void
      let closed = false
      return {
        stdout: new ReadableStream({
          start(c) {
            out = c
            c.enqueue(encode.encode('09-26 10:20:30.001 42 42 E App: USB 日志\n'))
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            err = c
          },
        }),
        exited: new Promise<number>((resolve) => {
          exit = resolve
        }),
        kill: async () => {
          if (closed) return
          closed = true
          killed++
          out.close()
          err.close()
          exit(0)
        },
      }
    }
  })
  await page.getByRole('button', { name: 'Logcat', exact: true }).click()
  const panel = page.getByTestId('logcat-window')
  await expect(panel.getByRole('region', { name: 'Logcat 日志' })).toContainText('USB 日志')
  await panel.getByRole('button', { name: '清空设备日志' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__logcatKilled())).toBe(1)
  await expect(panel.getByRole('status')).toContainText('已连接')
  await page.getByRole('button', { name: '关闭Logcat窗口', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__logcatKilled())).toBe(2)
  expect(requests).toEqual([])
  expect(await page.evaluate(() => (window as any).__usb.commands)).toContain(
    'logcat -b main -b system -b crash -c',
  )
})

test('WebUSB workbench supports binary screenshots and abandons failed split installs', async ({
  page,
}) => {
  const requests = await usbPage(page)
  const result = await page.evaluate(async () => {
    const connection = (window as any).__connection
    const commands: string[] = []
    const encoder = new TextEncoder()
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255])
    const stream = (bytes: Uint8Array) =>
      new ReadableStream({
        start(c) {
          c.enqueue(bytes)
          c.close()
        },
      })
    connection.adb.subprocess.shellProtocol.spawn = async (command: string) => {
      commands.push(command)
      const output = command.startsWith('pm install-create')
        ? 'Success: created install session [42]'
        : command.startsWith('pm install-write')
          ? 'Success'
          : command.startsWith('pm install-commit')
            ? 'Failure [INSTALL_FAILED_MISSING_SPLIT]'
            : ''
      return {
        stdout: stream(command === 'screencap -p' ? png : encoder.encode(output)),
        stderr: stream(new Uint8Array()),
        exited: Promise.resolve(0),
        kill: async () => {},
      }
    }
    const path = '/src/services/workbench.ts'
    const { screenshot, operate, installAPKSet } = await import(path)
    const blob = await screenshot(connection.serial, new AbortController().signal)
    await operate(connection.serial, 'app-stop', 'com.example.photos')
    let failure = ''
    try {
      await installAPKSet(
        connection.serial,
        [new File(['one'], 'base.apk'), new File(['two'], 'split.apk')],
        { downgrade: true, test: true },
        () => {},
      )
    } catch (error) {
      failure = String(error)
    }
    return { bytes: [...new Uint8Array(await blob.arrayBuffer())], commands, failure }
  })
  expect(result.bytes).toEqual([137, 80, 78, 71, 13, 10, 26, 10, 0, 255])
  expect(
    result.commands.some(
      (c) => c.includes('am force-stop --user') && c.includes("'com.example.photos'"),
    ),
  ).toBe(true)
  expect(result.commands).toContain('pm install-create -r -d -t')
  expect(result.commands).toContain('pm install-abandon 42')
  expect(result.commands.some((c) => c.startsWith('rm -rf --'))).toBe(true)
  expect(result.failure).toContain('INSTALL_FAILED_MISSING_SPLIT')
  expect(requests).toEqual([])
})

test('WebUSB control center reads state and sends actions only over USB', async ({ page }) => {
  const requests = await usbPage(page)
  const commandCount = (command: string) =>
    page.evaluate(
      (expected) =>
        (window as any).__usb.commands.filter((value: string) => value === expected).length,
      command,
    )

  const launcher = page.getByRole('button', { name: '控制中心', exact: true })
  const panel = page.getByRole('dialog', { name: '控制中心', exact: true })
  const turnOff = panel.getByRole('button', { name: '熄灭屏幕', exact: true })
  await launcher.click()
  await expect(turnOff).toBeDisabled()
  for (const [label, keycode] of [
    ['锁屏', 223],
    ['唤醒屏幕', 224],
  ] as const) {
    await panel.getByRole('button', { name: label, exact: true }).click()
    await expect.poll(() => commandCount(`input keyevent ${keycode}`)).toBe(1)
  }

  const wifi = panel.getByRole('switch', { name: 'Wi-Fi', exact: true })
  const brightness = panel.getByRole('slider', { name: '屏幕亮度', exact: true })
  const volume = panel.getByRole('group', { name: '媒体音量', exact: true })
  const volumeLevel = (level: number) => volume.getByText(new RegExp(`^${level}\\s*/\\s*15$`))
  const autoBrightness = panel.getByRole('button', { name: '自动亮度', exact: true })
  await expect(wifi).toBeChecked()
  await expect(wifi).toContainText('未连接')
  await expect(brightness).toHaveAttribute('aria-valuenow', '88')
  await expect(autoBrightness).toHaveAttribute('aria-pressed', 'false')
  await expect(volumeLevel(5)).toBeVisible()

  await wifi.click()
  const confirmation = page.getByRole('dialog', { name: '关闭 Wi-Fi', exact: true })
  await expect(confirmation).toBeVisible()
  expect(await commandCount("svc wifi 'disable'")).toBe(0)
  await confirmation.getByRole('button', { name: '确认操作', exact: true }).click()
  await expect(wifi).not.toBeChecked()
  await expect(wifi).toContainText('已关闭')
  expect(await commandCount("svc wifi 'disable'")).toBe(1)

  await brightness.press('End')
  const displayWrites = () =>
    page.evaluate(() =>
      (window as any).__usb.commands.filter((command: string) =>
        command.includes('cmd display set-brightness'),
      ),
    )
  await expect
    .poll(displayWrites)
    .toEqual([
      'b=$(awk -v level=\'1000000\' \'BEGIN { printf "%.6f", level / 1000000 }\') && settings put --user current system screen_brightness_mode 0 && cmd display set-brightness "$b"',
    ])
  await expect(panel.getByRole('status')).toHaveText('已执行：设置亮度')
  await autoBrightness.click()
  await expect
    .poll(() => commandCount('settings put --user current system screen_brightness_mode 1'))
    .toBe(1)
  await expect(autoBrightness).toHaveAttribute('aria-pressed', 'true')

  for (const [label, keycode, level] of [
    ['调高音量', 24, 6],
    ['调低音量', 25, 5],
  ] as const) {
    await volume.getByRole('button', { name: label, exact: true }).click()
    await expect.poll(() => commandCount(`input keyevent ${keycode}`)).toBe(1)
    await expect(volumeLevel(level)).toBeVisible()
  }

  await expect(panel).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()

  await page.getByRole('button', { name: '镜像屏幕', exact: true }).click()
  const cast = page.locator('.mirror-window')
  await expect(cast.getByRole('button', { name: '更多操作' })).toBeEnabled()
  await launcher.click()
  await expect(turnOff).toBeEnabled()
  await turnOff.click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__usb.writes.filter(
            (message: number[]) => message[0] === 10 && message[1] === 0,
          ).length,
      ),
    )
    .toBe(1)
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(cast).toBeVisible()
  expect(requests).toEqual([])
})

test('losing the WebUSB device closes the control center without dispatching a pending reboot', async ({
  page,
}) => {
  const requests = await usbPage(page)
  await page.evaluate(() => {
    const state = (window as any).__usb
    const connection = (window as any).__connection
    connection.adb.power = { reboot: async () => state.commands.push('reboot') }
  })
  const launcher = page.getByRole('button', { name: '控制中心', exact: true })
  await launcher.click()
  const panel = page.getByRole('dialog', { name: '控制中心', exact: true })
  await panel.getByRole('button', { name: '更多控制', exact: true }).click()
  await panel.getByRole('button', { name: '重启设备', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '重启设备', exact: true })
  await expect(confirmation).toBeVisible()

  await page.evaluate(() => (window as any).__usb.disconnect())
  await expect(confirmation).toBeHidden()
  await expect(panel).toBeHidden()
  await expect(launcher).toBeDisabled()
  expect(await page.evaluate(() => (window as any).__usb.commands)).not.toContain('reboot')
  expect(requests).toEqual([])
})

test('WebUSB developer tools use device shell and PTY without Go requests', async ({ page }) => {
  const requests = await usbPage(page)
  await page.evaluate(() => {
    const connection = (window as any).__connection
    const state = { samples: 0, inputs: [] as string[], sizes: [] as number[][], killed: 0 }
    ;(window as any).__developer = state
    const encoder = new TextEncoder()
    connection.adb.subprocess.shellProtocol.spawn = async () => {
      const n = ++state.samples
      const text = `__UPTIME__\n${n} 0\n__CPU__\ncpu ${n * 10} 0 0 ${n * 30}\n__MEMORY__\nMemTotal: 1000 kB\nMemAvailable: 500 kB\n__NETWORK__\nwlan0: ${n * 1024} 0 0 0 0 0 0 0 ${n * 2048} 0 0 0 0 0 0 0\n__END__`
      const stream = (value: string) =>
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(value))
            c.close()
          },
        })
      return {
        stdout: stream(text),
        stderr: stream(''),
        exited: Promise.resolve(0),
        kill: async () => {},
      }
    }
    connection.adb.subprocess.shellProtocol.pty = async () => {
      let output!: ReadableStreamDefaultController<Uint8Array>
      let exit!: (code: number) => void
      return {
        input: new WritableStream({
          write(data: Uint8Array) {
            state.inputs.push(new TextDecoder().decode(data))
            output.enqueue(data)
          },
        }),
        output: new ReadableStream({
          start(c) {
            output = c
            c.enqueue(encoder.encode('USB shell ready\r\n'))
          },
        }),
        exited: new Promise<number>((r) => {
          exit = r
        }),
        resize: async (rows: number, cols: number) => {
          state.sizes.push([rows, cols])
        },
        kill: async () => {
          state.killed++
          output.close()
          exit(0)
        },
      }
    }
  })
  await page.getByRole('button', { name: '性能监控', exact: true }).click()
  await expect(page.getByTestId('metric-cpu')).toHaveText('25.0%')
  await expect(page.getByTestId('metric-tx')).toHaveText('2.0 KB/s')
  await page.getByRole('button', { name: '关闭性能监控小组件', exact: true }).click()
  await page.getByRole('button', { name: '终端', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已连接')
  await page.keyboard.type('pwd')
  await page.keyboard.press('Enter')
  await expect
    .poll(() => page.evaluate(() => (window as any).__developer.inputs.join('')))
    .toContain('pwd\r')
  await page.setViewportSize({ width: 650, height: 700 })
  await expect
    .poll(() => page.evaluate(() => (window as any).__developer.sizes.length))
    .toBeGreaterThan(1)
  await page.getByRole('button', { name: '关闭终端窗口', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__developer.killed)).toBe(1)
  await page.getByRole('button', { name: '终端', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已连接')
  await page.evaluate(() => (window as any).__usb.disconnect())
  await expect(page.getByTestId('terminal-window')).toBeHidden()
  await expect.poll(() => page.evaluate(() => (window as any).__developer.killed)).toBe(2)
  expect(requests).toEqual([])
})

test('WebUSB app layout recovery cold-starts only after confirmation without Go requests', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.VideoDecoder = class {
      state = 'unconfigured'
      constructor(private hooks: VideoDecoderInit) {}
      configure() {
        this.state = 'configured'
        queueMicrotask(() => {
          const canvas = document.createElement('canvas')
          canvas.width = 720
          canvas.height = 1600
          this.hooks.output(new VideoFrame(canvas, { timestamp: 0 }))
        })
      }
      close() {
        this.state = 'closed'
      }
    } as unknown as typeof VideoDecoder
  })
  const requests = await usbPage(page)
  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  await page.getByRole('button', { name: '打开 照片', exact: true }).click()
  const app = page.locator('.mirror-window')
  await expect(app.locator('.screen-message')).toHaveCount(0)
  const launches = () =>
    page.evaluate(() =>
      (window as any).__usb.writes
        .filter((message: number[]) => message[0] === 16)
        .map((message: number[]) => new TextDecoder().decode(Uint8Array.from(message.slice(2)))),
    )
  await expect.poll(launches).toEqual(['com.example.photos'])
  await app.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: '重新启动应用', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '重新启动应用', exact: true })
  await expect(dialog).toBeVisible()
  expect(await launches()).toEqual(['com.example.photos'])
  await dialog.getByRole('button', { name: '确认操作', exact: true }).click()
  await expect.poll(launches).toEqual(['com.example.photos', '+com.example.photos'])
  expect(requests).toEqual([])
  expect(await page.evaluate(() => (window as any).__usb.killed)).toBe(0)
})

test('USB-only desktop launches apps, transfers files and closes without Go requests', async ({
  page,
}) => {
  const requests = await usbPage(page)
  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  await page.getByRole('button', { name: '打开 照片', exact: true }).click()
  const mirror = page.locator('.mirror-window')
  await expect(mirror).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__usb.writes.some((v: number[]) => v[0] === 16)),
    )
    .toBe(true)
  await mirror.locator('canvas').focus()
  await page.keyboard.press('a')
  await expect
    .poll(() => page.evaluate(() => (window as any).__usb.writes.some((v: number[]) => v[0] === 1)))
    .toBe(true)

  await page.getByRole('button', { name: '文件管理器', exact: true }).click()
  await expect(page.getByRole('option', { name: '文件 report.txt' })).toBeVisible()
  await page.getByRole('option', { name: '文件 report.txt' }).click()
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载所选文件' }).click()
  const download = await downloadEvent
  expect(download.suggestedFilename()).toBe('report.txt')
  expect(await download.failure()).toBeNull()
  await page
    .getByLabel('选择上传文件')
    .setInputFiles({ name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('USB upload') })
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__usb.uploads.find((u: any) => u.path === '/sdcard/Download/test.txt')
            ?.size,
      ),
    )
    .toBe(10)
  await page.getByRole('option', { name: '文件 photo.png' }).dblclick()
  await expect(page.locator('.viewer-container')).toBeVisible()
  await expect(page.locator('.viewer-canvas img')).toHaveAttribute('src', /^blob:/)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '关闭文件管理器' }).click()

  await page.getByRole('button', { name: '安装应用', exact: true }).click()
  await page.getByLabel('选择 APK 文件').setInputFiles({
    name: 'usb-demo.apk',
    mimeType: 'application/vnd.android.package-archive',
    buffer: Buffer.from('USB APK'),
  })
  await page.getByRole('button', { name: '安装', exact: true }).click()
  await expect(page.getByText('应用安装成功')).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__usb.uploads.find((upload: any) =>
            /\/data\/local\/tmp\/mugi\/install-.+\.apk$/.test(upload.path),
          )?.size,
      ),
    )
    .toBe(7)
  expect(
    await page.evaluate(() => {
      const state = (window as any).__usb
      const path = state.uploads.find((upload: any) =>
        /\/data\/local\/tmp\/mugi\/install-.+\.apk$/.test(upload.path),
      )?.path
      return (
        !!path &&
        state.commands.some((command: string) => command.includes(`pm install -r '${path}'`)) &&
        state.commands.some((command: string) => command.includes(`rm -f -- '${path}'`))
      )
    }),
  ).toBe(true)
  await page.getByRole('button', { name: '完成', exact: true }).click()

  await page.getByRole('button', { name: '关闭 照片 窗口' }).click()
  await expect(mirror).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).__usb.closedSockets)).toBe(3)
  expect(
    await page.evaluate(
      () =>
        (window as any).__usb.uploads.filter((u: any) => u.path.endsWith('scrcpy-server')).length,
    ),
  ).toBe(1)
  expect(requests).toEqual([])
})

test('USB server upload is skipped only when the remote size and hash match', async ({ page }) => {
  const requests = await usbPage(page)
  const result = await page.evaluate(async () => {
    const connection = (window as any).__connection
    const state = (window as any).__usb
    const uploads = () => state.uploads.filter((u: any) => u.path.endsWith('scrcpy-server'))
    await connection.ensureServer()
    const { size, sha } = uploads()[0]
    const original = connection.adb.sync
    const spawn = connection.adb.subprocess.shellProtocol.spawn
    const stream = (text: string) =>
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(text))
          c.close()
        },
      })
    const run = async (lstat: () => Promise<{ size: bigint }>, shaOutput: string) => {
      const before = uploads().length
      connection.serverReady = undefined
      connection.adb.sync = async () => ({ ...(await original()), lstat })
      connection.adb.subprocess.shellProtocol.spawn = async (command: string) =>
        command.startsWith('sha256sum')
          ? {
              stdout: stream(shaOutput),
              stderr: stream(''),
              exited: Promise.resolve(0),
              kill: async () => {},
            }
          : spawn(command)
      try {
        await connection.ensureServer()
      } finally {
        connection.adb.subprocess.shellProtocol.spawn = spawn
        connection.adb.sync = original
      }
      return uploads().length - before
    }
    const wrong = '0'.repeat(64)
    return {
      first: uploads().length,
      sizeMismatch: await run(async () => ({ size: BigInt(size) + 1n }), `${sha}  f`),
      missing: await run(async () => {
        throw new Error('ENOENT')
      }, `${sha}  f`),
      hashMismatch: await run(async () => ({ size: BigInt(size) }), `${wrong}  f`),
      hashMatch: await run(async () => ({ size: BigInt(size) }), `${sha}  f`),
      unverifiable: await run(async () => ({ size: BigInt(size) }), 'sha256sum: not found'),
    }
  })
  expect(result).toEqual({
    first: 1,
    sizeMismatch: 1,
    missing: 1,
    hashMismatch: 1,
    hashMatch: 0,
    unverifiable: 0,
  })
  expect(requests).toEqual([])
})

test('USB session start re-pushes the server when the device lost it', async ({ page }) => {
  const requests = await usbPage(page)
  const result = await page.evaluate(async () => {
    const connection = (window as any).__connection
    const state = (window as any).__usb
    const uploads = () => state.uploads.filter((u: any) => u.path.endsWith('scrcpy-server')).length
    await connection.ensureServer()
    const before = uploads()
    const spawn = connection.adb.subprocess.shellProtocol.spawn
    const stream = (text: string) =>
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(text))
          c.close()
        },
      })
    let launches = 0
    connection.adb.subprocess.shellProtocol.spawn = async (command: string) => {
      if (!command.includes(' scid=')) return spawn(command)
      launches++
      if (launches > 1) return spawn(command)
      return {
        stdout: stream('java.lang.ClassNotFoundException: com.genymobile.scrcpy.Server'),
        stderr: stream(''),
        exited: Promise.resolve(1),
        kill: async () => {},
      }
    }
    const channels = await connection.startSession({ mode: 'mirror' })
    await channels.close()
    return { launches, pushed: uploads() - before }
  })
  expect(result).toEqual({ launches: 2, pushed: 1 })
  expect(requests).toEqual([])
})

test('USB disconnect removes windows and file UI without falling back to system ADB', async ({
  page,
}) => {
  const requests = await usbPage(page)
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).first().click()
  await expect(page.locator('.mirror-window')).toBeVisible()
  await page.getByRole('button', { name: '文件管理器', exact: true }).click()
  await page.evaluate(() => (window as any).__usb.disconnect())
  await expect(page.locator('.mirror-window')).toHaveCount(0)
  await expect(page.getByTestId('file-manager-window')).toBeHidden()
  await expect(page.getByRole('button', { name: '镜像屏幕', exact: true }).first()).toBeDisabled()
  expect(requests).toEqual([])
})

test('USB multiwindow shares one audio stream and cleans up failed startup', async ({ page }) => {
  const requests = await usbPage(page)
  for (const name of ['照片', '设置']) {
    await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
    await page.getByRole('button', { name: `打开 ${name}`, exact: true }).click()
  }
  await expect(page.locator('.mirror-window')).toHaveCount(2)
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__usb.commands.filter((c: string) => c.includes(' scid=')).length,
      ),
    )
    .toBe(2)
  expect(
    await page.evaluate(
      () =>
        (window as any).__usb.commands.filter(
          (c: string) => c.includes(' scid=') && c.includes('audio=true'),
        ).length,
    ),
  ).toBe(1)
  await page.getByRole('button', { name: '切换到 照片 窗口' }).click()
  await page.getByRole('button', { name: '关闭 照片 窗口' }).click()
  await page.getByRole('button', { name: '关闭 设置 窗口' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__usb.closedSockets)).toBe(5)
  await page.evaluate(() => {
    ;(window as any).__usb.failSocket = true
  })
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).first().click()
  await expect(page.locator('.mirror-window')).toBeVisible()
  await expect(page.locator('.mirror-window')).toHaveCount(0, { timeout: 15000 })
  await expect.poll(() => page.evaluate(() => (window as any).__usb.closedSockets)).toBe(6)
  expect(requests).toEqual([])
})

test('USB mirror and app scrcpy commands use the selected cast settings', async ({ page }) => {
  const requests = await usbPage(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('combobox', { name: '镜像最大长边', exact: true }).click()
  await page.getByRole('option', { name: '1080 px', exact: true }).click()
  await settings.getByRole('combobox', { name: '最高帧率', exact: true }).click()
  await page.getByRole('option', { name: '30 fps', exact: true }).click()
  await settings.getByRole('combobox', { name: '视频码率', exact: true }).click()
  await page.getByRole('option', { name: '4 Mbps', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('mugi.cast-settings') ?? 'null')),
    )
    .toEqual({ maxSize: 1080, maxFps: 30, bitRateMbps: 4 })
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toBeHidden()

  const casts = () =>
    page.evaluate(() =>
      ((window as any).__usb.commands as string[])
        .filter((command) => command.includes(' scid='))
        .map((command) => command.split(' ')),
    )
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).click()
  await expect.poll(casts).toHaveLength(1)
  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  await page.getByRole('button', { name: '打开 照片', exact: true }).click()
  await expect.poll(casts).toHaveLength(2)

  const [mirror, app] = await casts()
  expect(mirror).toEqual(
    expect.arrayContaining(['max_size=1080', 'max_fps=30', 'video_bit_rate=4000000']),
  )
  expect(mirror.some((arg) => arg.startsWith('new_display='))).toBe(false)
  expect(app).toEqual(
    expect.arrayContaining([
      'max_fps=30',
      'video_bit_rate=4000000',
      expect.stringMatching(/^new_display=/),
    ]),
  )
  expect(app.some((arg) => arg.startsWith('max_size='))).toBe(false)
  expect(requests).toEqual([])
})

test('USB mirror and app windows can wake, turn off, and lock the device', async ({ page }) => {
  const requests = await usbPage(page)
  const keyCount = (keycode: number) =>
    page.evaluate(
      (key) =>
        (window as any).__usb.writes.filter(
          (message: number[]) => message[0] === 0 && message[5] === key,
        ).length,
      keycode,
    )
  const displayPowerCount = (on: boolean) =>
    page.evaluate(
      (value) =>
        (window as any).__usb.writes.filter(
          (message: number[]) => message[0] === 10 && message[1] === Number(value),
        ).length,
      on,
    )

  await page.getByRole('button', { name: '镜像屏幕', exact: true }).click()
  const mirror = page.locator('.mirror-window').first()
  const mirrorPower = mirror.getByRole('button', { name: '更多操作' })
  await expect(mirrorPower).toBeEnabled()
  await mirrorPower.click()
  await expect(page.getByRole('menuitem', { name: '唤醒屏幕' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '熄灭屏幕', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '锁屏', exact: true })).toBeVisible()
  await page.getByRole('menuitem', { name: '熄灭屏幕', exact: true }).click()
  await expect.poll(() => displayPowerCount(false)).toBe(1)
  expect(await keyCount(223)).toBe(0)
  await mirrorPower.click()
  await page.getByRole('menuitem', { name: '唤醒屏幕' }).click()
  await expect.poll(() => keyCount(224)).toBe(2)
  await mirrorPower.click()
  await page.getByRole('menuitem', { name: '锁屏', exact: true }).click()
  await expect.poll(() => keyCount(223)).toBe(2)

  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  await page.getByRole('button', { name: '打开 照片', exact: true }).click()
  const app = page.locator('.mirror-window').last()
  const appPower = app.getByRole('button', { name: '更多操作' })
  await expect(appPower).toBeEnabled()
  await appPower.click()
  await page.getByRole('menuitem', { name: '熄灭屏幕', exact: true }).click()
  await expect.poll(() => displayPowerCount(false)).toBe(2)
  await appPower.click()
  await page.getByRole('menuitem', { name: '唤醒屏幕' }).click()
  await expect.poll(() => keyCount(224)).toBe(4)
  await appPower.click()
  await page.getByRole('menuitem', { name: '锁屏', exact: true }).click()
  await expect.poll(() => keyCount(223)).toBe(4)
  expect(requests).toEqual([])
})

test('switching from USB to system ADB releases the connection before querying devices', async ({
  page,
}) => {
  await usbPage(page)
  const disconnectedAtQuery: boolean[] = []
  await page.route('**/api/**', async (route) => {
    disconnectedAtQuery.push(
      await page.evaluate(
        () => !(window as any).__connection || (window as any).__connection.closed,
      ),
    )
    await route.fulfill({ json: { devices: [] } })
  })
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).first().click()
  await expect(page.locator('.mirror-window')).toBeVisible()
  await page.locator('.device-trigger').click()
  await page.getByRole('button', { name: 'USB / 已连接', exact: true }).click()
  await expect(page.locator('.mirror-window')).toHaveCount(0)
  await expect.poll(() => disconnectedAtQuery.length).toBeGreaterThan(0)
  expect(disconnectedAtQuery.every(Boolean)).toBe(true)
})

test('USB audio can move between mirror and app windows and be toggled repeatedly', async ({
  page,
}) => {
  const requests = await usbPage(page)
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).click()
  const mirror = page.locator('.mirror-window').first()
  const mirrorMore = mirror.getByRole('button', { name: '更多操作' })
  await mirrorMore.click()
  await expect(page.getByRole('menuitem', { name: '关闭音频转发' })).toBeEnabled()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  await page.getByRole('button', { name: '打开 照片', exact: true }).click()
  const app = page.locator('.mirror-window').last()
  const appMore = app.getByRole('button', { name: '更多操作' })
  await appMore.click()
  await expect(page.getByRole('menuitem', { name: '开启音频转发' })).toBeEnabled()
  await page.getByRole('menuitem', { name: '开启音频转发' }).click()
  await expect(page.getByText('另一窗口已占用音频转发，请先关闭该窗口的音频')).toBeVisible()
  await appMore.click()
  await expect(page.getByRole('menuitem', { name: '开启音频转发' })).toBeEnabled()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '切换到 镜像屏幕 窗口' }).click()
  await mirrorMore.click()
  await page.getByRole('menuitem', { name: '关闭音频转发' }).click()
  await mirrorMore.click()
  await expect(page.getByRole('menuitem', { name: '开启音频转发' })).toBeEnabled()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '切换到 照片 窗口' }).click()
  await appMore.click()
  await page.getByRole('menuitem', { name: '开启音频转发' }).click()
  await appMore.click()
  await expect(page.getByRole('menuitem', { name: '关闭音频转发' })).toBeEnabled()
  await page.getByRole('menuitem', { name: '关闭音频转发' }).click()
  await appMore.click()
  await expect(page.getByRole('menuitem', { name: '开启音频转发' })).toBeEnabled()
  await page.getByRole('menuitem', { name: '开启音频转发' }).click()
  await appMore.click()
  await expect(page.getByRole('menuitem', { name: '关闭音频转发' })).toBeEnabled()
  await page.keyboard.press('Escape')

  const audioFlags = await page.evaluate(() =>
    (window as any).__usb.commands
      .filter((c: string) => c.includes(' scid='))
      .map((c: string) => c.includes('audio=true')),
  )
  expect(audioFlags).toEqual([true, false, false, true, false, true])
  await app.getByRole('button', { name: '关闭 照片 窗口' }).click()
  await mirror.getByRole('button', { name: '关闭 USB Phone 窗口' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__usb.killed)).toBe(6)
  await expect.poll(() => page.evaluate(() => (window as any).__usb.closedSockets)).toBe(15)
  expect(await page.evaluate(() => (window as any).__connection.claimAudio('probe'))).toBe(true)
  expect(requests).toEqual([])
})

test('audio decoder failure keeps capture exclusive until the USB session closes', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'AudioDecoder', { value: undefined })
  })
  await usbPage(page)
  const audioFailure = page.waitForEvent('console', {
    predicate: (message) => message.text().includes('audio unavailable:'),
  })
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).first().click()
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__usb.commands.some(
          (command: string) => command.includes(' scid=') && command.includes('audio=true'),
        ),
      ),
    )
    .toBe(true)
  await audioFailure
  await expect(page.getByLabel('音频已开启')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__connection.claimAudio('probe'))).toBe(false)
  await page.getByRole('button', { name: '关闭 USB Phone 窗口' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__usb.closedSockets)).toBe(3)
  expect(await page.evaluate(() => (window as any).__connection.claimAudio('probe'))).toBe(true)
})

test('closing during pending socket creation releases the late socket and process', async ({
  page,
}) => {
  await usbPage(page)
  await page.evaluate(() => {
    ;(window as any).__usb.holdSocket = true
  })
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).first().click()
  await expect.poll(() => page.evaluate(() => (window as any).__usb.pending.length)).toBe(1)
  await page.getByRole('button', { name: '关闭 USB Phone 窗口' }).click()
  await page.evaluate(() =>
    (window as any).__usb.pending.forEach((resolve: () => void) => resolve()),
  )
  await expect.poll(() => page.evaluate(() => (window as any).__usb.closedSockets)).toBe(1)
  await expect.poll(() => page.evaluate(() => (window as any).__usb.killed)).toBeGreaterThan(0)
})

test('USB disconnect blocks reconnect and mode changes until interface release completes', async ({
  page,
}) => {
  const requests = await usbPage(page)
  await page.evaluate(() => {
    const connection = (window as any).__connection
    const originalClose = connection.adb.close.bind(connection.adb)
    ;(window as any).__closeCalls = 0
    connection.adb.close = async () => {
      ;(window as any).__closeCalls++
      await new Promise<void>((resolve) => {
        ;(window as any).__finishClose = resolve
      })
      await originalClose()
    }
  })
  await page.locator('.device-trigger').click()
  await page.getByRole('button', { name: '断开 WebUSB', exact: true }).click()
  await expect(page.getByRole('button', { name: '选择 USB 设备', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'USB / 已连接', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '释放系统 ADB', exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).__closeCalls)).toBe(1)
  // Multiple cleanup paths must share the same close, never release a later connection.
  const sharedClose = await page.evaluate(() => {
    const connection = (window as any).__connection
    return connection.close() === connection.close()
  })
  expect(sharedClose).toBe(true)
  await page.evaluate(() => (window as any).__finishClose())
  const dialog = page.getByRole('dialog', { name: '你的手机', exact: true })
  await expect(dialog.getByRole('button', { name: '选择 USB 设备', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: 'USB / 已连接', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: '断开 WebUSB', exact: true })).toHaveCount(0)
  await expect(page.locator('.device-trigger')).toContainText('你的手机 · WebUSB')
  expect(await page.evaluate(() => (window as any).__closeCalls)).toBe(1)
  expect(requests).toEqual([])
})

test('USB static entry only probes policy and explains unsupported browsers', async ({ page }) => {
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({ status: 404, body: 'Not found' }),
  )
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'usb', { value: undefined })
  })
  const requests: string[] = []
  page.on('request', (req) => {
    if (req.url().includes('/api/')) requests.push(req.url())
  })
  await page.goto('/?transport=webusb')
  await page.locator('.device-trigger').click()
  await expect(page.getByRole('button', { name: '选择 USB 设备' })).toBeDisabled()
  await expect(page.getByRole('alert')).toContainText('当前浏览器环境不可用')
  expect(requests.map((url) => new URL(url).pathname)).toEqual(['/api/capabilities'])
})
