import { test, expect, type Page, type WebSocketRoute } from '@playwright/test'
import { LogcatParser, filterLogcat, packagePids } from '../src/services/logcat-parser'

test('Logcat preserves split UTF-8, stack traces, and limits unterminated lines', () => {
  const parser = new LogcatParser()
  const bytes = Buffer.from('09-26 10:20:30.001  42  43 E Tag: 你好\r\n  at example.Main\n')
  const rows = [...bytes].flatMap((byte) => parser.push(new Uint8Array([byte])))
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ pid: 42, tid: 43, level: 'E', tag: 'Tag' })
  expect(rows[0]!.raw).toContain('你好')
  expect(filterLogcat(rows, 'E', '', '42')).toHaveLength(2)
  expect(filterLogcat(rows, 'F', '', '')).toHaveLength(0)
  for (let i = 0; i < 100; i++) parser.push(new Uint8Array(1000).fill(120))
  const truncated = parser.push(new Uint8Array(), true)
  expect(truncated[0]!.raw.length).toBeLessThan(8300)
  expect(truncated[0]!.raw).toContain('[行已截断]')
  expect([
    ...packagePids(
      'PID NAME\n42 com.example.app\n43 com.example.app:service\n44 com.example.application\n',
      'EXAMPLE.APP',
    ),
  ]).toEqual([42, 43, 44])
})

function snapshot(n: number) {
  return `__UPTIME__\n${10 + n} 0\n__CPU__\ncpu ${n * 10} 0 0 ${n * 30} 0 0 0 0 0 0\n__MEMORY__\nMemTotal: 8192 kB\nMemAvailable: 4096 kB\n__NETWORK__\nwlan0: ${n * 1024} 0 0 0 0 0 0 0 ${n * 2048} 0 0 0 0 0 0 0\ntun0: ${n * 1024} 0 0 0 0 0 0 0 ${n * 2048} 0 0 0 0 0 0 0\n__END__`
}

async function setup(page: Page) {
  let reads = 0
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const data = path.endsWith('/capabilities')
      ? { network: 'local', adbAllowed: true, webusbAllowed: true }
      : path === '/api/devices'
        ? { devices: [{ serial: 'phone', model: 'Developer Phone', state: 'device' }] }
        : path.endsWith('/metrics')
          ? { snapshot: snapshot(++reads) }
          : { apps: [] }
    await route.fulfill({ json: data })
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: '性能监控', exact: true })).toBeEnabled()
  return () => reads
}

test('metrics parse counter resets, unavailable fields and guest CPU correctly', async ({
  page,
}) => {
  await setup(page)
  const result = await page.evaluate(
    async (samples) => {
      const path = '/src/services/metrics.ts'
      const { parseSnapshot, calculateMetrics } = await import(path)
      const first = parseSnapshot(samples[0])
      const second = parseSnapshot(samples[1])
      const missing = parseSnapshot('__CPU__\nPermission denied\n__MEMORY__\n__NETWORK__\n__END__')
      return {
        normal: calculateMetrics(second, first),
        reset: calculateMetrics(first, second),
        initial: calculateMetrics(first),
        missing: calculateMetrics(missing, first),
        guest: parseSnapshot('__CPU__\ncpu 10 0 10 80 0 0 0 0 5 5\n__END__').cpu,
      }
    },
    [snapshot(1), snapshot(2)],
  )
  expect(result.normal.cpu).toBe(25)
  expect(result.normal.memory).toEqual({ total: 8388608, used: 4194304 })
  expect(result.normal.interfaces[0]).toEqual({ name: 'wlan0', rx: 1024, tx: 2048 })
  expect(result.reset.cpu).toBeNull()
  expect(result.reset.interfaces[0].rx).toBeNull()
  expect(result.initial.interfaces[0].rx).toBeNull()
  expect(result.missing).toEqual({ cpu: null, memory: null, interfaces: [] })
  expect(result.guest).toEqual({ total: 100, idle: 80 })
})

test('performance panel rounds sub-kilobyte network rates', async ({ page }) => {
  let reads = 0
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const n = ++reads
    const data = path.endsWith('/capabilities')
      ? { network: 'local', adbAllowed: true, webusbAllowed: true }
      : path === '/api/devices'
        ? { devices: [{ serial: 'phone', model: 'Developer Phone', state: 'device' }] }
        : path.endsWith('/metrics')
          ? {
              snapshot: `__UPTIME__\n${n * 1.37} 0\n__CPU__\ncpu ${n} 0 0 ${n}\n__MEMORY__\nMemTotal: 1000 kB\nMemAvailable: 500 kB\n__NETWORK__\nwlan0: ${n * 193} 0 0 0 0 0 0 0 ${n * 193} 0 0 0 0 0 0 0\n__END__`,
            }
          : { apps: [] }
    await route.fulfill({ json: data })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '性能监控', exact: true }).click()
  await expect(page.getByTestId('metric-tx')).toHaveText('141 B/s')
  await expect(page.getByTestId('metric-tx')).not.toContainText('.')
})

