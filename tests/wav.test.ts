import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeWav, floatToPcm16, normalise, rms } from '../shared/wav.ts'

test('writes a valid 16 kHz mono PCM header', () => {
  const samples = new Float32Array(1600)
  const buffer = encodeWav(samples, 16_000)
  const view = new DataView(buffer)
  const ascii = (offset: number, length: number): string =>
    String.fromCharCode(...new Uint8Array(buffer, offset, length))

  assert.equal(ascii(0, 4), 'RIFF')
  assert.equal(ascii(8, 4), 'WAVE')
  assert.equal(ascii(12, 4), 'fmt ')
  assert.equal(ascii(36, 4), 'data')
  assert.equal(view.getUint16(20, true), 1) // PCM
  assert.equal(view.getUint16(22, true), 1) // mono
  assert.equal(view.getUint32(24, true), 16_000)
  assert.equal(view.getUint32(28, true), 32_000) // byte rate
  assert.equal(view.getUint16(34, true), 16) // bits
  assert.equal(view.getUint32(40, true), 3200)
  assert.equal(buffer.byteLength, 44 + 3200)
})

test('clamps samples instead of wrapping', () => {
  const pcm = floatToPcm16(new Float32Array([2, -2, 0.5, -0.5]))
  assert.equal(pcm[0], 32767)
  assert.equal(pcm[1], -32768)
  assert.equal(pcm[2], 16383)
})

test('normalise lifts quiet speech without touching silence', () => {
  const quiet = new Float32Array([0.1, -0.1, 0.05])
  const boosted = normalise(quiet, 0.9)
  assert.ok(Math.abs(Math.max(...boosted) - 0.9) < 1e-6)
  const silence = new Float32Array([0, 0, 0])
  assert.equal(normalise(silence), silence)
})

test('rms reports energy', () => {
  assert.equal(rms(new Float32Array([0, 0])), 0)
  assert.ok(rms(new Float32Array([0.5, -0.5])) > 0.49)
})
