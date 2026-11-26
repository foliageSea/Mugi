import { test, expect, type Locator, type Page } from '@playwright/test'

const apps = [
  { name: '照片', package: 'com.example.photos', launchable: true },
  { name: '信息', package: 'com.example.messages', launchable: true },
  { name: '地图', package: 'com.example.maps', launchable: true },
  { name: '设置', package: 'com.android.settings', launchable: true },
]
async function backend(
  page: Page,
  { legacyFlex = false, appIcons = false, extraDownloads = [] as string[] } = {},
) {
  type TestFile = { name: string; size: number; isDir: boolean; mtime: number }
  const fileTree: Record<string, TestFile[]> = {
    '/sdcard': [
      { name: 'Download', size: 0, isDir: true, mtime: 1_700_000_000 },
      { name: 'Pictures', size: 0, isDir: true, mtime: 1_700_000_100 },
      { name: 'report.txt', size: 2048, isDir: false, mtime: 1_700_000_200 },
    ],
    '/sdcard/Download': [
      { name: 'Nested', size: 0, isDir: true, mtime: 1_700_000_000 },
      { name: 'report.txt', size: 2048, isDir: false, mtime: 1_700_000_200 },
      ...extraDownloads.map((name) => ({ name, size: 1024, isDir: false, mtime: 1_700_000_300 })),
    ],
    '/sdcard/Download/Nested': [],
    '/sdcard/Pictures': [
      { name: 'photo.jpg', size: 4096, isDir: false, mtime: 1_700_000_300 },
      { name: 'clip.mp4', size: 8192, isDir: false, mtime: 1_700_000_301 },
    ],
  }
  const state = {
    unlocked: true,
    conflict: false,
    starts: [] as { serial: string; opts: Record<string, unknown> }[],
    stops: [] as string[],
    uploads: [] as string[],
    wireless: [] as { path: string; body: unknown }[],
    appReads: 0,
    statusReads: 0,
    fileReads: [] as string[],
    fileMutations: [] as { method: string; body: Record<string, unknown> }[],
    controls: [] as number[][],
    batteryReads: 0,
  }
  await page.routeWebSocket(/\/ws\//, (ws) => {
    if (ws.url().endsWith('/control')) {
      ws.onMessage((data) => state.controls.push([...Buffer.from(data as Buffer)]))
      return
    }
    if (!ws.url().endsWith('/video')) return
    const bytes = Buffer.alloc(81)
    bytes.write('Test Android', 1)
    bytes.write('h264', 65)
    bytes.writeUInt32BE(0x80000000, 69)
    bytes.writeUInt32BE(1080, 73)
    bytes.writeUInt32BE(2400, 77)
    ws.send(bytes)
  })
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname,
      method = route.request().method()
    let data: unknown = {},
      status = 200
    if (path === '/api/capabilities')
      data = { network: 'local', adbAllowed: true, webusbAllowed: true }
    else if (path === '/api/devices')
      data = {
        devices: [
          { serial: 'phone-a', model: 'Pixel_9', state: 'device', width: 1080, height: 2400 },
          { serial: 'phone-b', model: 'Pixel_8', state: 'device', width: 1080, height: 2400 },
        ],
      }
    else if (path.endsWith('/apps')) {
      state.appReads++
      data = {
        apps: appIcons
          ? apps.map((app) => ({ ...app, iconUrl: `${path}/${app.package}/icon` }))
          : apps,
      }
    } else if (path.endsWith('/icon')) {
      if (path.includes('com.example.photos')) {
        return route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xl1sAAAAASUVORK5CYII=',
            'base64',
          ),
        })
      }
      status = 404
    } else if (path.endsWith('/unlock-status')) {
      state.statusReads++
      data = { unlocked: state.unlocked }
    } else if (path.endsWith('/workbench')) {
      const body = route.request().postDataJSON() as { operation: string }
      if (body.operation === 'battery') {
        state.batteryReads++
        data = {
          output: 'AC powered: false\nUSB powered: true\nstatus: 2\nlevel: 76\nscale: 100',
        }
      }
      if (body.operation === 'packages') {
        data = {
          output: '__ALL__\npackage:com.android.settings\n__SYSTEM__\npackage:com.android.settings',
        }
      }
      if (body.operation === 'package-info' || body.operation === 'package-paths') {
        data = { output: '' }
      }
    } else if (path.endsWith('/sessions') && method === 'POST') {
      if (state.conflict) {
        state.conflict = false
        state.unlocked = false
        status = 409
        data = { error: '请先解锁手机' }
      } else {
        const opts = route.request().postDataJSON()
        state.starts.push({ serial: path.split('/')[3], opts })
        data = {
          id: `s-${state.starts.length}`,
          serial: path.split('/')[3],
          opts: legacyFlex ? { ...opts, flex: true } : opts,
          deviceName: 'Test Android',
          videoCodec: 'h264',
          audioCodec: opts.audio ? 'opus' : undefined,
        }
      }
    } else if (path.startsWith('/api/sessions/') && method === 'DELETE')
      state.stops.push(path.split('/').at(-1)!)
    else if (path.endsWith('/files') && method === 'GET') {
      const remotePath = url.searchParams.get('path') || '/sdcard'
      state.fileReads.push(remotePath)
      data = { path: remotePath, files: fileTree[remotePath] || [] }
    } else if (path.endsWith('/files/transfer') && method === 'POST') {
      const body = route.request().postDataJSON() as {
        paths: string[]
        destination: string
        mode: 'copy' | 'move'
      }
      state.fileMutations.push({ method, body })
      for (const source of body.paths) {
        const sourceParent = source.slice(0, source.lastIndexOf('/'))
        const name = source.split('/').at(-1)!
        const item = fileTree[sourceParent]?.find((file) => file.name === name)
        if (!item) continue
        fileTree[body.destination] ||= []
        fileTree[body.destination].push({ ...item })
        if (item.isDir) {
          const destinationRoot = `${body.destination}/${name}`
          for (const [directory, entries] of Object.entries(fileTree)) {
            if (directory === source || directory.startsWith(`${source}/`))
              fileTree[directory.replace(source, destinationRoot)] = entries.map((entry) => ({
                ...entry,
              }))
          }
        }
        if (body.mode === 'move') {
          fileTree[sourceParent] = fileTree[sourceParent].filter((file) => file.name !== name)
          if (item.isDir)
            for (const directory of Object.keys(fileTree))
              if (directory === source || directory.startsWith(`${source}/`))
                delete fileTree[directory]
        }
      }
      data = { ok: true, count: body.paths.length }
    } else if (path.endsWith('/directories') && method === 'POST') {
      const body = route.request().postDataJSON() as { path: string }
      state.fileMutations.push({ method, body })
      const parent = body.path.slice(0, body.path.lastIndexOf('/'))
      const name = body.path.split('/').at(-1)!
      fileTree[parent] ||= []
      fileTree[parent].push({ name, size: 0, isDir: true, mtime: 1_700_000_400 })
      fileTree[body.path] = []
      data = { path: body.path }
    } else if (path.endsWith('/files') && method === 'PATCH') {
      const body = route.request().postDataJSON() as { path: string; name: string }
      state.fileMutations.push({ method, body })
      const parent = body.path.slice(0, body.path.lastIndexOf('/'))
      const oldName = body.path.split('/').at(-1)!
      const item = fileTree[parent]?.find((file) => file.name === oldName)
      if (item) item.name = body.name
      data = { path: `${parent}/${body.name}` }
    } else if (path.endsWith('/files') && method === 'DELETE') {
      const body = route.request().postDataJSON() as { path?: string; paths?: string[] }
      state.fileMutations.push({ method, body })
      const paths = body.paths || (body.path ? [body.path] : [])
      for (const remotePath of paths) {
        const parent = remotePath.slice(0, remotePath.lastIndexOf('/'))
        const name = remotePath.split('/').at(-1)!
        fileTree[parent] = (fileTree[parent] || []).filter((file) => file.name !== name)
        for (const directory of Object.keys(fileTree))
          if (directory === remotePath || directory.startsWith(`${remotePath}/`))
            delete fileTree[directory]
      }
      data = { ok: true, count: paths.length }
    } else if (path.endsWith('/push')) {
      state.uploads.push(path)
      data = { path: '/sdcard/Download/test.txt' }
    } else if (path.endsWith('/install')) {
      state.uploads.push(path)
      data = { output: 'Success' }
    } else if (path.endsWith('/pair') || path.endsWith('/connect')) {
      state.wireless.push({ path, body: route.request().postDataJSON() })
      data = { serial: 'phone-a' }
    } else if (path.endsWith('/pull')) {
      await route.fulfill({
        status: 200,
        contentType: url.searchParams.get('path')?.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4',
        body: Buffer.from('preview fixture'),
      })
      return
    }
    await route.fulfill({ status, json: data })
  })
  await page.goto('/')
  await expect(page.locator('.device-trigger')).toBeVisible()
  return state
}

async function expectArtwork(image: Locator) {
  await expect(image).toBeVisible()
  await expect(image).toHaveAttribute('alt', '')
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0)
}

test('TopBar displays the connected device battery', async ({ page }) => {
  const state = await backend(page)
  const battery = page.getByRole('img', { name: '电量 76% · 充电中' })
  await expect(battery).toContainText('76%')
  await expect(battery).toHaveCSS('font-size', '14px')
  await expect(battery).toHaveCSS('font-weight', '500')
  const batteryLevel = battery.locator('.battery-level')
  await expect(batteryLevel).toHaveAttribute('height', '11.4')
  await expect(batteryLevel).toHaveAttribute('y', '9.6')
  await expect(battery.locator('.battery-charge')).toBeVisible()

  const controlCenter = page.getByRole('button', { name: '控制中心', exact: true })
  for (const icon of [
    battery.locator('svg'),
    controlCenter.locator('svg'),
    page.locator('.device-trigger > svg[data-icon="inline-start"]'),
  ]) {
    await expect(icon).toHaveCSS('width', '16px')
    await expect(icon).toHaveCSS('height', '16px')
  }
  expect(state.batteryReads).toBe(1)
})

async function expectLightSurface(surface: Locator) {
  // Normalize the computed color to RGB without pinning the palette or glass opacity.
  await expect
    .poll(() =>
      surface.evaluate((element) => {
        const ctx = document.createElement('canvas').getContext('2d')!
        ctx.fillStyle = getComputedStyle(element).backgroundColor
        ctx.fillRect(0, 0, 1, 1)
        return Math.min(...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3))
      }),
    )
    .toBeGreaterThan(128)
}

test('TopBar theme shortcut stays in sync with settings and persists', async ({ page }) => {
  await backend(page)
  const topbar = page.locator('.desktop-header')
  const showLight = topbar.getByRole('button', { name: '切换到亮色模式' })
  const showDark = topbar.getByRole('button', { name: '切换到深色模式' })
  const root = page.locator('html')

  await showLight.focus()
  await showLight.press('Enter')
  await expect(root).toHaveCSS('color-scheme', 'light')
  await expect(showDark).toBeFocused()

  await page.reload()
  await expect(showDark).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  const lightMode = settings.getByRole('switch', { name: '亮色模式', exact: true })
  await expect(lightMode).toBeChecked()
  await lightMode.click()
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(showLight).toBeVisible()
  await showLight.click()
  await showDark.click()
  await expect(root).toHaveCSS('color-scheme', 'dark')
})

