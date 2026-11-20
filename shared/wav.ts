/**
 * Minimal, dependency-free WAV encoder for Whisper input.
 *
 * Whisper models are trained on 16 kHz mono audio, and every CLI path we shell
 * out to expects a RIFF/WAVE file. We build it here instead of shipping ffmpeg.
 */

export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, input[i] ?? 0))
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return out
}

export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const pcm = floatToPcm16(samples)
  const buffer = new ArrayBuffer(44 + pcm.byteLength)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(view, 36, 'data')
  view.setUint32(40, pcm.byteLength, true)

  new Int16Array(buffer, 44).set(pcm)
  return buffer
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}

/** Peak-normalise a recording so quiet speech still transcribes well. */
export function normalise(input: Float32Array, target = 0.9): Float32Array {
  let peak = 0
  for (let i = 0; i < input.length; i += 1) {
    const abs = Math.abs(input[i] ?? 0)
    if (abs > peak) peak = abs
  }
  if (peak < 0.02 || peak >= target) return input
  const gain = target / peak
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i += 1) out[i] = (input[i] ?? 0) * gain
  return out
}

/** Root-mean-square level, used for the HUD waveform and silence detection. */
export function rms(input: Float32Array): number {
  if (input.length === 0) return 0
  let sum = 0
  for (let i = 0; i < input.length; i += 1) {
    const v = input[i] ?? 0
    sum += v * v
  }
  return Math.sqrt(sum / input.length)
}
