// Android's SystemUI uses the HLG curve for its perceptual brightness slider.
// https://android.googlesource.com/platform/frameworks/base/+/main/packages/SettingsLib/DisplayUtils/src/com/android/settingslib/display/BrightnessUtils.java
const R = 0.5
const A = 0.17883277
const B = 0.28466892
const C = 0.55991073
const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

export function brightnessPercent(value: number, min: number, max: number) {
  const normalized = 12 * clamp01((value - min) / (max - min))
  const gamma = normalized <= 1 ? Math.sqrt(normalized) * R : A * Math.log(normalized - B) + C
  return Math.round(clamp01(gamma) * 100)
}

export function linearBrightness(percent: number, min: number, max: number) {
  const gamma = clamp01(percent / 100)
  const normalized = gamma <= R ? (gamma / R) ** 2 : Math.exp((gamma - C) / A) + B
  return min + (max - min) * clamp01(normalized / 12)
}

export const displayBrightnessScale = 1_000_000
