import { encodeWav, normalise, rms } from '../../shared/wav'

/**
 * Microphone capture for Whisper.
 *
 * We record through an AudioWorklet at 16 kHz so Chromium's own resampler does
 * the 48k → 16k conversion, and encode a 16-bit mono WAV in the renderer. No
 * ffmpeg, no lossy opus stage, and the stream stays alive between utterances so
 * a hold-to-talk press starts instantly.
 */

const WORKLET_SOURCE = `
class LuxPcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length) this.port.postMessage(new Float32Array(channel))
    return true
  }
}
registerProcessor('lux-pcm-tap', LuxPcmTap)
`

export interface CaptureResult {
  wav: ArrayBuffer
  durationMs: number
  peak: number
}

export class VoiceRecorder {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private chunks: Float32Array[] = []
  private recording = false
  private peak = 0
  private stopTimer: number | null = null

  onLevel: ((level: number) => void) | null = null
  onAutoStop: (() => void) | null = null

  get active(): boolean {
    return this.recording
  }

  get ready(): boolean {
    return Boolean(this.context && this.stream)
  }

  async prime(): Promise<boolean> {
    if (this.ready) {
      if (this.context?.state === 'suspended') await this.context.resume().catch(() => undefined)
      return true
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        },
        video: false
      })
      const context = new AudioContext({ sampleRate: 16_000 })
      const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
      try {
        await context.audioWorklet.addModule(moduleUrl)
      } finally {
        URL.revokeObjectURL(moduleUrl)
      }

      const source = context.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(context, 'lux-pcm-tap', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit'
      })
      const sink = context.createGain()
      sink.gain.value = 0
      node.port.onmessage = (event: MessageEvent<Float32Array>) => this.collect(event.data)
      source.connect(node).connect(sink).connect(context.destination)

      this.stream = stream
      this.context = context
      this.node = node
      return true
    } catch (error) {
      console.warn('[recorder] microphone unavailable', error)
      return false
    }
  }

  async start(): Promise<boolean> {
    const ok = await this.prime()
    if (!ok) return false
    this.chunks = []
    this.peak = 0
    this.recording = true
    await this.context?.resume().catch(() => undefined)
    if (this.stopTimer) window.clearTimeout(this.stopTimer)
    this.stopTimer = window.setTimeout(() => {
      this.onAutoStop?.()
    }, 30_000)
    return true
  }

  stop(): CaptureResult | null {
    this.recording = false
    if (this.stopTimer) window.clearTimeout(this.stopTimer)
    this.stopTimer = null

    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    if (total < 1_600) return null

    const merged = new Float32Array(total)
    let offset = 0
    for (const chunk of this.chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    this.chunks = []

    const sampleRate = this.context?.sampleRate ?? 16_000
    const wav = encodeWav(normalise(merged), sampleRate)
    return {
      wav,
      durationMs: Math.round((total / sampleRate) * 1000),
      peak: this.peak
    }
  }

  setLevelReporter(callback: ((level: number) => void) | null): void {
    this.onLevel = callback
  }

  dispose(): void {
    this.recording = false
    if (this.stopTimer) window.clearTimeout(this.stopTimer)
    this.stopTimer = null
    try {
      this.node?.port.close()
      this.node?.disconnect()
      this.stream?.getTracks().forEach((track) => track.stop())
      void this.context?.close()
    } catch {
      /* teardown is best-effort */
    }
    this.node = null
    this.stream = null
    this.context = null
  }

  private collect(samples: Float32Array): void {
    if (!this.recording) return
    this.chunks.push(samples)
    const level = rms(samples)
    if (level > this.peak) this.peak = level
    this.onLevel?.(Math.min(1, level * 6))
  }
}