test('performance widget shows phone rates without VPN double-counting and stops on close', async ({
  page,
}) => {
  const reads = await setup(page)
  await page.getByRole('button', { name: '性能监控', exact: true }).click()
  await expect(page.getByTestId('performance-widget')).toBeVisible()
  await expect(page.getByTestId('metric-cpu')).toHaveText('25.0%')
  await expect(page.getByTestId('metric-memory')).toHaveText('50.0%')
  await expect(page.getByTestId('metric-tx')).toHaveText('2.0 KB/s')
  await expect(page.getByTestId('metric-rx')).toHaveText('1.0 KB/s')
  await expect(page.getByRole('cell', { name: 'tun0', exact: true })).toHaveCount(0)
  await expect
    .poll(async () => Number(await page.getByTestId('cpu-chart').getAttribute('data-points')))
    .toBeGreaterThanOrEqual(3)
  await expect
    .poll(async () => page.getByTestId('cpu-chart').locator('path').count())
    .toBeGreaterThan(0)
  await expect
    .poll(async () => page.getByTestId('memory-chart').locator('path').count())
    .toBeGreaterThan(0)
  await page.getByRole('button', { name: '暂停监控' }).click()
  const count = reads()
  await page.waitForTimeout(1200)
  expect(reads()).toBe(count)
  await page.getByRole('button', { name: '继续监控' }).click()
  await expect.poll(reads).toBeGreaterThan(count)
  await page.getByRole('button', { name: '关闭性能监控小组件', exact: true }).click()
  await expect(page.getByTestId('performance-widget')).toHaveCount(0)
  const closedCount = reads()
  await expect.poll(reads).toBeGreaterThan(closedCount)
  await expect(page.getByTestId('topbar-metric-cpu')).toHaveText('25%')
})

test('performance widget stays on the desktop, drags and remembers its placement', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await setup(page)
  const toggle = page.getByRole('button', { name: '性能监控', exact: true })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  const widget = page.getByTestId('performance-widget')
  await expect(widget).toBeVisible()
  await expect(widget).toHaveCSS('backdrop-filter', 'none')
  await expect(widget).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.733)')
  await expect(widget).not.toHaveClass(/widget-motion-enter-active/)
  await expect(widget.locator('.window-titlebar')).toHaveCount(0)
  const workspace = (await page.locator('.desktop-workspace').boundingBox())!
  const initial = (await widget.boundingBox())!
  expect(Math.round(initial.x + initial.width)).toBe(Math.round(workspace.x + workspace.width - 20))
  expect(Math.round(initial.y)).toBe(Math.round(workspace.y + 20))

  const grab = widget.getByTestId('metric-cpu')
  const box = (await grab.boundingBox())!
  await page.mouse.move(box.x + 5, box.y + 5)
  await page.mouse.down()
  await page.mouse.move(box.x - 295, box.y + 105, { steps: 4 })
  await page.mouse.up()
  await expect.poll(async () => (await widget.boundingBox())!.x).toBeCloseTo(initial.x - 300, 0)
  const moved = (await widget.boundingBox())!
  expect(moved.y).toBeCloseTo(initial.y + 100, 0)

  await page.mouse.move(box.x - 295, box.y + 105)
  await page.mouse.down()
  await page.mouse.move(box.x + 2000, box.y - 2000, { steps: 4 })
  await page.mouse.up()
  await expect
    .poll(async () => {
      const b = (await widget.boundingBox())!
      return [Math.round(b.x + b.width), Math.round(b.y)]
    })
    .toEqual([Math.round(workspace.x + workspace.width - 8), Math.round(workspace.y + 8)])

  await widget.focus()
  await widget.press('Shift+ArrowLeft')
  await widget.press('ArrowDown')
  const nudged = (await widget.boundingBox())!

  await page.getByRole('button', { name: 'Logcat', exact: true }).click()
  await expect(page.getByTestId('logcat-window')).toBeVisible()
  await page.getByRole('button', { name: '显示桌面', exact: true }).click()
  await expect(page.getByTestId('logcat-window')).toBeHidden()
  await expect(widget).toBeVisible()

  await page.reload()
  await expect(widget).toBeVisible()
  await expect(page.getByTestId('topbar-metric-cpu')).toHaveText('25%')
  await expect(page.getByRole('button', { name: '性能监控', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect.poll(() => widget.boundingBox()).toEqual(nudged)
  await page.getByRole('button', { name: '性能监控', exact: true }).click()
  await expect(widget).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('button', { name: '性能监控', exact: true })).toBeEnabled()
  await expect(widget).toHaveCount(0)
})

