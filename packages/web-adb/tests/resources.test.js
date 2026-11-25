import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { definitions, infoCommand, metricsCommand } from '../dist/resources.js'
import { SERVER_VERSION } from '../dist/helpers.js'
import { LOGCAT_COMMAND, CLEAR_LOGCAT_COMMAND, LOGCAT_PROCESSES_COMMAND } from '../dist/index.js'

const root = new URL('../', import.meta.url)
const read = (path) => readFile(new URL(path, root))

test('bundled commands and server match their package sources', async () => {
  assert.deepEqual(definitions, JSON.parse(await read('assets/operations.json')))
  assert.equal(infoCommand, (await read('assets/device-info.sh')).toString())
  assert.equal(metricsCommand, (await read('assets/metrics.sh')).toString())
  const binary = await read('dist/assets/scrcpy-server.bin')
  const digest = createHash('sha256').update(binary).digest('hex')
  assert.equal(digest, (await read('assets/SHA256SUMS.txt')).toString().trim().split(/\s+/)[0])
  assert.equal(binary.subarray(0, 2).toString(), 'PK')
  assert.match(
    (await read('NOTICE')).toString(),
    new RegExp(`v${SERVER_VERSION.replaceAll('.', '\\.')}`),
  )
})

test('shared Go and SDK resources stay in sync in the monorepo', async (t) => {
  // A standalone checkout of the package does not require Go sources.
  try {
    await access(new URL('../../internal/adb/', root))
  } catch {
    t.skip('standalone package')
    return
  }
  for (const path of ['operations.json', 'device-info.sh', 'metrics.sh']) {
    assert.deepEqual(await read(`assets/${path}`), await read(`../../internal/adb/${path}`), path)
  }
  assert.deepEqual(
    await read('assets/scrcpy-server.bin'),
    await read('../../internal/scrcpy/scrcpy-server.bin'),
  )
  assert.deepEqual(
    await read('assets/SHA256SUMS.txt'),
    await read('../../internal/scrcpy/SHA256SUMS.txt'),
  )
  const logcat = (await read('../../internal/adb/logcat.go')).toString()
  for (const command of [LOGCAT_COMMAND, CLEAR_LOGCAT_COMMAND, LOGCAT_PROCESSES_COMMAND]) {
    assert.ok(logcat.includes(JSON.stringify(command)), command)
  }
})
