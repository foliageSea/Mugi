export function contentWidthFromDrag(startWidth, startHeight, ratio, deltaX, deltaY) {
  const fromHorizontal = startWidth + deltaX
  const fromVertical = (startHeight + deltaY) * ratio
  return Math.abs(deltaX) >= Math.abs(deltaY * ratio) ? fromHorizontal : fromVertical
}

export function displaySizeForDevice(width, height, maxLongSide = 1600) {
  if (
    ![width, height, maxLongSide].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    maxLongSide <= 0
  )
    return { width: 900, height: 1600 }

  const scale = maxLongSide / Math.max(width, height)
  const even = (value) => Math.max(2, Math.round(value / 2) * 2)
  return { width: even(width * scale), height: even(height * scale) }
}

export function aspectWindowSize({
  ratio,
  contentWidth,
  chromeWidth,
  chromeHeight,
  maxOuterWidth,
  maxOuterHeight,
  minContentWidth = 220,
  minContentHeight = 180,
}) {
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('invalid aspect ratio')

  const minWidth = Math.max(minContentWidth, minContentHeight * ratio)
  const maxWidth = Math.max(
    80,
    Math.min(maxOuterWidth - chromeWidth, (maxOuterHeight - chromeHeight) * ratio),
  )
  const effectiveMin = Math.min(minWidth, maxWidth)
  const width = Math.max(effectiveMin, Math.min(contentWidth, maxWidth))

  return {
    width: Math.round(width + chromeWidth),
    height: Math.round(width / ratio + chromeHeight),
  }
}