test('developer windows share resize, maximize and geometry restoration', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await setup(page)
  await page.getByRole('button', { name: 'Logcat', exact: true }).click()
  const panel = page.getByTestId('logcat-window')
  await expect(panel).toBeVisible()
  await expect(panel).not.toHaveClass(/window-motion-enter-active/)
  expect((await panel.boundingBox())!.height).toBe(640)
  const handle = panel.getByRole('button', { name: '调节Logcat窗口大小' })
  const initial = (await panel.boundingBox())!
  await handle.press('Shift+ArrowRight')
  await handle.press('ArrowDown')
  const resized = (await panel.boundingBox())!
  expect(resized.width).toBe(initial.width + 40)
  expect(resized.height).toBe(initial.height + 10)

  await panel.locator('.developer-window-title').dblclick()
  const workspace = (await page.locator('.desktop-workspace').boundingBox())!
  await expect
    .poll(() => panel.boundingBox())
    .toEqual({
      x: workspace.x + 12,
      y: workspace.y + 12,
      width: workspace.width - 24,
      height: workspace.height - 24,
    })
  await expect(handle).toBeHidden()
  await panel.getByRole('button', { name: '还原Logcat窗口' }).click()
  expect(await panel.boundingBox()).toEqual(resized)

  await panel.getByRole('button', { name: '最小化Logcat窗口' }).click()
  await expect(panel).toBeHidden()
  await page.getByRole('button', { name: 'Logcat', exact: true }).click()
  expect(await panel.boundingBox()).toEqual(resized)
  await page.setViewportSize({ width: 390, height: 780 })
  await expect.poll(() => panel.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 780 })
  await expect(handle).toBeHidden()
})

test('ADB terminal carries input, control keys, resize and closes its socket', async ({ page }) => {
  const messages: { type: string; data?: string; rows?: number; cols?: number }[] = []
  let closed = false
  await page.routeWebSocket(/\/ws\/devices\/.*\/terminal/, (ws) => {
    ws.send(JSON.stringify({ type: 'ready' }))
    ws.send(Buffer.from('Android shell ready\r\n'))
    ws.onMessage((data) => {
      const message = JSON.parse(String(data))
      messages.push(message)
      if (message.type === 'input') ws.send(Buffer.from(message.data))
    })
    ws.onClose(() => {
      closed = true
    })
  })
  await setup(page)
  await page.getByRole('button', { name: '终端', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已连接')
  await expect.poll(() => messages.some((m) => m.type === 'ack')).toBe(true)
  await page.getByRole('button', { name: '性能监控', exact: true }).click()
  await expect(page.getByTestId('performance-widget')).toBeVisible()
  await expect(page.getByTestId('terminal-window')).toBeVisible()
  await page.getByRole('button', { name: '终端', exact: true }).click()
  await page.locator('.xterm-helper-textarea').fill('')
  await page.keyboard.type('echo hello')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('terminal-window')).toBeVisible()
  await expect
    .poll(() =>
      messages
        .filter((m) => m.type === 'input')
        .map((m) => m.data)
        .join(''),
    )
    .toContain('echo hello\r\x03\x1b')
  await page.setViewportSize({ width: 650, height: 700 })
  await expect
    .poll(() => messages.some((m) => m.type === 'resize' && m.rows! > 0 && m.cols! > 0))
    .toBe(true)
  await page.getByRole('button', { name: '最小化终端窗口', exact: true }).click()
  await expect(page.getByTestId('terminal-window')).toBeHidden()
  expect(closed).toBe(false)
  await page.getByRole('button', { name: '终端', exact: true }).click()
  await expect(page.getByTestId('terminal-window')).toBeVisible()
  await expect(page.getByTestId('terminal-window').getByRole('status')).toContainText('已连接')
  await page.getByRole('button', { name: '关闭终端窗口', exact: true }).click()
  await expect.poll(() => closed).toBe(true)
})

test('Logcat streams, filters, pauses and closes its socket', async ({ page }) => {
  const lines = [
    '03-14 12:34:56.789  123  456 I mugi: startup complete',
    '03-14 12:34:57.001  123  456 W mugi: slow frame',
    '03-14 12:34:58.002  999  999 E OtherApp: fatal failure',
  ]
  let closed = false
  await page.routeWebSocket(/\/ws\/devices\/.*\/logcat/, (ws) => {
    ws.send(JSON.stringify({ type: 'ready' }))
    ws.send(Buffer.from(`${lines.join('\n')}\n`))
    ws.onClose(() => {
      closed = true
    })
  })
  await setup(page)
  await page.getByRole('button', { name: 'Logcat', exact: true }).click()
  const panel = page.getByTestId('logcat-window')
  await expect(panel.getByRole('button', { name: '停止采集' })).toBeVisible()
  const viewport = panel.getByRole('region', { name: 'Logcat 日志' })
  await expect(viewport).toContainText('startup complete')
  await expect(viewport).toContainText('fatal failure')
  await expect(viewport.getByRole('button')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '复制筛选日志' })).toBeEnabled()

  await panel.getByLabel('搜索日志').fill('slow frame')
  await expect(viewport).toContainText('slow frame')
  await expect(viewport).not.toContainText('startup complete')
  await panel.getByRole('button', { name: '暂停滚动' }).click()
  await expect(panel.getByRole('button', { name: '跟随最新' })).toBeVisible()

  await page.setViewportSize({ width: 375, height: 800 })
  await expect(viewport.getByText(lines[1], { exact: true })).toBeVisible()
  await expect(viewport.getByRole('button')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '复制筛选日志' })).toBeEnabled()

  await panel.getByRole('button', { name: '清空视图' }).click()
  await panel.getByRole('button', { name: '关闭Logcat窗口', exact: true }).click()
  await expect.poll(() => closed).toBe(true)
})