test('light mode updates portalled dialogs and persists across reloads', async ({ page }) => {
  await backend(page)
  const root = page.locator('html')
  const settingsButton = page.getByRole('button', { name: '设置', exact: true })
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  const lightMode = settings.getByRole('switch', { name: '亮色模式', exact: true })

  await expect(root).not.toHaveClass(/\blight\b/)
  await expect(root).toHaveCSS('color-scheme', 'dark')
  await settingsButton.click()
  await expect(lightMode).not.toBeChecked()
  await lightMode.click()
  await expect(lightMode).toBeChecked()
  await expect(root).toHaveClass(/\blight\b/)
  await expect(root).toHaveCSS('color-scheme', 'light')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mugi.theme'))).toBe('light')
  await expectLightSurface(settings)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toBeHidden()

  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  const launcher = page.getByRole('dialog', { name: '应用启动器', exact: true })
  await expectLightSurface(launcher)
  await launcher.getByRole('button', { name: '文件管理器', exact: true }).click()
  const fileWindow = page.getByTestId('file-manager-window').and(page.locator('.window-frame'))
  await expect(fileWindow).toBeVisible()
  await expectLightSurface(fileWindow)
  await expect(fileWindow).toHaveCSS('border-width', '0px')

  await page.reload()
  await expect(root).toHaveClass(/\blight\b/)
  await expect(root).toHaveCSS('color-scheme', 'light')
  await settingsButton.click()
  await expect(lightMode).toBeChecked()
  await lightMode.click()
  await expect(lightMode).not.toBeChecked()
  await expect(root).not.toHaveClass(/\blight\b/)
  await expect(root).toHaveCSS('color-scheme', 'dark')
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toBeHidden()

  await page.getByRole('button', { name: '镜像屏幕', exact: true }).first().click()
  const mirror = page.locator('.window-frame.mirror-window')
  await expect(mirror).toBeVisible()
  await expect(mirror).toHaveCSS('border-width', '0px')
})

test('terminal background follows the theme all the way to its edges', async ({ page }) => {
  await backend(page)
  await page.getByRole('button', { name: '终端', exact: true }).click()
  const terminal = page.getByLabel('Android 交互式终端')
  const viewport = terminal.locator('.xterm-viewport')
  const screen = terminal.locator('.xterm-scrollable-element')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  const lightMode = settings.getByRole('switch', { name: '亮色模式', exact: true })

  for (const light of [true, false]) {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await lightMode.click()
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    if (light) await expectLightSurface(terminal)
    const background = await terminal.evaluate((element) => getComputedStyle(element).backgroundColor)
    await expect(viewport).toHaveCSS('background-color', background)
    await expect(screen).toHaveCSS('background-color', background)
  }
})

test('launcher follows the design, filters apps and opens with the keyboard', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const state = await backend(page)
  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCSS('backdrop-filter', 'blur(60px) saturate(1.4)')
  await expect(page.getByRole('dialog')).toHaveCSS('background-color', 'rgba(12, 16, 28, 0.32)')
  await expect(page.locator('.desktop-header')).toHaveCSS('height', '44px')
  await expect(page.locator('.desktop-header .search-trigger')).toHaveCount(0)
  await expect(page.locator('.desktop-header')).not.toContainText('搜索应用')
  await expect.poll(async () => (await page.getByRole('dialog').boundingBox())?.y).toBe(61)
  const bounds = await page.getByRole('dialog').boundingBox()
  expect(bounds?.width).toBe(620)
  expect(bounds?.x).toBe(290)
  await page.getByRole('textbox', { name: '搜索 App' }).fill('照片')
  await expect(page.getByRole('button', { name: '打开 照片' })).toBeVisible()
  await expect(page.getByRole('button', { name: '打开 信息' })).toHaveCount(0)
  await page.getByRole('textbox', { name: '搜索 App' }).press('Enter')
  await expect(page.locator('.mirror-window')).toHaveCount(1)
  expect(state.starts).toHaveLength(1)
  expect(state.starts[0].opts.startApp).toBe('com.example.photos')
  expect(state.starts[0].opts).toMatchObject({ width: 720, height: 1600 })
  expect(state.starts[0].opts.flex).toBeFalsy()
  expect(errors).toEqual([])
})

test('launcher shows real Android icons and falls back when extraction fails', async ({ page }) => {
  await backend(page, { appIcons: true })
  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  const photos = page.getByRole('button', { name: '打开 照片', exact: true })
  const messages = page.getByRole('button', { name: '打开 信息', exact: true })
  await expect(photos.locator('img.is-loaded')).toBeVisible()
  await expect(photos.locator('svg')).toHaveCount(0)
  await expect(messages.locator('img')).toHaveCount(0)
  await expect(messages.locator('.android-app-placeholder')).toBeVisible()
})

test('app manager uses the Android placeholder for apps without an icon', async ({ page }) => {
  await backend(page)
  const dock = page.getByRole('navigation', { name: '工作区操作' })
  await dock.getByRole('button', { name: '应用管理', exact: true }).click()
  const row = page.getByRole('button', { name: /com\.android\.settings/ })
  await expect(row.locator('.android-app-placeholder')).toBeVisible()
  await row.click()
  await expect(page.locator('.app-manager-detail .android-app-placeholder')).toBeVisible()
})

