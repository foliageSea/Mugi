import { test, expect, type Page } from '@playwright/test'

async function backend(page: Page, native: boolean) {
  const state = {
    adbPath: '',
    activePath: '',
    startupError: 'cannot find adb',
    restartRequired: false,
  }
  const saved: string[] = []
  let reads = 0
  if (native) {
    await page.addInitScript(() => {
      Object.assign(window, {
        __MUGI_DESKTOP__: { webSocketBase: 'ws://127.0.0.1:54321/token' },
      })
    })
    await page.route(/@wailsio_runtime\.js/, (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: 'export const Window = { IsMaximised: async () => false };',
      }),
    )
  }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/desktop/adb') {
      if (request.method() === 'GET') reads++
      else {
        const value = request.postDataJSON().adbPath as string
        if (value === '/invalid/adb') {
          await route.fulfill({ status: 400, json: { error: 'ADB 路径不可用' } })
          return
        }
        state.adbPath = value
        state.restartRequired = value !== ''
        saved.push(value)
      }
      await route.fulfill({ json: state })
      return
    }
    await route.fulfill({
      json:
        path === '/api/capabilities'
          ? { network: 'local', adbAllowed: true, webusbAllowed: true }
          : { devices: [], sessions: [] },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  return { saved, reads: () => reads }
}

test('native settings save the ADB path, report errors and restore automatic discovery', async ({
  page,
}) => {
  const state = await backend(page, true)
  const path = page.getByRole('textbox', { name: 'ADB 可执行文件路径' })
  await expect(path).toBeEnabled()
  await expect(page.getByText('当前未找到可用的 ADB，请配置正确路径并重启应用。')).toBeVisible()
  await path.fill('/invalid/adb')
  await page.getByRole('button', { name: '校验并保存' }).click()
  await expect(page.getByRole('alert')).toHaveText('ADB 路径不可用')
  expect(state.saved).toEqual([])

  await path.fill('/opt/homebrew/bin/adb')
  await path.press('Enter')
  await expect(page.getByRole('status')).toHaveText(
    '已保存，请完全退出并重新打开 mugi 后生效。',
  )
  expect(state.saved).toEqual(['/opt/homebrew/bin/adb'])
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(path).toHaveValue('/opt/homebrew/bin/adb')
  await expect(page.getByRole('status')).toContainText('请完全退出并重新打开')
  expect(state.reads()).toBe(2)

  await page.getByRole('button', { name: '恢复自动查找' }).click()
  await expect(path).toHaveValue('')
  expect(state.saved).toEqual(['/opt/homebrew/bin/adb', ''])
})

test('browser settings do not show or request desktop ADB configuration', async ({ page }) => {
  const state = await backend(page, false)
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'ADB 可执行文件路径' })).toHaveCount(0)
  expect(state.reads()).toBe(0)
})
