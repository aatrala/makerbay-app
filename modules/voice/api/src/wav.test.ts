import { describe, expect, it } from 'vitest'
import { wavFromPcm } from './handler'

describe('wavFromPcm', () => {
  // Chime PlayAudio is strict about the container; a malformed header fails
  // silently as a dead-air greeting, which a tradie would never diagnose.
  it('writes a valid 44-byte header for 8kHz mono 16-bit PCM', () => {
    const pcm = Buffer.alloc(1600) // 100ms of silence
    const wav = wavFromPcm(pcm, 8000)
    expect(wav.length).toBe(44 + 1600)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(4)).toBe(36 + 1600)
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(8000)
    expect(wav.readUInt32LE(28)).toBe(16000) // byte rate
    expect(wav.readUInt16LE(34)).toBe(16) // bit depth
    expect(wav.readUInt32LE(40)).toBe(1600)
  })

  it('handles empty audio without corrupting the header', () => {
    const wav = wavFromPcm(Buffer.alloc(0), 8000)
    expect(wav.length).toBe(44)
    expect(wav.readUInt32LE(40)).toBe(0)
  })
})