for (const width of [1200, 390]) {
  test(`Dock reuses the launcher icon at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await backend(page, { appIcons: true })
    await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
    const photos = page.getByRole('button', { name: '打开 照片', exact: true })
    const launcherIcon = photos.locator('img.is-loaded')
    await expect(launcherIcon).toBeVisible()
    const source = await launcherIcon.getAttribute('src')
    await photos.click()

    const dock = page.getByRole('navigation', { name: '工作区操作' })
    const runningApp = dock.getByRole('button', { name: '切换到 照片 窗口', exact: true })
    const dockIcon = runningApp.locator('img.is-loaded')
    await expect(dockIcon).toBeVisible()
    await expect(dockIcon).toHaveAttribute('src', source!)
    await expect(runningApp.locator('.app-art svg')).toHaveCount(0)
  })
}

test('app and mirror windows use the same initial size', async ({ page }) => {
  const state = await backend(page)
  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  await page.getByRole('button', { name: '打开 照片', exact: true }).click()
  await expect(page.locator('.mirror-window')).toHaveCount(1)
  const appWindow = page.locator('.mirror-window').first()
  await expect(appWindow).not.toHaveClass(/window-motion-enter-active/)
  const appBounds = await appWindow.boundingBox()

  const dock = page.getByRole('navigation', { name: '工作区操作' })
  const mirrorButton = dock.getByRole('button', { name: '镜像屏幕', exact: true })
  await mirrorButton.click()
  await expect(page.locator('.mirror-window')).toHaveCount(2)
  await expect(page.locator('.mirror-window').last()).not.toHaveClass(/window-motion-enter-active/)
  const mirrorBounds = await page.locator('.mirror-window').last().boundingBox()

  const mirrorDockButton = dock.getByRole('button', { name: '切换到 镜像屏幕 窗口', exact: true })
  const mirrorArtwork = mirrorDockButton.locator('img.dock-art')
  await expectArtwork(mirrorArtwork)
  await expect(mirrorArtwork).toHaveJSProperty(
    'src',
    await mirrorButton.locator('img.dock-art').evaluate((image: HTMLImageElement) => image.src),
  )
  await expect(mirrorDockButton.locator('.app-art')).toHaveCount(0)

  expect(state.starts[1].opts).toMatchObject({ mode: 'mirror', width: 720, height: 1600 })
  expect(mirrorBounds?.width).toBe(appBounds?.width)
  expect(mirrorBounds?.height).toBe(appBounds?.height)
})

test('app layout recovery requires confirmation and stays in the existing fullscreen session', async ({
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
  const state = await backend(page)
  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  await page.getByRole('button', { name: '打开 照片', exact: true }).click()
  const app = page.locator('.mirror-window')
  await expect(app.locator('.screen-message')).toHaveCount(0)
  const launches = () => state.controls.filter((message) => message[0] === 16)
  await expect.poll(() => launches().length).toBe(1)
  expect(Buffer.from(launches()[0].slice(2)).toString()).toBe('com.example.photos')

  await app.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: '重新启动应用', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '重新启动应用', exact: true })
  await expect(dialog).toContainText('未保存的内容可能丢失')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(launches()).toHaveLength(1)

  await app.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: '全屏', exact: true }).click()
  await expect(app).toHaveJSProperty('offsetWidth', 1200)
  await app.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: '重新启动应用', exact: true }).click()
  await expect(app.getByRole('dialog')).toBeVisible()
  await dialog.getByRole('button', { name: '确认操作', exact: true }).click()
  await expect.poll(() => launches().length).toBe(2)
  expect(Buffer.from(launches()[1].slice(2)).toString()).toBe('+com.example.photos')
  expect(state.starts).toHaveLength(1)
  expect(state.stops).toEqual([])
})

test('app window scaling keeps the Android viewport stable after the first frame', async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Deliver a real drawable frame without requiring an Android H.264 fixture.
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
  const state = await backend(page, { legacyFlex: true })
  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  await page.getByRole('button', { name: '打开 照片', exact: true }).click()
  const app = page.locator('.mirror-window')
  await expect(app.locator('.screen-message')).toHaveCount(0)
  await page.waitForTimeout(400)
  expect(state.controls.filter((message) => message[0] === 21)).toEqual([])

  const screen = app.locator('.mirror-screen')
  const before = await screen.boundingBox()
  const handle = app.getByRole('button', { name: '等比调整窗口' })
  await handle.focus()
  await handle.press('Shift+ArrowLeft')
  await page.waitForTimeout(400)
  const after = await screen.boundingBox()
  expect(after!.width).toBeLessThan(before!.width)
  expect(after!.width / after!.height).toBeCloseTo(720 / 1600, 2)
  expect(state.controls.filter((message) => message[0] === 21)).toEqual([])

  await app.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: '关闭音频转发' }).click()
  await expect.poll(() => state.starts.length).toBe(2)
  expect(state.starts[1].opts).toMatchObject({ width: 720, height: 1600, dpi: 280 })
})

test('mirror controls collapse into a bottom-right menu', async ({ page }) => {
  await backend(page)
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).click()
  const toolbar = page.locator('.mirror-toolbar')
  await expect(toolbar.getByRole('button')).toHaveCount(4)
  for (const name of ['返回', '主屏幕', '最近任务', '更多操作'])
    await expect(toolbar.getByRole('button', { name, exact: true })).toBeVisible()
  await expect(page.getByRole('menu')).toHaveCount(0)

  const trigger = toolbar.getByRole('button', { name: '更多操作' })
  const toolbarBounds = await toolbar.boundingBox()
  const triggerBounds = await trigger.boundingBox()
  expect(triggerBounds!.x + triggerBounds!.width).toBeGreaterThan(
    toolbarBounds!.x + toolbarBounds!.width - 40,
  )
  await trigger.click()
  const menu = page.getByRole('menu')
  await expect(menu).toHaveAttribute('data-side', 'top')
  for (const name of [
    '关闭音频转发',
    '保存窗口截图',
    '唤醒屏幕',
    '熄灭屏幕',
    '锁屏',
    '从手机复制',
    '旋转设备',
    '全屏',
  ])
    await expect(menu.getByRole('menuitem', { name, exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '保存窗口截图' })).toBeDisabled()
  await expect(menu.getByRole('menuitem', { name: '从手机复制' })).toBeDisabled()
  await expect(menu.getByRole('menuitem', { name: '旋转设备' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('mirror maximize fills the workspace, centers the canvas, and restores bounds', async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 740 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await backend(page)
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).click()
  const workspace = page.locator('.desktop-workspace')
  const mirror = workspace.locator('.mirror-window')
  const maximize = mirror.getByRole('button', { name: '最大化 Test Android 窗口', exact: true })
  const restore = mirror.getByRole('button', { name: '还原 Test Android 窗口', exact: true })
  await expect(maximize).toBeVisible()
  await expect(mirror).not.toHaveClass(/window-motion-enter-active/)
  const initial = (await mirror.boundingBox())!
  const bounds = (await workspace.boundingBox())!
  const dock = (await page.locator('.desktop-actions').boundingBox())!
  expect(initial.width).toBeLessThan(bounds.width)

  await maximize.click()
  await expect(restore).toBeVisible()
  await expect.poll(async () => {
    const box = (await mirror.boundingBox())!
    return box.x + box.width
  }).toBe(bounds.x + bounds.width)
  const area = (await mirror.boundingBox())!
  expect(area.x).toBeGreaterThan(dock.x + dock.width)
  expect(area.y).toBe(bounds.y)
  expect(area.height).toBe(bounds.height)
  expect(area.y + area.height).toBe(page.viewportSize()!.height)
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()

  const canvas = (await mirror.locator('canvas').boundingBox())!
  const titlebar = (await mirror.locator('.mirror-titlebar').boundingBox())!
  const toolbar = (await mirror.locator('.mirror-toolbar').boundingBox())!
  const contentTop = titlebar.y + titlebar.height
  const contentHeight = toolbar.y - contentTop
  expect(canvas.width / canvas.height).toBeCloseTo(1080 / 2400, 2)
  expect(canvas.height).toBeCloseTo(contentHeight, 0)
  expect(canvas.x + canvas.width / 2).toBeCloseTo(area.x + area.width / 2, 0)
  expect(canvas.y + canvas.height / 2).toBeCloseTo(contentTop + contentHeight / 2, 0)

  await restore.click()
  await expect(maximize).toBeVisible()
  await expect.poll(() => mirror.boundingBox()).toEqual(initial)
})

test('maximized mirror reflows when Dock position changes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await backend(page)
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).click()
  const mirror = page.locator('.mirror-window')
  await mirror.getByRole('button', { name: '最大化 Test Android 窗口', exact: true }).click()
  const workspace = page.locator('.desktop-workspace')
  const dock = page.locator('.desktop-actions')
  const settings = page.getByRole('button', { name: '设置', exact: true })
  for (const [label, edge] of [['右侧', 'right'], ['底部', 'bottom']] as const) {
    await settings.click()
    await page.getByRole('combobox', { name: 'Dock 位置' }).click()
    await page.getByRole('option', { name: label, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置', exact: true })
    await expect(dialog.getByRole('combobox', { name: 'Dock 位置' })).toHaveText(label)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(dock).toHaveAttribute('data-position', edge)
    const area = (await workspace.boundingBox())!
    if (edge === 'right') {
      await expect.poll(async () => (await mirror.boundingBox())!.x).toBe(area.x)
      const box = (await mirror.boundingBox())!
      expect(box.x + box.width).toBeLessThan((await dock.boundingBox())!.x)
      expect(box.y + box.height).toBe(page.viewportSize()!.height)
    } else {
      await expect.poll(() => mirror.boundingBox()).toEqual(area)
      expect(area.y + area.height).toBeLessThan((await dock.boundingBox())!.y)
    }
  }
})

test('mirror canvas follows the decoded frame aspect ratio instead of portrait metadata', async ({
  page,
}) => {
  const frameSize = { width: 800, height: 450 }
  await page.addInitScript(({ width, height }) => {
    window.VideoDecoder = class {
      state = 'unconfigured'
      constructor(private hooks: VideoDecoderInit) {}
      configure() {
        this.state = 'configured'
        queueMicrotask(() => {
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          this.hooks.output(new VideoFrame(canvas, { timestamp: 0 }))
        })
      }
      close() {
        this.state = 'closed'
      }
    } as unknown as typeof VideoDecoder
  }, frameSize)
  await page.setViewportSize({ width: 1200, height: 780 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await backend(page) // Advertises a 1080 × 2400 portrait video stream.
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).click()
  const mirror = page.locator('.mirror-window')
  const canvas = mirror.locator('canvas')
  const maximize = mirror.getByRole('button', { name: '最大化 Test Android 窗口', exact: true })
  const restore = mirror.getByRole('button', { name: '还原 Test Android 窗口', exact: true })
  await expect(canvas).toHaveJSProperty('width', frameSize.width)
  await expect(canvas).toHaveJSProperty('height', frameSize.height)

  const expectDecodedRatio = async () => {
    await expect
      .poll(async () => {
        const bounds = await canvas.boundingBox()
        return bounds ? bounds.width / bounds.height : 0
      })
      .toBeCloseTo(frameSize.width / frameSize.height, 2)
  }

  for (const width of [1200, 760]) {
    await test.step(`normal and maximized at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 780 })
      await expect(maximize).toBeVisible()
      await expectDecodedRatio()
      await maximize.click()
      await expect(restore).toBeVisible()
      await expectDecodedRatio()
      await restore.click()
    })
  }
})

test('collapsed controls remain usable in fullscreen and after exiting', async ({ page }) => {
  const state = await backend(page)
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).click()
  const mirror = page.locator('.mirror-window')
  const more = mirror.getByRole('button', { name: '更多操作' })
  await more.click()
  await page.getByRole('menuitem', { name: '全屏', exact: true }).click()
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)

  await more.click()
  await expect(mirror.getByRole('menu')).toBeVisible()
  await mirror.getByRole('menuitem', { name: '熄灭屏幕', exact: true }).click()
  await expect
    .poll(() => state.controls.filter((message) => message[0] === 10 && message[1] === 0).length)
    .toBe(1)
  await more.click()
  await mirror.getByRole('menuitem', { name: '全屏', exact: true }).click()
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)

  await more.click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.getByRole('menuitem', { name: '唤醒屏幕' }).click()
  await expect
    .poll(() => state.controls.filter((message) => message[0] === 0 && message[5] === 224).length)
    .toBe(2)
})

test('mirror and app windows can wake, turn off, and lock the device', async ({ page }) => {
  const state = await backend(page)
  const keycode = (message: number[]) =>
    message[0] === 0
      ? message[2]! * 0x1000000 + message[3]! * 0x10000 + message[4]! * 0x100 + message[5]!
      : -1
  const displayPower = (on: boolean) =>
    state.controls.filter((message) => message[0] === 10 && message[1] === Number(on)).length

  await page.getByRole('button', { name: '镜像屏幕', exact: true }).click()
  const mirror = page.locator('.mirror-window').first()
  const mirrorPower = mirror.getByRole('button', { name: '更多操作' })
  await expect(mirrorPower).toBeEnabled()
  await mirrorPower.click()
  await expect(page.getByRole('menuitem', { name: '唤醒屏幕' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '熄灭屏幕', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '锁屏', exact: true })).toBeVisible()
  await page.getByRole('menuitem', { name: '熄灭屏幕', exact: true }).click()
  await expect.poll(() => displayPower(false)).toBe(1)
  expect(state.controls.filter((m) => keycode(m) === 223)).toHaveLength(0)
  await mirrorPower.click()
  await page.getByRole('menuitem', { name: '唤醒屏幕' }).click()
  await expect.poll(() => state.controls.filter((m) => keycode(m) === 224).length).toBe(2)
  await mirrorPower.click()
  await page.getByRole('menuitem', { name: '锁屏', exact: true }).click()
  await expect.poll(() => state.controls.filter((m) => keycode(m) === 223).length).toBe(2)

  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  await page.getByRole('button', { name: '打开 照片', exact: true }).click()
  const app = page.getByRole('article', { name: '照片 投屏窗口' })
  const appPower = app.getByRole('button', { name: '更多操作' })
  await expect(appPower).toBeEnabled()
  await appPower.click()
  await page.getByRole('menuitem', { name: '熄灭屏幕', exact: true }).click()
  await expect.poll(() => displayPower(false)).toBe(2)
  await appPower.click()
  await page.getByRole('menuitem', { name: '唤醒屏幕' }).click()
  await expect.poll(() => state.controls.filter((m) => keycode(m) === 224).length).toBe(4)
  await appPower.click()
  await page.getByRole('menuitem', { name: '锁屏', exact: true }).click()
  await expect.poll(() => state.controls.filter((m) => keycode(m) === 223).length).toBe(4)
})

test('control center only turns off the screen of the currently selected cast device', async ({
  page,
}) => {
  const state = await backend(page)
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).click()
  const cast = page.locator('.mirror-window')
  await expect(cast.getByRole('button', { name: '更多操作' })).toBeEnabled()
  const launcher = page.getByRole('button', { name: '控制中心', exact: true })
  const panel = page.getByRole('dialog', { name: '控制中心', exact: true })
  const turnOff = panel.getByRole('button', { name: '熄灭屏幕', exact: true })
  const screenOffPackets = () =>
    state.controls.filter((message) => message[0] === 10 && message[1] === 0)
  await launcher.click()
  await expect(turnOff).toBeEnabled()
  await turnOff.click()
  await expect.poll(() => screenOffPackets().length).toBe(1)
  await expect(panel).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(page.locator('.control-center-dialog')).toHaveCount(0)
  await expect(cast).toBeVisible()
  expect(state.stops).toEqual([])

  const device = page.locator('.device-trigger')
  await device.click()
  const picker = page.getByRole('dialog', { name: '你的手机', exact: true })
  await picker.getByRole('button', { name: '使用', exact: true }).click()
  await expect(device).toContainText('Pixel 8')
  await expect(cast).toBeVisible()
  await launcher.click()
  await expect(turnOff).toBeDisabled()
  expect(screenOffPackets()).toHaveLength(1)
  expect(state.stops).toEqual([])
})

