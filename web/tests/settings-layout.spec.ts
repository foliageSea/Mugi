import { test, expect } from '@playwright/test'

test.use({ reducedMotion: 'reduce' })

test('Dock defaults to the left and remembers its selected edge', async ({ page }) => {
  await page.goto('/?transport=webusb')
  const dock = page.locator('.desktop-actions')
  const settings = page.getByRole('button', { name: '设置', exact: true })
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  const position = dialog.getByRole('combobox', { name: 'Dock 位置', exact: true })
  const list = page.getByRole('listbox')
  const viewport = page.viewportSize()!

  await expect(dock).toHaveAttribute('data-position', 'left')
  const left = (await dock.boundingBox())!
  expect(left.x).toBeLessThan(32)
  expect(left.height).toBeGreaterThan(left.width)

  await settings.click()
  await expect(position).toHaveText('左侧')
  await position.click()
  await list.getByRole('option', { name: '右侧', exact: true }).click()
  await expect(list).toBeHidden()
  await expect(position).toHaveText('右侧')
  await expect(position).toBeFocused()
  await expect(dock).toHaveAttribute('data-position', 'right')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  const right = (await dock.boundingBox())!
  expect(viewport.width - (right.x + right.width)).toBeLessThan(32)
  expect(right.height).toBeGreaterThan(right.width)

  await page.reload()
  await expect(dock).toHaveAttribute('data-position', 'right')
  await settings.click()
  await expect(position).toHaveText('右侧')
  await position.press('Enter')
  await expect(list.getByRole('option', { name: '右侧', selected: true })).toBeFocused()
  await page.keyboard.press('ArrowUp')
  const bottomOption = list.getByRole('option', { name: '底部', exact: true })
  await expect(bottomOption).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(list).toBeHidden()
  await expect(position).toBeFocused()
  await expect(position).toHaveText('右侧')
  await expect(dock).toHaveAttribute('data-position', 'right')

  await position.press('Enter')
  await expect(list.getByRole('option', { name: '右侧', selected: true })).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(bottomOption).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(list).toBeHidden()
  await expect(position).toHaveText('底部')
  await expect(position).toBeFocused()
  await expect(dock).toHaveAttribute('data-position', 'bottom')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  const bottom = (await dock.boundingBox())!
  expect(viewport.height - (bottom.y + bottom.height)).toBeLessThan(48)
  expect(bottom.width).toBeGreaterThan(bottom.height)

  await page.reload()
  await expect(dock).toHaveAttribute('data-position', 'bottom')
  await settings.click()
  await expect(position).toHaveText('底部')
})

test('vertical Dock scrolls to the last icon in a short viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 360 })
  await page.goto('/?transport=webusb')
  const dock = page.getByRole('navigation', { name: '工作区操作' })
  const track = dock.locator('.dock-track')
  const last = dock.getByRole('button', { name: 'Logcat', exact: true })
  await last.scrollIntoViewIfNeeded()
  await expect(last).toBeInViewport({ ratio: 1 })
  expect(await track.evaluate((track) => track.scrollTop)).toBeGreaterThan(0)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Dock 位置' })).toHaveText('左侧')
})

test('cast settings fall back per field when saved values are invalid', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'mugi.cast-settings',
      JSON.stringify({ maxSize: 1440, maxFps: '60', bitRateMbps: 99 }),
    )
  })
  await page.goto('/?transport=webusb')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const cast = page.getByRole('region', { name: '投屏参数', exact: true })
  await expect(cast.getByRole('combobox', { name: '镜像最大长边' })).toHaveText('1440 px')
  await expect(cast.getByRole('combobox', { name: '最高帧率' })).toHaveText('不限')
  await expect(cast.getByRole('combobox', { name: '视频码率' })).toHaveText('8 Mbps')
})

