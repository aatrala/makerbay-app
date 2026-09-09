import { describe, expect, it } from 'vitest'
import { deviceLabel } from './passkeys'

describe('deviceLabel', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
  const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36'

  it('prefers a known authenticator make', () => {
    expect(deviceLabel('08987058-cadc-4b81-b6e1-30de50dcbe96', WINDOWS)).toBe('Windows Hello')
  })

  it('falls back to the device when the make is anonymous', () => {
    expect(deviceLabel('00000000-0000-0000-0000-000000000000', IPHONE)).toBe('iPhone')
    expect(deviceLabel(undefined, ANDROID)).toBe('Android phone')
    expect(deviceLabel(undefined, WINDOWS)).toBe('Windows PC')
    expect(deviceLabel(undefined, null)).toBe('This device')
  })
})