test('a delayed device switch discards an open control center confirmation', async ({ page }) => {
  await backend(page)
  const device = page.locator('.device-trigger')
  await device.click()
  const picker = page.getByRole('dialog', { name: '你的手机', exact: true })
  await expect(picker.getByRole('button', { name: '重新扫描', exact: true })).toBeEnabled()
  const nextDeviceList = Promise.withResolvers<void>()
  await page.route('**/api/devices', async (route) => {
    await nextDeviceList.promise
    await route.fallback()
  })
  const actions: { serial: string; operation: string }[] = []
  await page.route('**/api/devices/*/workbench', async (route) => {
    const serial = new URL(route.request().url()).pathname.split('/')[3]!
    const { operation } = route.request().postDataJSON()
    actions.push({ serial, operation })
    if (operation === 'battery') await route.fallback()
    else await route.fulfill({ json: { output: '' } })
  })

  const launcher = page.getByRole('button', { name: '控制中心', exact: true })
  const panel = page.getByRole('dialog', { name: '控制中心', exact: true })
  const confirmation = page.getByRole('dialog', { name: '重启设备', exact: true })
  try {
    await picker.getByRole('button', { name: '使用', exact: true }).click()
    await expect(picker).toBeHidden()
    await expect(device).toContainText('Pixel 9')
    await launcher.click()
    await panel.getByRole('button', { name: '更多控制', exact: true }).click()
    await panel.getByRole('button', { name: '重启设备', exact: true }).click()
    await expect(confirmation).toBeVisible()
  } finally {
    nextDeviceList.resolve()
  }
  await expect(device).toContainText('Pixel 8')
  await expect(confirmation).toBeHidden()
  await expect(panel).toBeHidden()
  await launcher.click()
  await panel.getByRole('button', { name: '主屏幕', exact: true }).click()
  await expect
    .poll(() => actions.filter(({ operation }) => ['home', 'reboot'].includes(operation)))
    .toEqual([{ serial: 'phone-b', operation: 'home' }])
})

test('auto screen-off is a global, persisted casting preference', async ({ page }) => {
  await backend(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '设置' })).toBeVisible()
  const toggle = dialog.getByRole('switch', { name: '自动息屏' })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('mugi.screen-off')))
    .toBe('0')
  await page.reload()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(dialog.getByRole('switch', { name: '自动息屏' })).toHaveAttribute(
    'aria-checked',
    'false',
  )
})

test('default audio forwarding persists and applies to new mirror and app sessions', async ({
  page,
}) => {
  const state = await backend(page)
  const settingsButton = page.getByRole('button', { name: '设置', exact: true })
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  const defaultAudio = settings.getByRole('switch', { name: '默认转发设备音频', exact: true })

  await settingsButton.click()
  await expect(defaultAudio).toHaveAttribute('aria-checked', 'true')
  await defaultAudio.click()
  await expect(defaultAudio).toHaveAttribute('aria-checked', 'false')
  await page.reload()
  await settingsButton.click()
  await expect(defaultAudio).toHaveAttribute('aria-checked', 'false')
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toBeHidden()

  await page.getByRole('button', { name: '镜像屏幕', exact: true }).click()
  const windows = page.locator('.mirror-window')
  await expect(windows).toHaveCount(1)
  expect(state.starts[0].opts).toMatchObject({ mode: 'mirror', audio: false })

  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  await page.getByRole('button', { name: '打开 照片', exact: true }).click()
  await expect(windows).toHaveCount(2)
  expect(state.starts[1].opts).toMatchObject({
    mode: 'display',
    startApp: 'com.example.photos',
    audio: false,
  })
})

function castingSettings(page: Page) {
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  return {
    open: page.getByRole('button', { name: '设置', exact: true }),
    close: dialog.getByRole('button', { name: '关闭', exact: true }),
    reset: dialog.getByRole('button', { name: '恢复默认', exact: true }),
    maxSize: dialog.getByRole('combobox', { name: '镜像最大长边', exact: true }),
    maxFps: dialog.getByRole('combobox', { name: '最高帧率', exact: true }),
    bitRate: dialog.getByRole('combobox', { name: '视频码率', exact: true }),
    async choose(trigger: Locator, name: string) {
      await trigger.click()
      await page.getByRole('option', { name, exact: true }).click()
    },
    dialog,
  }
}

test('casting parameters persist across reload and apply to new ADB sessions', async ({ page }) => {
  const state = await backend(page)
  const settings = castingSettings(page)
  await settings.open.click()
  await expect(settings.dialog.getByRole('heading', { name: '投屏参数', exact: true })).toBeVisible()
  await settings.choose(settings.maxSize, '1080 px')
  await settings.choose(settings.maxFps, '60 fps')
  await settings.choose(settings.bitRate, '12 Mbps')

  await page.reload()
  await settings.open.click()
  await expect(settings.maxSize).toHaveText('1080 px')
  await expect(settings.maxFps).toHaveText('60 fps')
  await expect(settings.bitRate).toHaveText('12 Mbps')
  await settings.close.click()
  await expect(settings.dialog).toBeHidden()

  await page.getByRole('button', { name: '镜像屏幕', exact: true }).click()
  const windows = page.locator('.mirror-window')
  await expect(windows).toHaveCount(1)
  expect(state.starts[0].opts).toMatchObject({
    mode: 'mirror',
    width: 720,
    height: 1600,
    maxSize: 1080,
    maxFps: 60,
    bitRate: 12_000_000,
  })

  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  await page.getByRole('button', { name: '打开 照片', exact: true }).click()
  await expect(windows).toHaveCount(2)
  expect(state.starts[1].opts).toMatchObject({
    mode: 'display',
    startApp: 'com.example.photos',
    width: 720,
    height: 1600,
    dpi: 280,
    maxFps: 60,
    bitRate: 12_000_000,
  })
  expect(state.starts[1].opts).not.toHaveProperty('maxSize')
})

test('resetting casting parameters restores persisted ADB defaults', async ({ page }) => {
  const state = await backend(page)
  const settings = castingSettings(page)
  await settings.open.click()
  await settings.choose(settings.maxSize, '720 px')
  await settings.choose(settings.maxFps, '30 fps')
  await settings.choose(settings.bitRate, '4 Mbps')
  await settings.reset.click()
  await expect(settings.maxSize).toHaveText('自动')
  await expect(settings.maxFps).toHaveText('不限')
  await expect(settings.bitRate).toHaveText('8 Mbps')

  await page.reload()
  await settings.open.click()
  await expect(settings.maxSize).toHaveText('自动')
  await expect(settings.maxFps).toHaveText('不限')
  await expect(settings.bitRate).toHaveText('8 Mbps')
  await settings.close.click()
  await expect(settings.dialog).toBeHidden()

  const windows = page.locator('.mirror-window')
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).click()
  await expect(windows).toHaveCount(1)
  // The automatic mode still uses the display-dependent mirror cap.
  const autoMaxSize = await page.evaluate(() => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const target = Math.round(((window.screen?.availHeight || 1080) * dpr) / 16) * 16
    return Math.max(1280, Math.min(2560, target))
  })
  expect(state.starts[0].opts).toMatchObject({
    mode: 'mirror',
    maxSize: autoMaxSize,
    bitRate: 8_000_000,
  })
  expect(state.starts[0].opts).not.toHaveProperty('maxFps')

  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  await page.getByRole('button', { name: '打开 照片', exact: true }).click()
  await expect(windows).toHaveCount(2)
  expect(state.starts[1].opts).toMatchObject({ mode: 'display', bitRate: 8_000_000 })
  expect(state.starts[1].opts).not.toHaveProperty('maxFps')
  expect(state.starts[1].opts).not.toHaveProperty('maxSize')
})

