import { test, expect, type Locator, type Page } from '@playwright/test'

const info = `__PROPERTIES__
[ro.product.brand]: [Google]
[ro.product.model]: [Pixel Test]
[ro.product.device]: [test-device]
[ro.build.display.id]: [TEST.123]
[ro.build.version.release]: [15]
[ro.build.version.sdk]: [35]
[ro.build.version.security_patch]: [2026-01-01]
[ro.boot.flash.locked]: [1]
__BATTERY__
USB powered: true
status: 2
level: 76
scale: 100
temperature: 315
__STORAGE__
Filesystem 1K-blocks Used Available Use% Mounted on
/dev/fuse 104857600 52428800 52428800 50% /storage/emulated
/dev/block/data 67108864 16777216 50331648 25% /data
__DISPLAY__
Physical size: 1080x2400
Physical density: 420
__NETWORK__
1: wlan0 inet 192.168.1.2/24
__UPTIME__
7200 0
__FOREGROUND__
mResumedActivity: ActivityRecord{abc u0 com.example.app/.Main t20}
__SECURITY__
uid=2000(shell)
Enforcing
__SETTINGS__
128
0
0
1
__END__`
async function setup(page: Page, { appIcons = false } = {}) {
  const calls: { operation: string; value?: string }[] = []
  const uploads: string[] = []
  const mock: {
    deviceInfo: string
    deviceInfoError: string
    controlState: Record<
      | 'wifi'
      | 'wifi_connected'
      | 'bluetooth'
      | 'airplane'
      | 'brightness'
      | 'auto_brightness'
      | 'volume',
      number | string | null
    >
    controlStateError: string
    controlStateResponse?: Promise<void>
    brightnessResponse?: Promise<void>
    homeResponse?: Promise<void>
  } = {
    deviceInfo: info,
    deviceInfoError: '',
    controlState: {
      wifi: 1,
      wifi_connected: 0,
      bluetooth: 0,
      airplane: 0,
      brightness: 128,
      auto_brightness: 0,
      volume: '5,0,15',
    },
    controlStateError: '',
  }
  let removed = false
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    let data: unknown = {
      apps: [
        { name: '测试应用', package: 'com.example.app', launchable: true },
        ...(appIcons
          ? [
              {
                name: 'com.android.settings',
                package: 'com.android.settings',
                launchable: false,
                iconUrl: '/api/devices/phone/apps/com.android.settings/icon',
              },
            ]
          : []),
      ],
    }
    if (path.endsWith('/capabilities'))
      data = { network: 'local', adbAllowed: true, webusbAllowed: true }
    else if (path === '/api/devices')
      data = { devices: [{ serial: 'phone', model: 'Pixel Test', state: 'device' }] }
    else if (path === '/api/devices/phone/workbench') {
      const body = route.request().postDataJSON()
      calls.push(body)
      if (body.operation === 'home') await mock.homeResponse
      if (body.operation === 'package-info')
        await new Promise((resolve) => setTimeout(resolve, 200))
      let output = ''
      if (body.operation === 'device-info') {
        if (mock.deviceInfoError) {
          await route.fulfill({ status: 502, json: { error: mock.deviceInfoError } })
          return
        }
        output = mock.deviceInfo
      }
      if (body.operation === 'control-state') {
        await mock.controlStateResponse
        if (mock.controlStateError) {
          await route.fulfill({ status: 502, json: { error: mock.controlStateError } })
          return
        }
        output = Object.entries(mock.controlState)
          .map(([key, value]) => `${key}=${value ?? ''}`)
          .join('\n')
      }
      if (
        body.operation === 'wifi' ||
        body.operation === 'bluetooth' ||
        body.operation === 'airplane'
      ) {
        const radio: 'wifi' | 'bluetooth' | 'airplane' = body.operation
        const enabled = body.value === 'enable' ? 1 : 0
        mock.controlState[radio] = enabled
        if (radio === 'wifi') mock.controlState.wifi_connected = enabled
      }
      if (body.operation === 'brightness') {
        await mock.brightnessResponse
        mock.controlState.brightness = Number(body.value)
        mock.controlState.auto_brightness = 0
      }
      if (body.operation === 'auto-brightness') mock.controlState.auto_brightness = 1
      if (body.operation === 'packages')
        output = `__ALL__\n${removed ? '' : 'package:com.example.app\n'}package:com.android.settings\n__SYSTEM__\npackage:com.android.settings\n__DISABLED__\n__END__`
      if (body.operation === 'package-info')
        output =
          'versionName=2.1\nversionCode=21 minSdk=26 targetSdk=35\nfirstInstallTime=2026-01-02\ncodePath=/data/app/demo'
      if (body.operation === 'package-paths')
        output = 'package:/data/app/demo/base.apk\npackage:/data/app/demo/split.apk'
      if (body.operation === 'app-uninstall') {
        removed = true
        output = 'Success'
      }
      if (body.operation === 'app-clear') output = 'Success'
      data = { output }
    } else if (path.endsWith('/icon')) {
      await route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xl1sAAAAASUVORK5CYII=',
          'base64',
        ),
      })
      return
    } else if (path.endsWith('/apk')) {
      await route.fulfill({
        contentType: 'application/vnd.android.package-archive',
        body: 'test APK',
      })
      return
    } else if (path.endsWith('/install') || path.endsWith('/install-set')) {
      uploads.push(route.request().postData() || '')
      data = { output: 'Success' }
    }
    await route.fulfill({ json: data })
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: '关于设备', exact: true })).toBeEnabled()
  return { calls, uploads, mock }
}

