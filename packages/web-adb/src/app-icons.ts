import { sha256Hex, shellQuote } from './helpers.js'

/** Returns the raw DEX with the dev.mugi.icons.Main entry point. */
export type AppIconSource = () => Promise<Uint8Array>

export const APP_ICON_DIRECTORY = '/data/local/tmp/mugi'
export const MAX_APP_ICON_BYTES = 256 << 10
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10]
const packageName = /^(?:[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+|android)$/
const helpers = new WeakMap<AppIconSource, Promise<{ bytes: Uint8Array; path: string }>>()

export function loadAppIconHelper(source: AppIconSource) {
  let helper = helpers.get(source)
  if (!helper) {
    helper = Promise.resolve()
      .then(source)
      .then(async (bytes) => {
        if (bytes.length < 112 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'dex\n')
          throw new Error('应用图标提取器无效')
        const digest = await sha256Hex(bytes)
        return { bytes, path: APP_ICON_DIRECTORY + '/app-icons-' + digest + '.dex' }
      })
      .catch((error) => {
        helpers.delete(source)
        throw error
      })
    helpers.set(source, helper)
  }
  return helper
}

export function validAppIconPackage(pkg: string) {
  return pkg.length <= 255 && packageName.test(pkg)
}

export function appIconCommand(path: string, pkg: string) {
  if (!validAppIconPackage(pkg)) throw new Error('应用包名无效')
  return (
    'CLASSPATH=' +
    shellQuote(path) +
    ' app_process /system/bin dev.mugi.icons.Main ' +
    shellQuote(pkg)
  )
}

export async function validateAppIcon(blob: Blob) {
  const bytes = await blob.slice(0, 33).arrayBuffer()
  const header = new Uint8Array(bytes)
  const view = new DataView(bytes)
  if (
    header.length !== 33 ||
    !pngSignature.every((byte, i) => header[i] === byte) ||
    view.getUint32(8) !== 13 ||
    view.getUint32(12) !== 0x49484452
  )
    throw new Error('设备未返回 PNG 应用图标')
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (!width || width > 128 || !height || height > 128) throw new Error('应用图标尺寸无效')
  if (typeof createImageBitmap === 'function') {
    // Verify the PNG is actually decodable before putting it in the persistent cache.
    const bitmap = await createImageBitmap(blob)
    bitmap.close()
  }
  return blob
}

/** Package manager exposes a long version code and a code path that normally changes on reinstall. */
export function parseAppIconVersions(output: string): Map<string, string> {
  const versions = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const match = /^package:(\/[^\r\n]+)=([^\s=]+)\s+versionCode:(\d+)\s*$/.exec(line)
    if (match && validAppIconPackage(match[2]!))
      versions.set(match[2]!, JSON.stringify([match[3], match[1]]))
  }
  return versions
}