test('settings keep labels left and controls right at desktop and 320px without overflow', async ({
  page,
}, testInfo) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).pathname === '/api/capabilities'
          ? { network: 'local', adbAllowed: true, webusbAllowed: true }
          : { devices: [], sessions: [] },
    }),
  )

  for (const width of [1200, 320]) {
    await test.step(`at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/')
      await page.getByRole('button', { name: '设置', exact: true }).click()

      const dialog = page.getByRole('dialog', { name: '设置', exact: true })
      await expect(dialog).toBeVisible()
      const appearance = dialog.getByRole('group', { name: '外观', exact: true })
      const device = dialog.getByRole('group', { name: '设备偏好', exact: true })
      const cast = dialog.getByRole('region', { name: '投屏参数', exact: true })
      const castBox = (await cast.boundingBox())!
      const dialogBox = (await dialog.boundingBox())!
      const appearanceBox = (await appearance.boundingBox())!
      const deviceBox = (await device.boundingBox())!
      expect(dialogBox.x).toBeGreaterThanOrEqual(0)
      expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(width)
      expect(deviceBox.y).toBeGreaterThan(appearanceBox.y + appearanceBox.height)
      expect(castBox.y).toBeGreaterThan(deviceBox.y + deviceBox.height)
      await expect(dialog.getByText('外观', { exact: true })).toBeHidden()
      await expect(dialog.getByText('设备偏好', { exact: true })).toBeHidden()

      const rows = [
        { group: appearance, label: '亮色模式', role: 'switch' },
        { group: appearance, label: '窗口按钮样式', role: 'group' },
        { group: appearance, label: 'Dock 位置', role: 'combobox' },
        { group: device, label: '默认转发设备音频', role: 'switch' },
        { group: device, label: '自动息屏', role: 'switch' },
        { group: cast, label: '镜像最大长边', role: 'combobox' },
        { group: cast, label: '最高帧率', role: 'combobox' },
        { group: cast, label: '视频码率', role: 'combobox' },
        { group: cast, label: '显示投屏性能指标', role: 'switch' },
      ] as const
      const labelEdges: number[] = []
      const controlEdges: number[] = []
      for (const { group, label, role } of rows) {
        await test.step(label, async () => {
          const row = group.locator('.settings-row').filter({
            has: page.getByText(label, { exact: true }),
          })
          const labelText = row.getByText(label, { exact: true })
          const control = row.getByRole(role, { name: label, exact: true })
          await expect(labelText).toBeVisible()
          await expect(control).toBeVisible()

          const rowBox = (await row.boundingBox())!
          const labelBox = (await labelText.boundingBox())!
          const controlBox = (await control.boundingBox())!
          const controlRight = controlBox.x + controlBox.width
          expect(rowBox.x).toBeGreaterThanOrEqual(dialogBox.x)
          expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width)
          expect(labelBox.x).toBeGreaterThanOrEqual(rowBox.x)
          expect(labelBox.x + labelBox.width).toBeLessThan(controlBox.x)
          expect(controlRight).toBeLessThanOrEqual(rowBox.x + rowBox.width)
          expect(
            Math.min(labelBox.y + labelBox.height, controlBox.y + controlBox.height),
          ).toBeGreaterThan(Math.max(labelBox.y, controlBox.y))
          labelEdges.push(labelBox.x)
          controlEdges.push(controlRight)
        })
      }
      expect(Math.max(...labelEdges) - Math.min(...labelEdges)).toBeLessThanOrEqual(1)
      expect(Math.max(...controlEdges) - Math.min(...controlEdges)).toBeLessThanOrEqual(1)
      expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0)
      await expect(page.locator('body')).toHaveJSProperty('scrollWidth', width)

      if (process.env.MUGI_CAPTURE_SETTINGS) {
        await page.screenshot({
          path: testInfo.outputPath(`settings-${width}.png`),
          animations: 'disabled',
        })
      }

      const windowStyle = appearance.getByRole('group', { name: '窗口按钮样式', exact: true })
      await windowStyle.getByRole('button', { name: 'Mac', exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem('mugi.window-controls')))
        .toBe('mac')
      await windowStyle.getByRole('button', { name: 'Windows', exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem('mugi.window-controls')))
        .toBe('windows')

      const fps = cast.getByRole('combobox', { name: '最高帧率', exact: true })
      await fps.focus()
      await page.keyboard.press('Enter')
      const list = page.getByRole('listbox')
      await expect(list).toBeVisible()
      await expect(list.getByRole('option', { name: '不限', exact: true })).toBeFocused()
      if (process.env.MUGI_CAPTURE_SETTINGS) {
        await page.screenshot({
          path: testInfo.outputPath(`settings-select-${width}.png`),
          animations: 'disabled',
        })
      }
      await page.keyboard.press('ArrowDown')
      await expect(list.getByRole('option', { name: '30 fps', exact: true })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(list).toBeHidden()
      await expect(fps).toBeFocused()
      await expect(fps).toHaveText('30 fps')
      await cast.getByRole('button', { name: '恢复默认' }).click()
      await expect(fps).toHaveText('不限')

      for (const { label, role } of rows) {
        if (role !== 'switch') continue
        const toggle = dialog.getByRole('switch', { name: label, exact: true })
        const checked = await toggle.getAttribute('aria-checked')
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-checked', checked === 'true' ? 'false' : 'true')
        await expect(toggle).toBeFocused()
        await page.keyboard.press('Space')
        await expect(toggle).toHaveAttribute('aria-checked', checked!)
      }
    })
  }
})