async function openControlCenter(page: Page) {
  const trigger = page
    .locator('.desktop-header')
    .getByRole('button', { name: '控制中心', exact: true })
  await trigger.click()
  const panel = page.getByRole('dialog', { name: '控制中心', exact: true })
  await expect(panel).toBeVisible()
  return { trigger, panel }
}

async function openAboutDevice(page: Page) {
  const dock = page.getByRole('navigation', { name: '工作区操作' })
  await dock.getByRole('button', { name: '关于设备', exact: true }).click()
  const window = page.getByRole('article', { name: '关于设备', exact: true })
  await expect(window).toBeVisible()
  await expect(window).not.toHaveClass(/window-motion-enter-active/)
  return window
}

async function expectNoHorizontalOverflow(element: Locator) {
  await expect
    .poll(() => element.evaluate((node) => node.scrollWidth - node.clientWidth))
    .toBeLessThanOrEqual(1)
}

test('device info preserves unavailable metrics and validates arguments', async ({ page }) => {
  await setup(page)
  const result = await page.evaluate(async (raw) => {
    const path = '/src/services/workbench.ts'
    const { parseDeviceInfo, operationCommand } = await import(path)
    const missing = parseDeviceInfo('')
    let rejected = false
    try {
      operationCommand('app-clear', 'com.example;reboot')
    } catch {
      rejected = true
    }
    return { parsed: parseDeviceInfo(raw), missing, rejected }
  }, info)
  expect(result.parsed.battery).toEqual({
    percent: 76,
    temperature: 31.5,
    status: '充电中',
    power: 'USB',
  })
  expect(result.parsed.network).toBe('wlan0: 192.168.1.2')
  expect(result.parsed.storage[0].available).toBe(52428800 * 1024)
  expect(result.missing.battery.percent).toBeNull()
  expect(result.missing.uptime).toBeNull()
  expect(result.rejected).toBe(true)
})