for (const width of [1200, 390]) {
  test(`launcher footer keeps only mirror and files at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await backend(page)
    await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
    const launcher = page.getByRole('dialog', { name: '应用启动器' })
    const actions = launcher.locator('.launcher-footer').getByRole('button')
    await expect(actions).toHaveText(['镜像屏幕', '文件管理器'])
    for (const action of await actions.all()) {
      await expect(action).toBeEnabled()
      await expect(action).toBeInViewport({ ratio: 1 })
    }
    await expect(launcher.getByRole('button', { name: '打开 照片', exact: true })).toBeVisible()
  })
}

for (const mode of ['mirror', 'display']) {
  test(`${mode} audio can be disabled and re-enabled without replacing the desktop window`, async ({
    page,
  }) => {
    const state = await backend(page)
    const settings = castingSettings(page)
    await settings.open.click()
    await settings.choose(settings.maxSize, '1080 px')
    await settings.choose(settings.maxFps, '60 fps')
    await settings.choose(settings.bitRate, '12 Mbps')
    await settings.close.click()
    await expect(settings.dialog).toBeHidden()

    if (mode === 'display') {
      await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
      await page.getByRole('button', { name: '打开 照片', exact: true }).click()
    } else {
      await page.getByRole('button', { name: '镜像屏幕', exact: true }).click()
    }
    const mirror = page.locator('.mirror-window')
    await expect(mirror).toHaveAttribute('data-session-id', 's-1')
    await expect(mirror).not.toHaveClass(/window-motion-enter-active/)
    const bounds = await mirror.boundingBox()
    const id = await mirror.getAttribute('data-window-id')
    await mirror.evaluate((element) => element.setAttribute('data-test-retained', 'true'))
    const initialOptions = state.starts[0].opts
    expect(initialOptions).toMatchObject({
      mode,
      audio: true,
      maxFps: 60,
      bitRate: 12_000_000,
      ...(mode === 'mirror' ? { maxSize: 1080 } : {}),
    })

    await settings.open.click()
    await settings.choose(settings.maxSize, '1440 px')
    await settings.choose(settings.maxFps, '90 fps')
    await settings.choose(settings.bitRate, '16 Mbps')
    await settings.close.click()
    await expect(settings.dialog).toBeHidden()
    await expect(mirror).toHaveAttribute('data-session-id', 's-1')
    await expect(mirror).toHaveAttribute('data-test-retained', 'true')
    expect(await mirror.boundingBox()).toEqual(bounds)

    const more = mirror.getByRole('button', { name: '更多操作' })
    await more.click()
    const turnAudioOff = page.getByRole('menuitem', { name: '关闭音频转发' })
    await expect(turnAudioOff).toBeEnabled()
    expect(state.starts).toHaveLength(1)
    expect(state.stops).toEqual([])
    await turnAudioOff.click()
    await more.click()
    await expect(page.getByRole('menuitem', { name: '开启音频转发' })).toBeEnabled()
    expect(state.starts[1].opts).toEqual({ ...initialOptions, audio: false })
    expect(state.stops).toEqual(['s-1'])
    await page.getByRole('menuitem', { name: '开启音频转发' }).click()
    await more.click()
    await expect(page.getByRole('menuitem', { name: '关闭音频转发' })).toBeEnabled()
    await page.keyboard.press('Escape')
    expect(state.starts[2].opts).toEqual(initialOptions)
    if (mode === 'display') {
      expect(state.starts[2].opts.startApp).toBe('com.example.photos')
      for (const start of state.starts)
        expect(start.opts).toMatchObject({ width: 720, height: 1600, dpi: 280 })
    }
    await expect(mirror).toHaveAttribute('data-window-id', id!)
    await expect(mirror).toHaveAttribute('data-test-retained', 'true')
    await expect(mirror).toHaveAttribute('data-session-id', 's-3')
    expect(await mirror.boundingBox()).toEqual(bounds)
    await mirror.getByRole('button', { name: /^最小化/ }).click()
    await page
      .getByRole('button', { name: `恢复 ${mode === 'display' ? '照片' : '镜像屏幕'} 窗口` })
      .click()
    await expect(mirror).toBeVisible()
    await mirror.getByRole('button', { name: /^关闭 .* 窗口$/ }).click()
    await expect(mirror).toHaveCount(0)
    expect(state.stops).toEqual(['s-1', 's-2', 's-3'])
  })
}

test('closing a window during audio reconnect cleans up a late session', async ({ page }) => {
  const state = await backend(page)
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).click()
  const mirror = page.locator('.mirror-window')
  const more = mirror.getByRole('button', { name: '更多操作' })
  await more.click()
  await expect(page.getByRole('menuitem', { name: '关闭音频转发' })).toBeEnabled()
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let reconnecting = false
  await page.route('**/api/devices/*/sessions', async (route) => {
    reconnecting = true
    await pending
    await route.fallback()
  })
  await page.getByRole('menuitem', { name: '关闭音频转发' }).click()
  await expect.poll(() => reconnecting).toBe(true)
  await more.click()
  await expect(page.getByRole('menuitem', { name: '关闭音频转发' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await mirror.getByRole('button', { name: /^关闭 .* 窗口$/ }).click()
  await expect(mirror).toHaveCount(0)
  release()
  await expect.poll(() => state.stops).toEqual(['s-1', 's-2'])
  await expect(mirror).toHaveCount(0)
})

test('failed audio reconnect reports the error and removes the stopped window', async ({
  page,
}) => {
  const state = await backend(page)
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).click()
  await page.locator('.mirror-window').getByRole('button', { name: '更多操作' }).click()
  await expect(page.getByRole('menuitem', { name: '关闭音频转发' })).toBeEnabled()
  await page.route('**/api/devices/*/sessions', (route) =>
    route.fulfill({ status: 502, json: { error: '设备已断开' } }),
  )
  await page.getByRole('menuitem', { name: '关闭音频转发' }).click()
  await expect(page.getByText('切换音频失败：设备已断开')).toBeVisible()
  await expect(page.locator('.mirror-window')).toHaveCount(0)
  expect(state.stops).toEqual(['s-1'])
})

test('all nine built-in Dock controls show decorative artwork', async ({ page }) => {
  await backend(page)
  const dock = page.getByRole('navigation', { name: '工作区操作' })
  for (const name of [
    '应用启动器',
    '镜像屏幕',
    '文件管理器',
    '安装应用',
    '性能监控',
    '终端',
    '关于设备',
    '应用管理',
    'Logcat',
  ]) {
    await test.step(name, async () => {
      const button = dock.getByRole('button', { name, exact: true })
      if (name === '关于设备') {
        const artwork = button.locator('svg.dock-art')
        await expect(artwork).toBeVisible()
        await expect(artwork).toHaveAttribute('aria-hidden', 'true')
      } else {
        await expectArtwork(button.locator('img.dock-art'))
      }
    })
  }
})

for (const position of ['left', 'right'] as const) {
  test(`${position} Dock magnifies inward without widening and resets after leaving`, async ({ page }) => {
    await page.addInitScript((edge) => localStorage.setItem('mugi.dock-position', edge), position)
    await backend(page)
    const dock = page.locator('.desktop-actions')
    const icon = dock.getByRole('button', { name: '性能监控', exact: true })
    const next = dock.getByRole('button', { name: '终端', exact: true })
    const background = () =>
      dock.evaluate((el) => {
        const style = getComputedStyle(el, '::before')
        return { left: style.left, right: style.right }
      })
    const before = (await icon.boundingBox())!
    const nextBefore = (await next.boundingBox())!
    const dockBefore = (await dock.boundingBox())!
    const backgroundBefore = await background()
    await icon.hover()
    await expect.poll(async () => (await icon.boundingBox())!.width).toBeGreaterThan(before.width * 1.4)
    const enlarged = (await icon.boundingBox())!
    if (position === 'left') expect(enlarged.x).toBeCloseTo(before.x, 0)
    else expect(enlarged.x + enlarged.width).toBeCloseTo(before.x + before.width, 0)
    expect(await dock.boundingBox()).toEqual(dockBefore)
    expect(await background()).toEqual(backgroundBefore)
    await expect.poll(async () => {
      const box = (await next.boundingBox())!
      return box.y + box.height / 2
    }).toBeGreaterThan(nextBefore.y + nextBefore.height / 2)
    await page.mouse.move(400, 80)
    await expect.poll(() => icon.boundingBox()).toEqual(before)
  })
}

test('Dock shows a tooltip on hover and keyboard focus', async ({ page }) => {
  await backend(page)
  const dock = page.getByRole('navigation', { name: '工作区操作' })
  const launcher = dock.getByRole('button', { name: '应用启动器', exact: true })
  const tooltip = page.locator('.dock-tooltip').filter({ hasText: '应用启动器' })
  await expect(tooltip).toHaveCount(0)
  await launcher.hover()
  await expect(tooltip).toBeVisible()
  const bubble = page.locator('.dock-tooltip')
  await expect(bubble).toHaveCSS('background-color', 'rgb(41, 46, 57)')
  await expect(bubble.locator('.dock-tooltip-arrow')).toHaveCSS('fill', 'rgb(41, 46, 57)')
  const box = (await bubble.boundingBox())!
  const icon = (await launcher.boundingBox())!
  expect(box.x).toBeGreaterThan(icon.x + icon.width)
  expect(box.y + box.height / 2).toBeCloseTo(icon.y + icon.height / 2, 0)
  await page.mouse.move(300, 100)
  await expect(tooltip).toHaveCount(0)

  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab')
    if (await launcher.evaluate((button) => button === document.activeElement)) break
  }
  await expect(launcher).toBeFocused()
  await expect(tooltip).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tooltip).toHaveCount(0)
  await expect(launcher).toBeFocused()

  await page.getByRole('button', { name: '切换到亮色模式' }).click()
  await launcher.hover()
  await expect(bubble).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(bubble.locator('.dock-tooltip-arrow')).toHaveCSS('fill', 'rgb(255, 255, 255)')
})

test('Dock performance tooltip keeps the same short label when toggled', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await backend(page)
  const dock = page.getByRole('navigation', { name: '工作区操作' })
  const performance = dock.getByRole('button', { name: '性能监控', exact: true })
  const performanceTooltip = page.locator('.dock-tooltip').filter({ hasText: '性能监控' })
  await performance.hover()
  await expect(performanceTooltip).toBeVisible()
  await performance.click()
  await expect(performance).toHaveAttribute('aria-pressed', 'true')
  await page.mouse.move(300, 100)
  await performance.hover()
  await expect(performanceTooltip).toBeVisible()
})

test('disabled Dock controls still explain their function on hover', async ({ page }) => {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    return route.fulfill({
      json: path === '/api/capabilities' ? { network: 'local', adbAllowed: false } : {},
    })
  })
  await page.goto('/')
  const dock = page.getByRole('navigation', { name: '工作区操作' })
  const mirror = dock.getByRole('button', { name: '镜像屏幕', exact: true })
  await expect(mirror).toBeDisabled()
  await mirror.hover()
  await expect(page.locator('.dock-tooltip').filter({ hasText: '镜像屏幕' })).toBeVisible()
})

test('Android placeholder stays inside its Dock artwork', async ({ page }) => {
  await backend(page)
  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  await page.getByRole('button', { name: '打开 设置', exact: true }).click()
  const dock = page.getByRole('navigation', { name: '工作区操作' })
  const dockButton = dock.getByRole('button', { name: '切换到 设置 窗口', exact: true })
  await expect(dockButton.locator('img.dock-art')).toHaveCount(0)
  const artwork = dockButton.locator('.app-art .generic-art')
  const icon = artwork.locator('.android-app-placeholder')
  await expect(artwork).toBeVisible()
  await expect(icon).toHaveCSS('width', '22px')
  await expect(icon).toHaveCSS('height', '22px')
})

test('desktop removes promotional chrome and caches wallpaper preferences', async ({ page }) => {
  await backend(page)

  await expect(page.getByText('MUGI DESKTOP')).toHaveCount(0)
  await expect(page.getByText('让 Android 来到桌面')).toHaveCount(0)
  await expect(page.locator('.desktop-status')).toHaveCount(0)
  await expect(
    page.getByRole('navigation', { name: '工作区操作' }).getByRole('button', { name: '新窗口' }),
  ).toHaveCount(0)

  await page.getByRole('button', { name: '桌面与壁纸' }).click()
  await expect(page.getByRole('heading', { name: '桌面与壁纸' })).toBeVisible()
  const brightness = page.getByRole('slider', { name: '壁纸亮度' })
  const contrast = page.getByRole('slider', { name: '壁纸对比度' })
  await brightness.press('ArrowLeft')
  await contrast.press('ArrowRight')
  await expect(brightness).toHaveAttribute('aria-valuenow', '99')
  await expect(contrast).toHaveAttribute('aria-valuenow', '101')

  await page.getByLabel('选择壁纸图片').setInputFiles({
    name: 'desktop.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZKx8AAAAASUVORK5CYII=',
      'base64',
    ),
  })
  const wallpaper = page.locator('.desktop-wallpaper')
  await expect(wallpaper).toHaveClass(/custom/)
  await expect(wallpaper).toHaveAttribute('style', /brightness\(99%\) contrast\(101%\)/)
  await page.getByRole('button', { name: '完成', exact: true }).click()

  await page.reload()
  await expect(page.locator('.desktop-wallpaper')).toHaveClass(/custom/)
  await expect(page.locator('.desktop-wallpaper')).toHaveAttribute(
    'style',
    /brightness\(99%\) contrast\(101%\)/,
  )

  await page.getByRole('button', { name: '桌面与壁纸' }).click()
  await page.getByRole('button', { name: '恢复默认' }).click()
  await expect(page.locator('.desktop-wallpaper')).not.toHaveClass(/custom/)
  await expect(page.getByRole('slider', { name: '壁纸亮度' })).toHaveAttribute(
    'aria-valuenow',
    '100',
  )
  await expect(page.getByRole('slider', { name: '壁纸对比度' })).toHaveAttribute(
    'aria-valuenow',
    '100',
  )
})

test('locked devices wait, cancellation never creates a session', async ({ page }) => {
  const state = await backend(page)
  state.unlocked = false
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: '请先解锁手机' })).toBeVisible()
  expect(state.starts).toHaveLength(0)
  await page.getByRole('button', { name: '取消投屏' }).click()
  state.unlocked = true
  await page.waitForTimeout(1300)
  expect(state.starts).toHaveLength(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('unlock automatically starts once and backend relock returns to waiting', async ({ page }) => {
  const state = await backend(page)
  state.conflict = true
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: '请先解锁手机' })).toBeVisible()
  expect(state.starts).toHaveLength(0)
  state.unlocked = true
  await expect(page.locator('.mirror-window')).toHaveCount(1)
  expect(state.starts).toHaveLength(1)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('multiple windows resize proportionally and close independently', async ({ page }) => {
  const state = await backend(page)
  for (const app of ['照片', '信息', '地图']) {
    await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
    await page.getByRole('button', { name: `打开 ${app}`, exact: true }).click()
    await expect.poll(() => state.starts.length).toBe(['照片', '信息', '地图'].indexOf(app) + 1)
  }
  await expect(page.locator('.mirror-window')).toHaveCount(3)
  const positions = await page.locator('.mirror-window').evaluateAll((windows) =>
    windows.map((window) => ({
      left: window.getBoundingClientRect().left,
      top: window.getBoundingClientRect().top,
    })),
  )
  expect(positions[1].left).toBe(positions[0].left)
  expect(positions[1].top).toBe(positions[0].top)
  await page.getByRole('button', { name: '关闭 地图 窗口' }).click()
  await expect(page.locator('.mirror-window')).toHaveCount(2)
  await page.getByRole('button', { name: '关闭 信息 窗口' }).click()
  await expect(page.locator('.mirror-window')).toHaveCount(1)
  expect(state.stops).toEqual(['s-3', 's-2'])
  const screen = page.locator('.mirror-window').last().locator('.mirror-screen')
  await expect
    .poll(async () => {
      const r = await screen.boundingBox()
      return r!.width / r!.height
    })
    .toBeCloseTo(1080 / 2400, 2)
  const handle = page.locator('.mirror-window').last().getByRole('button', { name: '等比调整窗口' })
  const before = await screen.boundingBox()
  await handle.focus()
  await handle.press('ArrowLeft')
  await page.waitForTimeout(100)
  const after = await screen.boundingBox()
  expect(after!.width).toBeLessThan(before!.width)
  expect(after!.width / after!.height).toBeCloseTo(1080 / 2400, 2)
  const grip = await handle.boundingBox()
  await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip!.x + grip!.width / 2 - 40, grip!.y + grip!.height / 2 - 40, {
    steps: 5,
  })
  await page.mouse.up()
  await page.waitForTimeout(100)
  const dragged = await screen.boundingBox()
  expect(dragged!.width).toBeLessThan(after!.width)
  expect(dragged!.width / dragged!.height).toBeCloseTo(1080 / 2400, 2)
})

for (const kind of ['mirror', 'files'] as const) {
  test(`${kind} window tracks dragging beneath the Dock and preserves its geometry`, async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('mugi.dock-position', 'bottom'))
    await backend(page)
    const isMirror = kind === 'mirror'
    await page
      .getByRole('button', { name: isMirror ? '镜像屏幕' : '文件管理器', exact: true })
      .first()
      .click()
    const window = page.locator(isMirror ? '.mirror-window' : '.file-manager-dialog')
    const title = window.locator(isMirror ? '.window-caption' : '.file-manager-toolbar')
    await expect(window).toBeVisible()
    await expect(window).not.toHaveClass(/window-motion-enter-active/)
    if (isMirror) {
      await expect
        .poll(async () => {
          const screen = await window.locator('.mirror-screen').boundingBox()
          return screen!.width / screen!.height
        })
        .toBeCloseTo(1080 / 2400, 2)
    }
    const before = (await window.boundingBox())!
    const bar = (await title.boundingBox())!
    const dock = (await page.locator('.desktop-actions').boundingBox())!
    const dx = dock.x + dock.width / 2 - (before.x + before.width / 2)
    const start = { x: bar.x + bar.width / 2, y: bar.y + (isMirror ? bar.height / 2 : 8) }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + dx, start.y + 150, { steps: 6 })
    await expect.poll(async () => (await window.boundingBox())!.y).toBe(before.y + 150)
    await page.mouse.up()
    const moved = (await window.boundingBox())!
    expect(moved.x).toBeCloseTo(before.x + dx, 1)
    expect(moved.width).toBe(before.width)
    expect(moved.height).toBe(before.height)
    expect(moved.y + moved.height).toBeGreaterThan(dock.y + dock.height / 2)

    // The window actually paints beneath the Dock, which still owns pointer hits.
    const layers = await page.evaluate(
      ({ x, y, selector }) => {
        const elements = document.elementsFromPoint(x, y)
        return {
          dock: elements.findIndex((element) => element.matches('.desktop-actions')),
          window: elements.findIndex((element) => element.matches(selector)),
        }
      },
      {
        x: dock.x + dock.width / 2,
        y: dock.y + dock.height / 2,
        selector: isMirror ? '.mirror-window' : '.file-manager-dialog',
      },
    )
    expect(layers.dock).toBeGreaterThanOrEqual(0)
    expect(layers.window).toBeGreaterThan(layers.dock)
    await page.getByRole('button', { name: '显示桌面', exact: true }).click()
    await expect(window).toBeHidden()
    await page.getByRole('button', { name: '恢复所有窗口', exact: true }).first().click()
    await expect(window).toBeVisible()
    expect(await window.boundingBox()).toEqual(moved)

    // Capture keeps the gesture alive when the pointer crosses the Dock.
    const restoredBar = (await title.boundingBox())!
    const pointer = { x: restoredBar.x + restoredBar.width / 2, y: restoredBar.y + 10 }
    await page.mouse.move(pointer.x, pointer.y)
    await page.mouse.down()
    await page.mouse.move(pointer.x, dock.y + dock.height / 2)
    await expect(window).toHaveClass(/window-manipulating/)
    await page.mouse.move(pointer.x + 100, pointer.y - 40)
    await expect.poll(async () => (await window.boundingBox())!.y).toBe(moved.y - 40)
    expect((await window.boundingBox())!.x).toBeCloseTo(moved.x + 100, 1)
    // Losing browser focus must not leave a stuck drag or global cursor behind.
    await page.evaluate(() => globalThis.dispatchEvent(new Event('blur')))
    const stopped = await window.boundingBox()
    await page.mouse.move(pointer.x + 50, pointer.y - 80)
    await page.mouse.up()
    expect(await window.boundingBox()).toEqual(stopped)
    await expect(window).not.toHaveClass(/window-manipulating/)
    await expect(page.locator('body')).not.toHaveAttribute('data-window-gesture')
  })
}

test('device connection errors stay in their own tab', async ({ page }) => {
  await backend(page)
  await page.route('**/api/adb/release', (route) =>
    route.fulfill({ status: 500, json: { error: 'ADB release failed' } }),
  )
  await page.locator('.device-trigger').click()
  const dialog = page.getByRole('dialog')
  const wirelessError = dialog.getByText('请填写手机 IP、有效端口，以及配对所需的六位配对码。')
  const adbError = dialog.getByText(
    '无法释放：ADB release failed。可在电脑终端运行 adb kill-server。',
  )

  await dialog.getByRole('button', { name: '无线连接' }).click()
  await dialog.getByRole('button', { name: '配对设备', exact: true }).click()
  await expect(wirelessError).toBeVisible()

  await dialog.getByRole('button', { name: 'USB / 已连接', exact: true }).click()
  await expect(wirelessError).toHaveCount(0)
  await dialog.getByRole('button', { name: '释放系统 ADB', exact: true }).click()
  await expect(adbError).toBeVisible()

  await dialog.getByRole('button', { name: 'WebUSB 直连', exact: true }).click()
  await expect(wirelessError).toHaveCount(0)
  await expect(adbError).toHaveCount(0)

  await dialog.getByRole('button', { name: '无线连接' }).click()
  await expect(wirelessError).toBeVisible()
  await expect(adbError).toHaveCount(0)

  await dialog.getByRole('button', { name: 'USB / 已连接', exact: true }).click()
  await expect(adbError).toBeVisible()
  await expect(wirelessError).toHaveCount(0)
})

test('wireless pairing and file manager use the API', async ({ page }) => {
  const state = await backend(page)
  await page.locator('.device-trigger').click()
  await page.getByRole('button', { name: '无线连接', exact: false }).click()
  await page.getByLabel('手机 IP 地址').fill('192.168.1.23')
  await page.getByLabel('配对端口').fill('37001')
  await page.getByLabel('六位配对码').fill('123456')
  await page.getByRole('button', { name: '配对设备' }).click()
  const pairingToast = page.locator('[data-sonner-toast]').filter({
    hasText: '配对成功，请填写连接端口',
  })
  await expect(pairingToast).toBeVisible()
  await expect
    .poll(async () =>
      pairingToast.evaluate((toast) => {
        const rect = toast.getBoundingClientRect()
        return (
          document
            .elementFromPoint(
              rect.left + rect.width / 2,
              Math.min(rect.top + rect.height / 2, window.innerHeight - 8),
            )
            ?.closest('[data-sonner-toast]') === toast
        )
      }),
    )
    .toBe(true)
  await expect.poll(() => state.wireless.length).toBe(1)
  await page.getByLabel('连接端口', { exact: true }).fill('39521')
  await page.getByRole('button', { name: '连接手机', exact: true }).click()
  await expect.poll(() => state.wireless.length).toBe(2)
  expect(state.wireless[0].body).toEqual({ host: '192.168.1.23', port: 37001, code: '123456' })
  expect(state.wireless[1].body).toEqual({ host: '192.168.1.23', port: 39521 })
  await page.getByRole('button', { name: '文件管理器', exact: true }).click()
  await expect(page.getByRole('heading', { name: '文件管理器' })).toBeVisible()
  await page.getByRole('option', { name: '文件 report.txt' }).click()
  await expect(page.getByRole('link', { name: '下载所选文件' })).toHaveAttribute(
    'href',
    /phone-a.*pull.*%2Fsdcard%2FDownload%2Freport.txt/,
  )
  await page
    .getByLabel('选择上传文件')
    .setInputFiles({ name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
  await expect.poll(() => state.uploads.length).toBe(1)
  expect(state.uploads[0]).toBe('/api/devices/phone-a/push')
})

test('app installer validates and installs an APK, then refreshes the launcher', async ({
  page,
}) => {
  const state = await backend(page)
  await expect.poll(() => state.appReads).toBeGreaterThan(0)
  const initialAppReads = state.appReads
  await page.getByRole('button', { name: '安装应用', exact: true }).click()
  await expect(page.getByRole('heading', { name: '安装应用' })).toBeVisible()
  const installer = page.getByTestId('installer-window')
  await expect(installer).toHaveClass(/active/)
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0)
  await page.getByRole('button', { name: '最小化应用安装器', exact: true }).click()
  await expect(installer).toBeHidden()
  await page.getByRole('button', { name: '安装应用', exact: true }).click()
  await expect(installer).toBeVisible()

  const picker = page.getByLabel('选择 APK 文件')
  await picker.setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not an apk'),
  })
  await expect(page.getByRole('alert')).toContainText('请选择扩展名为 .apk')
  await expect(page.getByRole('button', { name: '安装', exact: true })).toBeDisabled()

  await picker.setInputFiles({
    name: 'mugi-demo.apk',
    mimeType: 'application/vnd.android.package-archive',
    buffer: Buffer.from('test apk'),
  })
  await expect(page.getByText('mugi-demo.apk', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '安装', exact: true }).click()
  await expect(page.getByText('应用安装成功')).toBeVisible()
  expect(state.uploads.at(-1)).toBe('/api/devices/phone-a/install')
  await expect.poll(() => state.appReads).toBeGreaterThan(initialAppReads)

  await page.getByRole('button', { name: '完成', exact: true }).click()
  await expect(page.getByRole('heading', { name: '安装应用' })).toHaveCount(0)
})

test('file manager shows image artwork for every file kind in both views', async ({ page }) => {
  const extraKinds = {
    image: 'photo.jpg',
    video: 'clip.mp4',
    audio: 'song.mp3',
    archive: 'backup.zip',
    apk: 'demo.apk',
    file: 'unknown.bin',
  }
  await backend(page, { extraDownloads: Object.values(extraKinds) })
  await page.getByRole('button', { name: '文件管理器', exact: true }).click()
  const kinds = { folder: 'Nested', document: 'report.txt', ...extraKinds }
  const items = page.locator('.file-items')
  for (const [view, width] of [['icons', '54px'], ['list', '25px']]) {
    if (view === 'list') await page.getByRole('button', { name: '列表视图' }).click()
    await expect(items).toHaveAttribute('data-view', view)
    for (const [kind, filename] of Object.entries(kinds)) {
      await test.step(`${view}: ${kind}`, async () => {
        const name = `${kind === 'folder' ? '文件夹' : '文件'} ${filename}`
        const option = items.getByRole('option', { name, exact: true })
        const icon = option.locator(`.file-kind-icon[data-kind="${kind}"] img`)
        await expectArtwork(icon)
        await expect(icon).toHaveCSS('width', width)
      })
    }
  }
})

test('file manager navigates and performs common file operations', async ({ page }) => {
  const state = await backend(page)
  await page.getByRole('button', { name: '文件管理器', exact: true }).click()
  await expect.poll(() => state.fileReads.at(-1)).toBe('/sdcard/Download')
  await expect(page.getByRole('button', { name: '下载', exact: true }).last()).toHaveAttribute(
    'class',
    /active/,
  )
  await expect(page.getByRole('button', { name: '内部存储', exact: true })).toHaveCount(0)
  await expect(page.locator('.file-breadcrumb-root')).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByRole('button', { name: '返回上一级' })).toBeDisabled()

  await page.getByRole('textbox', { name: '搜索当前文件夹' }).fill('report')
  await expect(page.getByRole('option', { name: '文件 report.txt' })).toBeVisible()
  await expect(page.getByRole('option', { name: '文件夹 Nested' })).toHaveCount(0)
  await page.getByRole('textbox', { name: '搜索当前文件夹' }).clear()
  await page.getByRole('button', { name: '列表视图' }).click()
  await expect(page.locator('.file-items')).toHaveAttribute('data-view', 'list')
  await page.getByRole('combobox', { name: '文件排序方式' }).click()
  await page.getByRole('option', { name: '修改日期' }).click()
  await expect(page.getByRole('combobox', { name: '文件排序方式' })).toContainText('修改日期')

  const report = page.getByRole('option', { name: '文件 report.txt' })
  await report.dblclick()
  await expect(page.getByRole('menu', { name: '文件操作' })).toHaveCount(0)
  await report.click({ button: 'right' })
  await expect(page.getByRole('menu', { name: '文件操作' })).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: '下载' }).click()
  expect((await download).suggestedFilename()).toBe('report.txt')

  await page.getByRole('option', { name: '文件夹 Nested' }).dblclick()
  await expect.poll(() => state.fileReads.at(-1)).toBe('/sdcard/Download/Nested')
  await expect(page.getByRole('button', { name: '返回上一级' })).toBeEnabled()
  await page.getByRole('button', { name: '后退' }).click()
  await expect.poll(() => state.fileReads.at(-1)).toBe('/sdcard/Download')
  await page.getByRole('button', { name: '前进' }).click()
  await expect.poll(() => state.fileReads.at(-1)).toBe('/sdcard/Download/Nested')
  await page.getByRole('button', { name: '返回上一级' }).click()
  await expect.poll(() => state.fileReads.at(-1)).toBe('/sdcard/Download')

  await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
  await page.getByLabel('名称').fill('项目资料')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByRole('option', { name: '文件夹 项目资料' })).toBeVisible()
  expect(state.fileMutations.at(-1)).toEqual({
    method: 'POST',
    body: { path: '/sdcard/Download/项目资料' },
  })

  await page.getByRole('option', { name: '文件夹 项目资料' }).click()
  await page.getByRole('button', { name: '重命名所选项目' }).click()
  await page.getByLabel('名称').fill('归档')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('option', { name: '文件夹 归档' })).toBeVisible()

  await page.getByRole('button', { name: '删除所选项目' }).click()
  await expect(page.getByRole('heading', { name: '删除“归档”？' })).toBeVisible()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByRole('option', { name: '文件夹 归档' })).toHaveCount(0)
  expect(state.fileMutations.at(-1)).toEqual({
    method: 'DELETE',
    body: { paths: ['/sdcard/Download/归档'] },
  })
})

test('file manager batches copy, move and delete and exposes file properties', async ({ page }) => {
  const state = await backend(page)
  await page.getByRole('button', { name: '文件管理器', exact: true }).click()

  const nested = page.getByRole('option', { name: '文件夹 Nested' })
  const report = page.getByRole('option', { name: '文件 report.txt' })
  const nestedBounds = (await nested.boundingBox())!
  const reportBounds = (await report.boundingBox())!
  await page.mouse.move(
    Math.min(nestedBounds.x, reportBounds.x) - 4,
    Math.min(nestedBounds.y, reportBounds.y) - 4,
  )
  await page.mouse.down()
  await page.mouse.move(
    Math.max(nestedBounds.x + nestedBounds.width, reportBounds.x + reportBounds.width) + 4,
    Math.max(nestedBounds.y + nestedBounds.height, reportBounds.y + reportBounds.height) + 4,
    { steps: 5 },
  )
  await expect(page.locator('.file-selection-box')).toBeVisible()
  await page.mouse.up()
  await expect(page.locator('.file-selection-box')).toHaveCount(0)
  await expect(page.locator('.file-manager-status')).toContainText('2 个项目已选择')
  await page.getByRole('button', { name: '复制所选项目' }).click()
  await page.getByRole('button', { name: '图片', exact: true }).click()
  await page.locator('.file-browser').click({ button: 'right', position: { x: 520, y: 420 } })
  await expect(page.getByRole('menu', { name: '文件夹操作' })).toBeVisible()
  await page.getByRole('menuitem', { name: '粘贴' }).click()
  await expect(page.getByRole('option', { name: '文件夹 Nested' })).toBeVisible()
  await expect(page.getByRole('option', { name: '文件 report.txt' })).toBeVisible()
  expect(state.fileMutations.at(-1)).toEqual({
    method: 'POST',
    body: {
      paths: ['/sdcard/Download/Nested', '/sdcard/Download/report.txt'],
      destination: '/sdcard/Pictures',
      mode: 'copy',
    },
  })

  const photo = page.getByRole('option', { name: '文件 photo.jpg' })
  const clip = page.getByRole('option', { name: '文件 clip.mp4' })
  await photo.click()
  await clip.click({ modifiers: ['Meta'] })
  await page.getByRole('button', { name: '剪切所选项目' }).click()
  await page.getByRole('button', { name: '下载', exact: true }).click()
  await page.getByRole('button', { name: '粘贴到当前文件夹' }).click()
  await expect(page.getByRole('option', { name: '文件 photo.jpg' })).toBeVisible()
  await expect(page.getByRole('option', { name: '文件 clip.mp4' })).toBeVisible()

  await page.getByRole('button', { name: '删除所选项目（2 个）' }).click()
  await expect(page.getByRole('heading', { name: '删除 2 个项目？' })).toBeVisible()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByRole('option', { name: '文件 photo.jpg' })).toHaveCount(0)
  await expect(page.getByRole('option', { name: '文件 clip.mp4' })).toHaveCount(0)

  await page.locator('.file-browser').click({ button: 'right', position: { x: 520, y: 420 } })
  await page.getByRole('menuitem', { name: '新建文件夹' }).click()
  await page.getByLabel('名称').fill('空白处新建')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByRole('option', { name: '文件夹 空白处新建' })).toBeVisible()

  await report.click({ button: 'right' })
  await page.getByRole('menuitem', { name: '属性' }).click()
  await expect(page.getByRole('heading', { name: 'report.txt' })).toBeVisible()
  await expect(page.getByText('/sdcard/Download/report.txt')).toBeVisible()
  await page.getByRole('button', { name: '复制文件路径' }).click()
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: '文件路径已复制' }),
  ).toBeVisible()
})

test('file manager previews images and videos instead of downloading them', async ({ page }) => {
  await backend(page)
  await page.getByRole('button', { name: '文件管理器', exact: true }).click()
  await page.getByRole('button', { name: '图片', exact: true }).click()

  await page.getByRole('option', { name: '文件 photo.jpg' }).dblclick()
  await expect(page.locator('.viewer-container')).toBeVisible()
  await expect(page.locator('.viewer-container img[alt="photo.jpg"]').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.viewer-container')).toHaveCount(0)

  await page.getByRole('option', { name: '文件 clip.mp4' }).dblclick()
  await expect(page.getByRole('heading', { name: 'clip.mp4' })).toBeVisible()
  await expect(page.getByLabel('预览视频 clip.mp4')).toBeAttached()
  await expect(page.getByRole('link', { name: '下载视频' })).toHaveAttribute(
    'href',
    /phone-a.*pull.*clip.mp4/,
  )
})

test('file manager window can be moved and resized', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await backend(page)
  await page.getByRole('button', { name: '文件管理器', exact: true }).click()
  await expect(page.getByRole('heading', { name: '文件管理器' })).toBeVisible()
  await page.waitForTimeout(250)

  const dialog = page.getByTestId('file-manager-window')
  const initial = await dialog.boundingBox()
  const title = await page.locator('.file-manager-title').boundingBox()
  await page.mouse.move(title!.x + title!.width / 2, title!.y + title!.height / 2)
  await page.mouse.down()
  await page.mouse.move(title!.x + title!.width / 2 + 70, title!.y + title!.height / 2 + 45)
  await page.mouse.up()
  await page.waitForTimeout(250)
  const moved = await dialog.boundingBox()
  expect(moved!.x).toBeGreaterThan(initial!.x + 50)
  expect(moved!.y).toBeGreaterThanOrEqual(initial!.y)

  const handle = page.getByRole('button', { name: '调节文件管理器窗口大小' })
  const grip = await handle.boundingBox()
  await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip!.x + grip!.width / 2 - 90, grip!.y + grip!.height / 2 - 70)
  await page.mouse.up()
  await page.waitForTimeout(250)
  const resized = await dialog.boundingBox()
  expect(resized!.width).toBeLessThan(moved!.width - 70)
  expect(resized!.height).toBeLessThan(moved!.height - 50)

  await handle.focus()
  await handle.press('ArrowRight')
  await handle.press('ArrowDown')
  await page.waitForTimeout(250)
  const keyboardResized = await dialog.boundingBox()
  expect(keyboardResized!.width).toBeGreaterThan(resized!.width)
  expect(keyboardResized!.height).toBeGreaterThan(resized!.height)
})

test('windows animate mounting and remain until the closing transition finishes', async ({
  page,
}) => {
  await backend(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addStyleTag({
    content:
      '.window-motion-enter-active, .window-motion-leave-active { transition-duration: 500ms; }',
  })
  await page.getByRole('button', { name: '文件管理器', exact: true }).click()
  const window = page.getByTestId('file-manager-window')
  await expect(window).toHaveClass(/window-motion-enter-active/)
  await expect(window).not.toHaveClass(/window-motion-enter-active/)
  await page.getByRole('button', { name: '关闭文件管理器', exact: true }).click()
  await expect(window).toHaveClass(/window-motion-leave-active/)
  await expect(window).toHaveCSS('pointer-events', 'none')
  await expect(window).toHaveCount(0)
})

test('file manager window controls close, minimize and toggle maximize', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await backend(page)
  await page.getByRole('button', { name: '文件管理器', exact: true }).click()
  await expect(page.getByRole('heading', { name: '文件管理器' })).toBeVisible()
  await page.waitForTimeout(250)

  await expect(page.getByRole('button', { name: '最小化文件管理器', exact: true })).toBeEnabled()
  const dialog = page.getByTestId('file-manager-window')
  const initial = await dialog.boundingBox()
  await page.getByRole('button', { name: '最大化文件管理器窗口' }).click()
  await page.waitForTimeout(250)
  const maximized = await dialog.boundingBox()
  const workspace = await page.locator('.desktop-workspace').boundingBox()
  const dock = (await page.locator('.desktop-actions').boundingBox())!
  expect(maximized!.x).toBeGreaterThan(dock.x + dock.width)
  expect(maximized!.x + maximized!.width).toBe(workspace!.x + workspace!.width)
  expect(maximized?.y).toBe(workspace!.y)
  expect(maximized?.height).toBe(workspace!.height)
  expect(maximized!.y + maximized!.height).toBe(page.viewportSize()!.height)
  await expect(page.getByRole('button', { name: '调节文件管理器窗口大小' })).toBeHidden()

  await page.getByRole('button', { name: '还原文件管理器窗口' }).click()
  await page.waitForTimeout(250)
  const restored = await dialog.boundingBox()
  expect(restored?.width).toBe(initial?.width)
  expect(restored?.height).toBe(initial?.height)

  await page.getByRole('button', { name: '图片', exact: true }).click()
  await expect(page.getByRole('option', { name: '文件 photo.jpg' })).toBeVisible()
  await page.getByRole('button', { name: '最小化文件管理器', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: '文件管理器', exact: true }).click()
  await expect(page.getByRole('option', { name: '文件 photo.jpg' })).toBeVisible()
  await expect(page.getByRole('button', { name: '后退', exact: true })).toBeEnabled()

  await page.getByRole('button', { name: '关闭文件管理器' }).click()
  await expect(page.getByRole('heading', { name: '文件管理器' })).toHaveCount(0)
})

test('Dock restores minimized sessions and Show Desktop preserves every window', async ({
  page,
}) => {
  const state = await backend(page)
  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  await page.getByRole('button', { name: '打开 照片', exact: true }).click()
  const mirror = page.locator('.mirror-window')
  await expect(mirror).toBeVisible()
  const originalCanvas = await mirror.locator('canvas').elementHandle()
  await page.getByRole('button', { name: '最小化 照片 窗口' }).click()
  await expect(mirror).toBeHidden()
  const restore = page.getByRole('button', { name: '恢复 照片 窗口' })
  await expect(restore).toBeFocused()
  expect(state.stops).toEqual([])
  await restore.press('Enter')
  await expect(mirror).toBeVisible()
  await expect(mirror.locator('canvas')).toBeFocused()
  expect(await originalCanvas?.evaluate((canvas) => canvas.isConnected)).toBe(true)
  expect(state.starts).toHaveLength(1)

  await page.getByRole('button', { name: '文件管理器', exact: true }).click()
  await page.getByRole('button', { name: '显示桌面', exact: true }).click()
  await expect(mirror).toBeHidden()
  await expect(page.getByTestId('file-manager-window')).toBeHidden()
  await page.getByRole('button', { name: '恢复所有窗口', exact: true }).first().click()
  await expect(mirror).toBeVisible()
  await expect(page.getByTestId('file-manager-window')).toBeVisible()
  expect(state.stops).toEqual([])
})

test('window zoom restores geometry and keyboard shortcuts work over Finder', async ({ page }) => {
  await backend(page)
  await page.getByRole('button', { name: '打开应用启动器', exact: true }).click()
  await page.getByRole('button', { name: '打开 照片', exact: true }).click()
  const mirror = page.locator('.mirror-window')
  const canvas = mirror.locator('canvas')
  await expect
    .poll(async () => {
      const rect = await canvas.boundingBox()
      return rect!.width / rect!.height
    })
    .toBeCloseTo(1080 / 2400, 2)
  await expect(mirror).not.toHaveClass(/window-motion-enter-active/)
  const before = await mirror.boundingBox()
  await mirror.locator('.window-caption').dblclick()
  await expect(page.getByRole('button', { name: '还原 照片 窗口' })).toBeVisible()
  await expect(page.getByRole('button', { name: '等比调整窗口' })).toBeHidden()
  const zoomed = await canvas.boundingBox()
  expect(zoomed!.width / zoomed!.height).toBeCloseTo(1080 / 2400, 2)
  await page.getByRole('button', { name: '还原 照片 窗口' }).click()
  expect(await mirror.boundingBox()).toEqual(before)

  await page.getByRole('button', { name: '文件管理器', exact: true }).click()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('textbox', { name: '搜索 App', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('file-manager-window')).toBeVisible()
  await page.keyboard.press('Control+Shift+m')
  await expect(page.getByTestId('file-manager-window')).toBeHidden()
  await expect(mirror).toBeVisible()
})

test('file manager shares window stacking without an overlay', async ({ page }) => {
  await backend(page)
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).first().click()
  await expect(page.locator('.mirror-window')).toHaveCount(1)
  await page.getByRole('button', { name: '文件管理器', exact: true }).click()
  await expect(page.getByRole('heading', { name: '文件管理器' })).toBeVisible()
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0)

  const fileWindow = page.getByTestId('file-manager-window')
  const mirrorWindow = page.locator('.mirror-window')
  await expect(fileWindow).toHaveCSS('z-index', '3')
  const resizeHandle = page.getByRole('button', { name: '调节文件管理器窗口大小' })
  await resizeHandle.focus()
  for (let index = 0; index < 12; index++) await resizeHandle.press('Shift+ArrowLeft')
  const fileTitle = await page.locator('.file-manager-title').boundingBox()
  await page.mouse.move(fileTitle!.x + 10, fileTitle!.y + fileTitle!.height / 2)
  await page.mouse.down()
  await page.mouse.move(fileTitle!.x + 460, fileTitle!.y + fileTitle!.height / 2)
  await page.mouse.up()
  await page.waitForTimeout(250)
  await mirrorWindow.locator('.mirror-toolbar').click({ position: { x: 100, y: 18 } })
  await expect(mirrorWindow).toHaveCSS('z-index', '2')
  await expect(fileWindow).toHaveCSS('z-index', '1')
  await fileWindow.locator('.file-manager-toolbar').click({ position: { x: 400, y: 20 } })
  await expect(fileWindow).toHaveCSS('z-index', '3')
})

test('window manager restores focus across window types and unregisters closed windows', async ({
  page,
}) => {
  const state = await backend(page)
  const showDesktop = page.getByRole('button', { name: '显示桌面', exact: true })
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).first().click()
  const mirror = page.locator('.mirror-window')
  await expect(mirror).toBeVisible()
  await page.getByRole('button', { name: '文件管理器', exact: true }).click()
  const files = page.getByTestId('file-manager-window')
  await expect(files).toBeVisible()
  await page.getByRole('button', { name: 'Logcat', exact: true }).click()
  const logcat = page.getByTestId('logcat-window')
  await expect(logcat).toHaveClass(/active/)

  await page.locator('.desktop-actions [data-window-id="s-1"]').click()
  await expect(mirror.locator('canvas')).toBeFocused()
  await page.keyboard.press('Control+Shift+m')
  await expect(mirror).toBeHidden()
  await expect(logcat).toHaveClass(/active/)
  await logcat.getByRole('button', { name: '最小化Logcat窗口', exact: true }).click()
  await expect(files).toHaveClass(/active/)

  await showDesktop.click()
  await expect(page.locator('.window-frame:visible')).toHaveCount(0)
  await page.getByRole('button', { name: '恢复所有窗口', exact: true }).click()
  await expect(page.locator('.window-frame:visible')).toHaveCount(3)
  await expect(files).toBeFocused()
  expect(state.stops).toEqual([])

  await page.keyboard.press('Escape')
  await expect(files).toHaveCount(0)
  await expect(logcat).toBeFocused()
  await logcat.getByRole('button', { name: '关闭Logcat窗口', exact: true }).click()
  await expect(mirror.locator('canvas')).toBeFocused()
  await mirror.getByRole('button', { name: /关闭.*窗口/ }).click()
  await expect(page.locator('.window-frame')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '恢复所有窗口', exact: true })).toBeDisabled()

  await page.getByRole('button', { name: '文件管理器', exact: true }).click()
  await expect(files).toBeVisible()
  await expect(files).toBeFocused()
  await expect(showDesktop).toBeEnabled()
})

test('window file drops target their own device after device selection changes', async ({
  page,
}) => {
  const state = await backend(page)
  await page.getByRole('button', { name: '镜像屏幕', exact: true }).first().click()
  await expect(page.locator('.mirror-window')).toHaveCount(1)
  await page.locator('.device-trigger').click()
  await page.getByRole('button', { name: '使用', exact: true }).click()
  await expect(page.locator('.device-trigger')).toContainText('Pixel 8')
  const data = await page.evaluateHandle(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(['hello'], 'test.txt'))
    return dt
  })
  await page.locator('.mirror-screen').dispatchEvent('drop', { dataTransfer: data })
  await expect.poll(() => state.uploads.length).toBe(1)
  expect(state.uploads[0]).toBe('/api/devices/phone-a/push')
})

test('launcher fits a mobile viewport and Escape returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await backend(page)
  await expect(page.locator('.desktop-header .search-trigger')).toHaveCount(0)
  const trigger = page.getByRole('button', { name: '打开应用启动器', exact: true })
  await trigger.click()
  const bounds = await page.getByRole('dialog').boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.mouse.click(4, 60)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390)
})

test('file manager fits a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await backend(page)
  await page.getByRole('button', { name: '文件管理器', exact: true }).click()
  await expect(page.getByRole('heading', { name: '文件管理器' })).toBeVisible()
  await page.waitForTimeout(250)
  const bounds = await page.getByRole('dialog').boundingBox()
  expect(bounds?.x).toBe(0)
  expect(bounds?.y).toBe(0)
  expect(bounds?.width).toBe(390)
  expect(bounds?.height).toBe(780)
  await expect(page.getByRole('button', { name: '下载', exact: true }).last()).toBeVisible()
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390)
})
