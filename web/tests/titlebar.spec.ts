import { test, expect, type Page } from '@playwright/test'

async function mockBackend(page: Page) {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    return route.fulfill({
      json:
        path === '/api/capabilities'
          ? { network: 'local', adbAllowed: true, webusbAllowed: true }
          : { devices: [], sessions: [] },
    })
  })
}

test('browser toolbar does not load native controls or runtime', async ({ page }) => {
  await mockBackend(page)
  const runtimeRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('@wailsio_runtime') || request.url().includes('/wails/'))
      runtimeRequests.push(request.url())
  })
  await page.goto('/?desktop=true')
  const launcher = page.getByRole('button', { name: '打开应用启动器', exact: true })
  await expect(launcher).toBeVisible()
  await expect(launcher).toHaveText('Mugi')
  await expect(launcher.locator('img')).toHaveCount(0)
  await expect(page.locator('link[rel=icon]')).toHaveAttribute('href', '/mugi.svg')
  await expect(page.locator('.desktop-header')).not.toContainText('搜索应用')
  await expect(page.getByRole('group', { name: '应用窗口控制' })).toHaveCount(0)
  expect(runtimeRequests).toEqual([])
})

test('native titles are hidden on hover and restored with their latest value', async ({ page }) => {
  await mockBackend(page)
  await page.goto('/')

  const launcher = page.getByRole('button', { name: '打开应用启动器', exact: true })
  const theme = page.getByRole('button', { name: /切换到.*模式/ })
  await expect(launcher).toHaveAttribute('title', 'Mugi · 打开应用启动器')
  await launcher.hover()
  await expect(launcher).not.toHaveAttribute('title')

  const previousLabel = await theme.getAttribute('aria-label')
  await theme.locator('svg').hover()
  await expect(launcher).toHaveAttribute('title', 'Mugi · 打开应用启动器')
  await expect(theme).not.toHaveAttribute('title')
  await theme.click()
  await expect(theme).not.toHaveAttribute('aria-label', previousLabel!)
  await expect(theme).not.toHaveAttribute('title')

  await launcher.hover()
  await expect(theme).toHaveAttribute('title', (await theme.getAttribute('aria-label'))!)
})

test('native caption buttons and double-click control the application window', async ({ page }) => {
  await mockBackend(page)
  await page.addInitScript(() => {
    Object.assign(window, {
      __MUGI_DESKTOP__: { webSocketBase: 'ws://127.0.0.1:54321/test-token' },
    })
  })
  // Vite's development runtime import is replaced with a native-window mock.
  await page.route(/@wailsio_runtime\.js/, (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.nativeCalls = [];
        let maximised = false;
        export const Window = {
          IsMaximised: async () => maximised,
          Minimise: async () => window.nativeCalls.push('minimise'),
          Maximise: async () => { maximised = true; window.nativeCalls.push('maximise'); },
          UnMaximise: async () => { maximised = false; window.nativeCalls.push('restore'); },
          Close: async () => window.nativeCalls.push('close'),
        };
      `,
    }),
  )
  await page.goto('/')
  const calls = () =>
    page.evaluate(() => (window as unknown as { nativeCalls: string[] }).nativeCalls)
  const minimise = page.getByRole('button', { name: '最小化应用', exact: true })
  await expect(minimise).toBeEnabled()
  const socketURL = await page.evaluate(async () => {
    const modulePath = '/src/services/api.ts'
    const { wsURL } = await import(modulePath)
    return wsURL('session#1', 'video')
  })
  expect(socketURL).toBe('ws://127.0.0.1:54321/test-token/ws/sessions/session%231/video')
  await minimise.click()
  await page.getByRole('button', { name: '最大化应用', exact: true }).click()
  await expect(page.getByRole('button', { name: '还原应用窗口' })).toBeVisible()
  await page.getByRole('button', { name: '还原应用窗口' }).click()
  await page.locator('.desktop-header').dispatchEvent('dblclick')
  await expect.poll(calls).toEqual(['minimise', 'maximise', 'restore', 'maximise'])
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await expect(page.getByRole('button', { name: '还原应用窗口' })).toBeVisible()
  await page.getByRole('button', { name: '关闭应用', exact: true }).click()
  await expect.poll(calls).toEqual(['minimise', 'maximise', 'restore', 'maximise', 'close'])

  const dragRegion = await page
    .locator('.desktop-header')
    .evaluate((element) => getComputedStyle(element).getPropertyValue('--wails-draggable').trim())
  const buttonRegion = await minimise.evaluate((element) =>
    getComputedStyle(element).getPropertyValue('--wails-draggable').trim(),
  )
  expect(dragRegion).toBe('drag')
  expect(buttonRegion).toBe('no-drag')
  await page.getByRole('button', { name: '打开应用启动器', exact: true }).dblclick()
  await expect.poll(calls).toEqual(['minimise', 'maximise', 'restore', 'maximise', 'close'])
})