test('the TopBar control center keeps ordinary device actions in one dialog', async ({ page }) => {
  const { calls, mock } = await setup(page)
  const topbar = page.locator('.desktop-header')
  await expect(topbar.getByRole('button', { name: '控制中心', exact: true })).toHaveCount(1)
  await expect(topbar.getByRole('button', { name: /^(音量控制|屏幕操作)$/ })).toHaveCount(0)
  const { trigger, panel } = await openControlCenter(page)
  await expect(panel.getByRole('heading', { name: '控制中心', exact: true })).toBeFocused()
  await expect(panel.getByRole('button', { name: '熄灭屏幕', exact: true })).toBeDisabled()
  await expect(panel.getByRole('button', { name: /^(关闭控制中心|关闭|切换静音)$/ })).toHaveCount(0)
  for (const [label, operation] of [
    ['锁屏', 'sleep'],
    ['唤醒屏幕', 'wake'],
    ['返回', 'back'],
    ['最近任务', 'recents'],
  ] as const) {
    await panel.getByRole('button', { name: label, exact: true }).click()
    await expect
      .poll(() => calls.filter((call) => call.operation === operation))
      .toEqual([{ operation, value: '' }])
    await expect(panel).toBeVisible()
  }

  const home = panel.getByRole('button', { name: '主屏幕', exact: true })
  const response = Promise.withResolvers<void>()
  mock.homeResponse = response.promise
  try {
    await home.click()
    await expect(home).toBeDisabled()
    await expect
      .poll(() => calls.filter((call) => call.operation === 'home'))
      .toEqual([{ operation: 'home', value: '' }])
  } finally {
    response.resolve()
  }
  await expect(home).toBeEnabled()

  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(trigger).toBeFocused()

  await trigger.click()
  await expect(panel).toBeVisible()
  await page.mouse.click(1, 1)
  await expect(panel).toBeHidden()
})

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} mode keeps the brightness slider and volume meter visible`, async ({ page }) => {
    await setup(page)
    if (theme === 'light') {
      await page.getByRole('button', { name: '切换到亮色模式', exact: true }).click()
    }
    await expect(page.locator('html')).toHaveCSS('color-scheme', theme)
    const { panel } = await openControlCenter(page)
    const brightness = panel.getByRole('group', { name: '屏幕亮度', exact: true })
    const thumb = brightness.getByRole('slider')
    await expect(thumb).toHaveAttribute('aria-valuenow', '128')
    const volume = panel.getByRole('group', { name: '媒体音量', exact: true })
    await expect(volume.getByText(/^5\s*\/\s*15$/)).toBeVisible()
    const meter = volume.locator('.control-center-volume-meter')
    const brightnessTrack = brightness.locator('[data-slot="slider-track"]')
    const luminance = async (
      element: Locator,
      property: 'backgroundColor' | 'borderTopColor' = 'backgroundColor',
    ) => {
      await expect(element).toBeVisible()
      return element.evaluate((node, property) => {
        const ctx = document.createElement('canvas').getContext('2d')!
        ctx.fillStyle = getComputedStyle(node)[property]
        ctx.fillRect(0, 0, 1, 1)
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
        const linear = (byte: number) => {
          const value = byte / 255
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
        }
        return { value: 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b), a }
      }, property)
    }
    const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    const [thumbColor, thumbBorder, trackColor] = await Promise.all([
      luminance(thumb),
      luminance(thumb, 'borderTopColor'),
      luminance(brightnessTrack),
    ])
    expect(thumbColor.a).toBe(255)
    expect(
      Math.max(
        contrast(trackColor.value, thumbColor.value),
        contrast(trackColor.value, thumbBorder.value),
      ),
    ).toBeGreaterThanOrEqual(3)

    for (const [track, fill] of [
      [brightnessTrack, brightness.locator('[data-slot="slider-range"]')],
      [meter, meter.locator('span')],
    ] as const) {
      const [trackColor, fillColor] = await Promise.all([luminance(track), luminance(fill)])
      expect(trackColor.a).toBe(255)
      expect(fillColor.a).toBe(255)
      expect(contrast(trackColor.value, fillColor.value)).toBeGreaterThanOrEqual(3)
    }

    // Keyboard focus should remain visible without a permanent outline around the track.
    await page.keyboard.press('Tab')
    await thumb.focus()
    await expect(thumb).toHaveCSS('outline-style', 'solid')
  })
}

test('the horizontal brightness slider commits a drag only on release', async ({ page }) => {
  const { calls } = await setup(page)
  const { panel } = await openControlCenter(page)
  const brightness = panel.getByRole('slider', { name: '屏幕亮度', exact: true })
  const actions = () => calls.filter((call) => call.operation === 'brightness')

  await expect(brightness).toHaveAttribute('aria-orientation', 'horizontal')
  await expect(brightness).toBeEnabled()
  await expect(brightness).toHaveAttribute('aria-valuenow', '128')
  await expect(panel.getByRole('button', { name: '应用', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('spinbutton')).toHaveCount(0)

  const track = panel.locator('[data-slot="slider"]').filter({
    has: page.getByRole('slider', { name: '屏幕亮度', exact: true }),
  })
  await track.scrollIntoViewIfNeeded()
  const { x, y, width, height } = (await track.boundingBox())!
  await page.mouse.move(x + width * 0.2, y + height / 2)
  await page.mouse.down()
  let target: string | null = null
  try {
    await expect(brightness).not.toHaveAttribute('aria-valuenow', '128')
    const first = await brightness.getAttribute('aria-valuenow')
    await page.mouse.move(x + width * 0.35, y + height / 2, { steps: 3 })
    await expect(brightness).not.toHaveAttribute('aria-valuenow', first!)
    target = await brightness.getAttribute('aria-valuenow')
    expect(actions()).toEqual([])
  } finally {
    await page.mouse.up()
  }
  await expect.poll(actions).toEqual([{ operation: 'brightness', value: target }])
  await expect(panel.getByRole('status')).toHaveText('已执行：设置亮度')
})

test('brightness commits only the latest keyboard draft behind a pending write', async ({
  page,
}) => {
  const { calls, mock } = await setup(page)
  const { panel } = await openControlCenter(page)
  const brightness = panel.getByRole('slider', { name: '屏幕亮度', exact: true })
  const actions = () => calls.filter((call) => call.operation === 'brightness')
  await expect(brightness).toBeEnabled()
  await expect(brightness).toHaveAttribute('aria-valuenow', '128')

  const response = Promise.withResolvers<void>()
  mock.brightnessResponse = response.promise
  try {
    await brightness.press('ArrowRight')
    await expect.poll(actions).toEqual([{ operation: 'brightness', value: '129' }])
    await brightness.press('ArrowRight')
    await brightness.press('ArrowRight')
    await expect(brightness).toHaveAttribute('aria-valuenow', '131')
    expect(actions()).toHaveLength(1)
  } finally {
    mock.brightnessResponse = undefined
    response.resolve()
  }
  await expect.poll(actions).toEqual([
    { operation: 'brightness', value: '129' },
    { operation: 'brightness', value: '131' },
  ])
  await expect(panel.getByRole('status')).toHaveText('已执行：设置亮度')
  await expect(brightness).toHaveAttribute('aria-valuenow', '131')
})

test('volume keys show the reported media level, even when a key does not change it', async ({
  page,
}) => {
  const { calls, mock } = await setup(page)
  const { panel } = await openControlCenter(page)
  const volume = panel.getByRole('group', { name: '媒体音量', exact: true })
  const level = (value: number) => volume.getByText(new RegExp(`^${value}\\s*/\\s*15$`))
  const up = volume.getByRole('button', { name: '调高音量', exact: true })
  const down = volume.getByRole('button', { name: '调低音量', exact: true })
  const volumeCalls = () =>
    calls.filter(({ operation }) => /^(volume-up|volume-down|media-volume)$/.test(operation))
  const stateCalls = () => calls.filter(({ operation }) => operation === 'control-state')
  await expect(volume.getByRole('slider')).toHaveCount(0)
  await expect(level(5)).toBeVisible()
  const meter = volume.locator('.control-center-volume-meter')
  const [lower, track, higher] = await Promise.all([
    down.boundingBox(),
    meter.boundingBox(),
    up.boundingBox(),
  ])
  expect(lower!.x + lower!.width).toBeLessThan(track!.x)
  expect(track!.x + track!.width).toBeLessThan(higher!.x)

  const firstRead = Promise.withResolvers<void>()
  const retryRead = Promise.withResolvers<void>()
  mock.controlStateResponse = firstRead.promise
  try {
    await up.click()
    await expect.poll(volumeCalls).toEqual([{ operation: 'volume-up', value: '' }])
    await expect.poll(stateCalls).toHaveLength(2)
    await expect(level(5)).toBeVisible()

    // The first read is stale. Hold the retry separately until the device reports a change.
    mock.controlStateResponse = retryRead.promise
    firstRead.resolve()
    await expect.poll(stateCalls).toHaveLength(3)
    await expect(level(5)).toBeVisible()
    mock.controlState.volume = '7,0,15'
  } finally {
    mock.controlStateResponse = undefined
    firstRead.resolve()
    retryRead.resolve()
  }
  await expect(level(7)).toBeVisible()

  const previousReads = stateCalls().length
  // A hardware-style volume key may adjust a different stream; keep showing media readback.
  await down.click()
  await expect.poll(volumeCalls).toEqual([
    { operation: 'volume-up', value: '' },
    { operation: 'volume-down', value: '' },
  ])
  await expect.poll(() => stateCalls().length).toBeGreaterThan(previousReads)
  await expect(panel.getByText('媒体音量未变化', { exact: true })).toBeVisible()
  await expect(level(7)).toBeVisible()
  await expect(panel.getByRole('alert')).toHaveCount(0)
})

test('the auto-brightness icon exposes and confirms the device mode', async ({ page }) => {
  const { calls, mock } = await setup(page)
  const { panel } = await openControlCenter(page)
  const autoBrightness = panel.getByRole('button', { name: '自动亮度', exact: true })
  await expect(autoBrightness).toHaveAttribute('aria-pressed', 'false')

  const response = Promise.withResolvers<void>()
  mock.controlStateResponse = response.promise
  try {
    await autoBrightness.click()
    await expect
      .poll(() => calls.filter(({ operation }) => operation === 'auto-brightness'))
      .toEqual([{ operation: 'auto-brightness', value: '' }])
    await expect
      .poll(() => calls.filter(({ operation }) => operation === 'control-state'))
      .toHaveLength(2)
    await expect(autoBrightness).toHaveAttribute('aria-pressed', 'false')
  } finally {
    mock.controlStateResponse = undefined
    response.resolve()
  }
  await expect(autoBrightness).toHaveAttribute('aria-pressed', 'true')
})

test('radio switches reflect control-state and wait for confirmed readback', async ({ page }) => {
  const { calls, mock } = await setup(page)
  const { panel } = await openControlCenter(page)
  const actions = (operation: string) => calls.filter((call) => call.operation === operation)
  const wifi = panel.getByRole('switch', { name: 'Wi-Fi', exact: true })
  const bluetooth = panel.getByRole('switch', { name: '蓝牙', exact: true })
  const airplane = panel.getByRole('switch', { name: '飞行模式', exact: true })

  await expect(wifi).toBeChecked()
  await expect(wifi).toContainText('未连接')
  for (const radio of [bluetooth, airplane]) {
    await expect(radio).not.toBeChecked()
    await expect(radio).toContainText('已关闭')
  }
  expect(actions('control-state')).toEqual([{ operation: 'control-state', value: '' }])
  expect(actions('device-info')).toEqual([])

  for (const [label, operation] of [
    ['Wi-Fi 设置', 'wifi-settings'],
    ['蓝牙 设置', 'bluetooth-settings'],
  ] as const) {
    const settings = panel.getByRole('button', { name: label, exact: true })
    const tile = operation === 'wifi-settings' ? wifi : bluetooth
    await tile.hover()
    const tileBackground = await tile.evaluate((el) => getComputedStyle(el).backgroundColor)
    await settings.hover()
    await expect(settings).toHaveCSS('background-color', tileBackground)
    const settingsBox = (await settings.boundingBox())!
    const tileBox = (await tile.boundingBox())!
    expect(settingsBox.y).toBe(tileBox.y)
    expect(settingsBox.height).toBe(tileBox.height)
    await settings.click()
    await expect.poll(() => actions(operation)).toEqual([{ operation, value: '' }])
  }
  expect(actions('wifi')).toEqual([])
  expect(actions('bluetooth')).toEqual([])

  const wifiConfirmation = page.getByRole('dialog', { name: '关闭 Wi-Fi', exact: true })
  await wifi.click()
  await expect(wifiConfirmation).toBeVisible()
  expect(actions('wifi')).toEqual([])
  await page.keyboard.press('Escape')
  await expect(wifiConfirmation).toBeHidden()
  await expect(wifi).toBeFocused()
  await expect(wifi).toBeChecked()
  expect(actions('wifi')).toEqual([])

  const response = Promise.withResolvers<void>()
  mock.controlStateResponse = response.promise
  try {
    await wifi.click()
    await wifiConfirmation.getByRole('button', { name: '确认操作', exact: true }).click()
    await expect.poll(() => actions('wifi')).toEqual([{ operation: 'wifi', value: 'disable' }])
    await expect.poll(() => actions('control-state')).toHaveLength(2)
    await expect(wifi).toBeDisabled()
    await expect(wifi).toBeChecked()
  } finally {
    mock.controlStateResponse = undefined
    response.resolve()
  }
  await expect(wifi).not.toBeChecked()
  await expect(wifi).toContainText('已关闭')
  await wifi.click()
  await expect(wifi).toBeChecked()
  await expect(wifi).toContainText('已连接')
  expect(actions('wifi').map(({ value }) => value)).toEqual(['disable', 'enable'])

  await bluetooth.click()
  await expect(bluetooth).toBeChecked()
  await expect(bluetooth).toContainText('已开启')
  expect(actions('bluetooth')).toEqual([{ operation: 'bluetooth', value: 'enable' }])

  await airplane.click()
  const airplaneConfirmation = page.getByRole('dialog', { name: '开启 飞行模式', exact: true })
  await expect(airplaneConfirmation).toBeVisible()
  expect(actions('airplane')).toEqual([])
  await airplaneConfirmation.getByRole('button', { name: '确认操作', exact: true }).click()
  await expect(airplane).toBeChecked()
  await expect(airplane).toContainText('已开启')
  expect(actions('airplane')).toEqual([{ operation: 'airplane', value: 'enable' }])
  await expect(panel).toBeVisible()
})

test('a failed radio readback leaves the affected radio unknown, not unchecked', async ({
  page,
}) => {
  const { calls, mock } = await setup(page)
  const { panel } = await openControlCenter(page)
  const wifi = panel.getByRole('switch', { name: 'Wi-Fi', exact: true })
  await expect(wifi).toBeChecked()
  await wifi.click()
  const confirmation = page.getByRole('dialog', { name: '关闭 Wi-Fi', exact: true })
  await expect(confirmation).toBeVisible()
  mock.controlStateError = '测试：无法回读设备状态'
  await confirmation.getByRole('button', { name: '确认操作', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText(mock.controlStateError)
  await expect(wifi).toHaveCount(0)
  const unknownWifi = panel.getByRole('button', { name: 'Wi-Fi', exact: true })
  await expect(unknownWifi).toBeDisabled()
  await expect(unknownWifi).toContainText('状态未知')
  await expect(unknownWifi).not.toHaveAttribute('aria-checked')
  await expect(panel.getByRole('switch', { name: '蓝牙', exact: true })).not.toBeChecked()
  expect(calls.filter(({ operation }) => operation === 'wifi')).toEqual([
    { operation: 'wifi', value: 'disable' },
  ])
})

test('a failed control-state read keeps navigation available and can be retried', async ({
  page,
}) => {
  const { calls, mock } = await setup(page)
  mock.controlStateError = '测试：无法读取设备状态'
  const { panel } = await openControlCenter(page)
  await expect(panel.getByRole('alert')).toHaveText('读取设备状态失败：' + mock.controlStateError)
  for (const name of ['Wi-Fi', '蓝牙', '飞行模式']) {
    const radio = panel.getByRole('button', { name, exact: true })
    await expect(radio).toBeDisabled()
    await expect(radio).toContainText('状态未知')
  }
  await expect(panel.getByRole('switch')).toHaveCount(0)
  await expect(panel.getByText('亮度未知', { exact: true })).toBeVisible()
  await expect(panel.getByText('音量未知', { exact: true })).toBeVisible()
  const autoBrightness = panel.getByRole('button', { name: '自动亮度', exact: true })
  await expect(autoBrightness).not.toHaveAttribute('aria-pressed')
  await panel.getByRole('button', { name: '主屏幕', exact: true }).click()
  await expect
    .poll(() => calls.filter(({ operation }) => operation === 'home'))
    .toEqual([{ operation: 'home', value: '' }])

  mock.controlStateError = ''
  mock.controlState.wifi_connected = null
  mock.controlState.bluetooth = null
  await panel.getByRole('button', { name: '重试', exact: true }).click()
  const wifi = panel.getByRole('switch', { name: 'Wi-Fi', exact: true })
  await expect(wifi).toBeChecked()
  await expect(wifi).toContainText('已开启')
  const bluetooth = panel.getByRole('button', { name: '蓝牙', exact: true })
  await expect(bluetooth).toBeDisabled()
  await expect(bluetooth).toContainText('状态未知')
  await expect(panel.getByRole('switch', { name: '蓝牙', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('alert')).toHaveCount(0)
  expect(
    calls.filter(({ operation }) =>
      /^(brightness|auto-brightness|volume-up|volume-down)$/.test(operation),
    ),
  ).toEqual([])
})

test('the narrow control center keeps controls reachable and confirms reboot', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 })
  const { calls } = await setup(page)
  const { panel } = await openControlCenter(page)
  const bounds = (await panel.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(700)
  await expectNoHorizontalOverflow(panel)
  await expectNoHorizontalOverflow(panel.locator('.control-center-scroll'))

  const slider = panel.getByRole('slider', { name: '屏幕亮度', exact: true })
  const home = panel.getByRole('button', { name: '主屏幕', exact: true })
  await expect(panel.getByRole('button', { name: '重启设备', exact: true })).toBeHidden()
  await panel.getByRole('button', { name: '更多控制', exact: true }).click()
  const moreContent = panel.locator('.control-center-more-content')
  const commands = moreContent.getByRole('button')
  await expect(commands).toHaveText([
    '竖屏',
    '横屏',
    '自动旋转',
    '充电常亮',
    '关闭常亮',
    '系统设置',
    '电源键',
    '重启设备',
  ])
  const rows = await commands.evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().top),
  )
  expect(rows.slice(0, 4)).toEqual(Array(4).fill(rows[0]))
  expect(rows.slice(4)).toEqual(Array(4).fill(rows[4]))
  expect(rows[4]!).toBeGreaterThan(rows[0]!)
  await expectNoHorizontalOverflow(moreContent)
  const reboot = moreContent.getByRole('button', { name: '重启设备', exact: true })
  await expect(reboot).toBeVisible()
  await expect(reboot).toHaveText('重启设备')
  await expect(reboot.locator('svg')).toHaveCount(0)
  const volumeUp = panel.getByRole('button', { name: '调高音量', exact: true })
  for (const control of [slider, volumeUp, home, reboot]) {
    await control.scrollIntoViewIfNeeded()
    await expect(control).toBeInViewport({ ratio: 1 })
  }
  const rebootCalls = () => calls.filter((call) => call.operation === 'reboot')
  const confirmation = page.getByRole('dialog', { name: '重启设备', exact: true })
  await reboot.click()
  await expect(confirmation).toBeVisible()
  expect(rebootCalls()).toEqual([])
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(confirmation).toBeHidden()
  await expect(panel).toBeVisible()
  expect(rebootCalls()).toEqual([])
  await reboot.click()
  await confirmation.getByRole('button', { name: '确认操作', exact: true }).click()
  await expect.poll(rebootCalls).toEqual([{ operation: 'reboot', value: '' }])
  await expect(panel).toBeHidden()
})

test('About Device keeps the last successful overview and retries a failed refresh', async ({
  page,
}) => {
  const { calls, mock } = await setup(page)
  const window = await openAboutDevice(page)
  await expect(window).toHaveAttribute('data-window-id', 'device-tools')
  await expect(window.getByRole('tablist')).toHaveCount(0)
  await expect(window.getByRole('button', { name: '截取屏幕', exact: true })).toHaveCount(0)
  const refresh = window.getByRole('button', { name: '刷新信息', exact: true })
  const oldBattery = window.getByText('76%', { exact: true })
  for (const metric of ['Android 15', 'API 35', '31.5 °C', '76%']) {
    await expect(window.getByText(metric, { exact: true })).toBeVisible()
  }
  const specs = window.locator('.device-about-specs')
  for (const metric of ['存储', '/data', '总容量', '64.0 GB', '可用', '48.0 GB']) {
    await expect(specs.getByText(metric, { exact: true })).toBeVisible()
  }
  await expect(specs.getByText('/storage/emulated', { exact: true })).toHaveCount(0)

  mock.deviceInfoError = '测试：读取设备信息失败'
  await refresh.click()
  await expect(window.getByRole('alert')).toHaveText(mock.deviceInfoError)
  await expect(oldBattery).toBeVisible()

  mock.deviceInfoError = ''
  mock.deviceInfo = info.replace('level: 76', 'level: 62')
  await window.getByRole('button', { name: '重试', exact: true }).click()
  await expect(window.getByText('62%', { exact: true })).toBeVisible()
  await expect(window.getByRole('alert')).toHaveCount(0)
  await expect(oldBattery).toHaveCount(0)
  expect(calls.filter((call) => call.operation === 'device-info')).toHaveLength(3)
})

test('About Device switches the window and Dock icon between dark and light palettes', async ({
  page,
}) => {
  await setup(page)
  const window = await openAboutDevice(page)
  const scroll = window.locator('.device-about-scroll')
  const emblem = window.locator('.device-about-emblem')
  const cards = window.locator('.device-about-spec')
  const dockIcon = page.getByRole('button', { name: '关于设备', exact: true }).locator('svg')
  const palette = (icon: Locator) =>
    icon.evaluate((node) =>
      [...node.querySelectorAll('*')].map((part) => {
        const { fill, stroke, stopColor } = getComputedStyle(part)
        return [fill.startsWith('url(') ? 'gradient' : fill, stroke, stopColor]
      }),
    )
  await expect(window.getByRole('heading', { name: 'Pixel Test' })).toBeVisible()
  await expect(window.getByText('phone', { exact: true })).toBeVisible()
  await expect(cards).toHaveCount(3)
  expect((await cards.nth(0).boundingBox())!.y).toBe((await cards.nth(2).boundingBox())!.y)
  await expect(scroll).toHaveCSS('background-color', 'rgb(37, 42, 52)')
  const darkPalette = await palette(dockIcon)
  expect(await palette(emblem)).toEqual(darkPalette)

  await page.getByRole('button', { name: '切换到亮色模式', exact: true }).click()
  await expect(scroll).toHaveCSS('background-color', 'rgb(246, 248, 252)')
  await expect(cards.first()).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect.poll(() => palette(dockIcon)).not.toEqual(darkPalette)
  expect(await palette(emblem)).toEqual(await palette(dockIcon))
  await expectNoHorizontalOverflow(scroll)
})

test('About Device shows expandable version and status details at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await setup(page)
  const window = await openAboutDevice(page)
  await expect.poll(() => window.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 700 })
  const scroller = window.locator('.device-about-scroll')
  const cards = window.locator('.device-about-spec')
  await expect(cards).toHaveCount(3)
  expect((await cards.nth(0).boundingBox())!.y).toBeLessThan((await cards.nth(2).boundingBox())!.y)
  await expectNoHorizontalOverflow(scroller)
  const refresh = window.getByRole('button', { name: '刷新信息', exact: true })
  await expect(refresh).toBeInViewport()

  for (const [section, value] of [
    ['版本信息', 'TEST.123'],
    ['状态信息', 'wlan0: 192.168.1.2'],
  ] as const) {
    const summary = window.locator('summary').filter({ hasText: section })
    const detail = window.getByText(value, { exact: true })
    await expect(detail).toBeHidden()
    await summary.press('Enter')
    await expect(detail).toBeVisible()
    await expectNoHorizontalOverflow(scroller)
  }
  const mounts = window.locator('.device-about-mounts')
  await expect(mounts.getByText('/data', { exact: true })).toBeVisible()
  await expect(mounts.getByText('/storage/emulated', { exact: true })).toBeVisible()
})

test('application manager shows a real icon for non-launchable apps and falls back without metadata', async ({
  page,
}) => {
  await setup(page, { appIcons: true })
  await page.getByRole('button', { name: '应用管理', exact: true }).click()
  const title = page.locator('[data-window-id="app-manager"] .developer-window-title')
  await expect(title).toHaveText('应用管理')
  await expect(title.locator('svg')).toHaveCount(0)
  const settings = page.getByRole('button', { name: /com.android.settings.*系统/ })
  const app = page.getByRole('button', { name: /测试应用.*com.example.app/ })
  await expect(settings.locator('img.is-loaded')).toBeVisible()
  await expect(app.locator('.app-art svg')).toBeVisible()
  await settings.click()
  await expect(page.locator('.app-manager-detail img.is-loaded')).toBeVisible()
})

test('application manager lists all packages and confirms changes before dispatch', async ({
  page,
}) => {
  const { calls } = await setup(page)
  await page.getByRole('button', { name: '应用管理', exact: true }).click()
  await page.getByRole('button', { name: /测试应用.*com.example.app/ }).click()
  await expect(page.getByText('2.1 (21)')).toBeVisible()
  const columns = page.locator('.app-manager-columns')
  const initialY = (await columns.boundingBox())!.y
  const settings = page.getByRole('button', { name: /com.android.settings.*系统/ })
  await settings.click()
  await expect(page.locator('.app-manager-detail')).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByText('正在读取详情…')).toHaveCount(0)
  expect((await columns.boundingBox())!.y).toBe(initialY)
  await expect(page.getByText('2.1 (21)')).toBeVisible()
  await expect(page.locator('.app-manager-detail')).toHaveAttribute('aria-busy', 'false')
  expect((await columns.boundingBox())!.y).toBe(initialY)
  await page.getByRole('button', { name: /测试应用.*com.example.app/ }).click()
  await expect(page.getByText('2.1 (21)')).toBeVisible()
  await page.getByRole('button', { name: '清除数据', exact: true }).click()
  expect(calls.some((c) => c.operation === 'app-clear')).toBe(false)
  await page.getByRole('button', { name: '确认操作' }).click()
  await expect
    .poll(() => calls.filter((c) => c.operation === 'app-clear'))
    .toEqual([{ operation: 'app-clear', value: 'com.example.app' }])
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'base.apk', exact: true }).click()
  expect((await download).suggestedFilename()).toBe('com.example.app-base.apk')
  await page.getByRole('button', { name: '卸载', exact: true }).click()
  await page.getByRole('button', { name: '确认操作' }).click()
  await expect(page.getByRole('button', { name: /测试应用.*com.example.app/ })).toHaveCount(0)
  await page.getByRole('button', { name: '系统应用', exact: true }).click()
  await expect(page.getByRole('button', { name: /com.android.settings.*系统/ })).toBeVisible()
})

test('installer title is text-only at desktop and narrow widths', async ({ page }) => {
  await setup(page)
  await page.getByRole('button', { name: '安装应用', exact: true }).click()
  const installer = page.getByTestId('installer-window')
  const title = installer.locator('.installer-window-title')
  for (const width of [1200, 375]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(title).toBeVisible()
    await expect(title).toHaveText('安装应用')
    await expect(title.locator('svg')).toHaveCount(0)
    await expect(installer.getByRole('button', { name: '关闭应用安装器' })).toBeVisible()
  }
})

test('installer handles batch errors without blocking later APKs and split options', async ({
  page,
}) => {
  const { uploads } = await setup(page)
  let attempts = 0
  await page.route('**/api/devices/phone/install', async (route) => {
    attempts++
    await route.fulfill(
      attempts === 1
        ? { status: 502, json: { error: 'INSTALL_FAILED_NO_MATCHING_ABIS' } }
        : { json: { output: 'Success' } },
    )
  })
  await page.getByRole('button', { name: '安装应用', exact: true }).click()
  const files = ['base.apk', 'split.apk'].map((name) => ({
    name,
    mimeType: 'application/vnd.android.package-archive',
    buffer: Buffer.from('APK'),
  }))
  await page.getByLabel('选择 APK 文件').setInputFiles(files)
  await page.getByRole('button', { name: '安装', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('CPU 架构')
  expect(attempts).toBe(2)
  await expect(page.getByLabel('安装结果')).toContainText('split.apk · 安装成功')
  await page.getByRole('button', { name: '同一应用的分包' }).click()
  await page.getByRole('switch', { name: '允许降级（设备可能限制）' }).click()
  await page.getByRole('button', { name: '安装', exact: true }).click()
  await expect(page.getByText('应用安装成功')).toBeVisible()
  expect(uploads).toHaveLength(1)
  expect(uploads[0]).toContain('base.apk')
  expect(uploads[0]).toContain('split.apk')
  expect(uploads[0]).toContain('name="downgrade"\r\n\r\ntrue')
})
