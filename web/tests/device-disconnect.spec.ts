import { test, expect, type Page } from '@playwright/test'

const tcpSerial = '192.168.1.23:39521'
const usbSerial = 'usb-phone'

async function openDeviceDialog(
  page: Page,
  tcpState: 'device' | 'offline',
  disconnectFails = false,
) {
  let devices = [
    { serial: tcpSerial, model: 'WiFi_Phone', state: tcpState, network: true },
    { serial: usbSerial, model: 'USB_Phone', state: 'device' },
  ]
  const disconnectRequests: { method: string; body: unknown }[] = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const { pathname } = new URL(request.url())
    if (pathname === '/api/capabilities') {
      return route.fulfill({ json: { network: 'local', adbAllowed: true, webusbAllowed: true } })
    }
    if (pathname === '/api/devices') return route.fulfill({ json: { devices } })
    if (pathname === '/api/devices/disconnect') {
      const body = request.postDataJSON() as { serial: string }
      disconnectRequests.push({ method: request.method(), body })
      if (disconnectFails) {
        disconnectFails = false
        return route.fulfill({ status: 500, json: { error: 'ADB disconnect failed' } })
      }
      devices = devices.filter((device) => device.serial !== body.serial)
      return route.fulfill({ json: { ok: true } })
    }
    return route.fulfill({ json: {} })
  })
  await page.goto('/')
  const trigger = page.locator('.device-trigger')
  await expect(trigger).toContainText(tcpState === 'device' ? 'WiFi Phone' : 'USB Phone')
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '你的手机', exact: true })
  await expect(dialog.getByRole('button', { name: '重新扫描', exact: true })).toBeEnabled()
  const tcpRow = dialog.locator('.device-row').filter({ hasText: tcpSerial })
  const usbRow = dialog.locator('.device-row').filter({ hasText: usbSerial })
  return { dialog, trigger, tcpRow, usbRow, disconnectRequests }
}

test('disconnecting the selected TCP ADB device leaves physical USB selected', async ({ page }) => {
  const { dialog, trigger, tcpRow, usbRow, disconnectRequests } = await openDeviceDialog(
    page,
    'device',
  )
  await expect(tcpRow.getByRole('button', { name: '当前设备', exact: true })).toBeVisible()
  await expect(usbRow.getByRole('button', { name: '使用', exact: true })).toBeEnabled()
  await expect(usbRow.getByRole('button', { name: /断开/ })).toHaveCount(0)

  await tcpRow.getByRole('button', { name: /断开/ }).click()

  await expect(tcpRow).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await expect(usbRow.getByRole('button', { name: '当前设备', exact: true })).toBeVisible()
  await expect(trigger).toContainText('USB Phone')
  expect(disconnectRequests).toEqual([{ method: 'POST', body: { serial: tcpSerial } }])
})

test('offline TCP ADB devices can be disconnected and retried after an error', async ({ page }) => {
  const { dialog, tcpRow, usbRow, disconnectRequests } = await openDeviceDialog(
    page,
    'offline',
    true,
  )
  await expect(tcpRow).toContainText('离线')
  await expect(tcpRow.getByRole('button', { name: '使用', exact: true })).toBeDisabled()
  const disconnect = tcpRow.getByRole('button', { name: /断开/ })
  await expect(disconnect).toBeEnabled()
  await disconnect.click()

  const alert = dialog.getByRole('alert')
  await expect(alert).toContainText('ADB disconnect failed')
  await expect(tcpRow).toBeVisible()
  await expect(usbRow.getByRole('button', { name: '当前设备', exact: true })).toBeVisible()
  await disconnect.click()

  await expect(tcpRow).toHaveCount(0)
  await expect(alert).toHaveCount(0)
  expect(disconnectRequests).toEqual([
    { method: 'POST', body: { serial: tcpSerial } },
    { method: 'POST', body: { serial: tcpSerial } },
  ])
})