test('Logcat package filtering survives stop, exports results, and clears device buffers', async ({
  page,
}) => {
  let socket!: WebSocketRoute
  let connections = 0
  await page.routeWebSocket(/\/ws\/devices\/.*\/logcat/, (ws) => {
    socket = ws
    connections++
    ws.send(JSON.stringify({ type: 'ready' }))
    ws.send(
      Buffer.from(
        '09-26 10:20:30.001 42 42 I Tag: app info\n09-26 10:20:30.002 43 43 E Tag: child crash\n09-26 10:20:30.003 99 99 E Tag: other app\n',
      ),
    )
  })
  await setup(page)
  let cleared = 0
  await page.route('**/api/devices/phone/logcat', (route) => {
    expect(route.request().method()).toBe('DELETE')
    cleared++
    return route.fulfill({ json: { ok: true } })
  })
  await page.route('**/api/devices/phone/logcat/processes', (route) =>
    route.fulfill({
      json: {
        output: 'PID NAME\n42 com.example.app\n43 com.example.app:worker\n99 com.other.app\n',
      },
    }),
  )
  await page.getByRole('button', { name: 'Logcat', exact: true }).click()
  const panel = page.getByTestId('logcat-window')
  await panel.getByLabel('应用包名').fill('com.example.app')
  await panel.getByLabel('最低级别').click()
  await page.getByRole('option', { name: 'Error', exact: true }).click()
  await panel.getByRole('button', { name: '停止采集' }).click()
  const downloadPromise = page.waitForEvent('download')
  await panel.getByRole('button', { name: '导出日志' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^logcat-phone-.*\.txt$/)
  const stream = await download.createReadStream()
  let text = ''
  for await (const data of stream) text += data.toString()
  expect(text).toContain('child crash')
  expect(text).not.toContain('other app')
  await panel.getByRole('button', { name: '重新连接' }).click()
  await expect(panel.getByRole('button', { name: '停止采集' })).toBeVisible()
  await panel.getByRole('button', { name: '清空设备日志' }).click()
  await expect.poll(() => cleared).toBe(1)
  await expect.poll(() => connections).toBe(3)
  socket.send(JSON.stringify({ type: 'error', message: 'device offline' }))
  await expect(panel.getByRole('button', { name: '重新连接' })).toBeEnabled()
})

test('Logcat bounds its cache and DOM while continuing capture with scrolling paused', async ({
  page,
}) => {
  let socket!: WebSocketRoute
  await page.routeWebSocket(/\/ws\/devices\/.*\/logcat/, (ws) => {
    socket = ws
    ws.send(JSON.stringify({ type: 'ready' }))
  })
  await setup(page)
  await page.getByRole('button', { name: 'Logcat', exact: true }).click()
  const panel = page.getByTestId('logcat-window')
  await expect(panel.getByRole('button', { name: '停止采集' })).toBeVisible()
  await panel.getByRole('button', { name: '暂停滚动' }).click()
  socket.send(
    Buffer.from(
      Array.from({ length: 3100 }, (_, i) => `09-26 10:20:30.001 42 42 I Tag: message-${i}\n`).join(
        '',
      ),
    ),
  )
  expect(await panel.locator('.logcat-row').count()).toBeLessThan(60)
  await expect(panel.getByRole('button', { name: '跟随最新' })).toBeVisible()
  await panel.getByRole('button', { name: '跟随最新' }).click()
  await expect(panel.getByRole('region', { name: 'Logcat 日志' })).toContainText('message-3099')
})
