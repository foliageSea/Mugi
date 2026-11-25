// Browser KeyboardEvent.code -> Android keycode mapping.
// Reference: android/view/KeyEvent.java

export const KEYCODE = {
  BACK: 4,
  HOME: 3,
  MENU: 82,
  APP_SWITCH: 187,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  SLEEP: 223,
  WAKEUP: 224,
  TAB: 61,
  SPACE: 62,
  ENTER: 66,
  DEL: 67,
  ESCAPE: 111,
  FORWARD_DEL: 112,
  MOVE_HOME: 122,
  MOVE_END: 123,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  CTRL_LEFT: 113,
  CTRL_RIGHT: 114,
  META_LEFT: 117,
  META_RIGHT: 118,
}

export const META = {
  SHIFT_ON: 0x1,
  SHIFT_LEFT_ON: 0x40,
  SHIFT_RIGHT_ON: 0x80,
  ALT_ON: 0x2,
  ALT_LEFT_ON: 0x10,
  ALT_RIGHT_ON: 0x20,
  CTRL_ON: 0x1000,
  CTRL_LEFT_ON: 0x2000,
  CTRL_RIGHT_ON: 0x4000,
  META_ON: 0x10000,
  META_LEFT_ON: 0x40000,
  META_RIGHT_ON: 0x80000,
  CAPS_LOCK_ON: 0x100000,
}

const codeMap = {
  Backquote: 68,
  Minus: 69,
  Equal: 70,
  BracketLeft: 71,
  BracketRight: 72,
  Backslash: 73,
  Semicolon: 74,
  Quote: 75,
  Comma: 55,
  Period: 56,
  Slash: 76,
  Enter: 66,
  Backspace: 67,
  Space: 62,
  Tab: 61,
  Escape: 111,
  Delete: 112,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  ControlLeft: 113,
  ControlRight: 114,
  ShiftLeft: 59,
  ShiftRight: 60,
  AltLeft: 57,
  AltRight: 58,
  MetaLeft: 117,
  MetaRight: 118,
  F1: 131,
  F2: 132,
  F3: 133,
  F4: 134,
  F5: 135,
  F6: 136,
  F7: 137,
  F8: 138,
  F9: 139,
  F10: 140,
  F11: 141,
  F12: 142,
  Numpad0: 144,
  Numpad1: 145,
  Numpad2: 146,
  Numpad3: 147,
  Numpad4: 148,
  Numpad5: 149,
  Numpad6: 150,
  Numpad7: 151,
  Numpad8: 152,
  Numpad9: 153,
  NumpadAdd: 157,
  NumpadSubtract: 156,
  NumpadMultiply: 155,
  NumpadDivide: 154,
  NumpadDecimal: 158,
  NumpadEnter: 160,
}

for (let i = 0; i < 10; i++) codeMap['Digit' + i] = 7 + i
for (let i = 0; i < 26; i++) codeMap['Key' + String.fromCharCode(65 + i)] = 29 + i

export function androidKeycode(code) {
  return codeMap[code] || 0
}

export function metastateOf(e) {
  let m = 0
  if (e.shiftKey)
    m |= META.SHIFT_ON | (e.code === 'ShiftRight' ? META.SHIFT_RIGHT_ON : META.SHIFT_LEFT_ON)
  if (e.altKey) m |= META.ALT_ON | (e.code === 'AltRight' ? META.ALT_RIGHT_ON : META.ALT_LEFT_ON)
  if (e.ctrlKey)
    m |= META.CTRL_ON | (e.code === 'ControlRight' ? META.CTRL_RIGHT_ON : META.CTRL_LEFT_ON)
  if (e.metaKey)
    m |= META.META_ON | (e.code === 'MetaRight' ? META.META_RIGHT_ON : META.META_LEFT_ON)
  if (e.getModifierState && e.getModifierState('CapsLock')) m |= META.CAPS_LOCK_ON
  return m
}
