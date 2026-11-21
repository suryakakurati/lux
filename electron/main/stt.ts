import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Settings } from '../../shared/types'
import { exec, findBinary, type ExecResult } from './mac/exec'
import { expandHome } from './mac/stats'

export interface TranscriptionResult {
  text: string
  engine: string
  ms: number
}

interface EngineAvailability {
  engine: 'whisper-cli' | 'cli' | 'mlx'
  command: string
  modelPath?: string
}

/**
 * Speech to text, fully local.
 *
 * Preference order:
 *  1. whisper.cpp `whisper-cli` (fastest; needs a ggml model on disk)
 *  2. OpenAI `whisper` CLI (already usable when installed via pip/brew)
 *  3. A python venv with mlx-whisper, created by scripts/setup-stt.sh
 */
export class Transcriber {
  private cached: EngineAvailability | null | undefined

  constructor(private readonly settings: () => Settings) {}

  invalidate(): void {
    this.cached = undefined
  }

  async engine(): Promise<EngineAvailability | null> {
    if (this.cached !== undefined) return this.cached
    this.cached = await this.detect()
    return this.cached
  }

  private async detect(): Promise<EngineAvailability | null> {
    const config = this.settings()
    if (config.sttEngine !== 'cli' && config.sttEngine !== 'mlx') {
      const cpp = findBinary('whisper-cli')
      if (cpp) {
        const model = await this.findWhisperCppModel(config.sttModel)
        if (model) return { engine: 'whisper-cli', command: cpp, modelPath: model }
      }
    }
    if (config.sttEngine !== 'mlx') {
      const cli = findBinary('whisper')
      if (cli) return { engine: 'cli', command: cli }
    }
    const venvPython = join(expandHome('~/.cache/lux/stt-venv'), 'bin', 'python')
    if (await this.fileExists(venvPython)) {
      return { engine: 'mlx', command: venvPython, modelPath: join(expandHome('~/.cache/lux'), 'stt_worker.py') }
    }
    return null
  }

  private async fileExists(path: string): Promise<boolean> {
    const result = await exec('/bin/test', ['-f', path], { timeout: 1_500 })
    return result.code === 0
  }

  private async findWhisperCppModel(modelName: string): Promise<string | null> {
    const registry = expandHome('~/.cache/lux/whisper')
    const name = modelName.replace(/\.en$/, '.en')
    const candidates = [
      join(registry, `ggml-${name}.bin`),
      `/opt/homebrew/share/whisper-cpp/models/ggml-${name}.bin`,
      `/usr/local/share/whisper-cpp/models/ggml-${name}.bin`,
      expandHome(`~/.cache/whisper/ggml-${name}.bin`)
    ]
    for (const candidate of candidates) {
      if (await this.fileExists(candidate)) return candidate
    }
    return null
  }

  async transcribe(wav: Buffer): Promise<TranscriptionResult> {
    const started = Date.now()
    const engine = await this.engine()
    if (!engine) {
      throw new Error(
        'No local speech engine found. Install whisper.cpp (`brew install whisper.cpp`) or set up mlx-whisper with scripts/setup-stt.sh.'
      )
    }

    const workDir = join(tmpdir(), `lux-stt-${Date.now()}`)
    mkdirSync(workDir, { recursive: true })
    const wavPath = join(workDir, 'input.wav')
    writeFileSync(wavPath, wav)

    try {
      let text = ''
      if (engine.engine === 'whisper-cli') {
        const result = await exec(
          engine.command,
          ['-m', engine.modelPath ?? '', '-f', wavPath, '-nt', '-l', 'en', '-t', '4'],
          { timeout: 90_000 }
        )
        if (result.code !== 0) throw new Error(`whisper.cpp could not read the recording: ${failure(result)}`)
        text = result.stdout
      } else if (engine.engine === 'cli') {
        const model = (this.settings().sttModel || 'base.en').replace(/^whisper-/, '')
        const result = await exec(
          engine.command,
          [wavPath, '--model', model, '--language', 'en', '--task', 'transcribe', '--output_format', 'txt', '--output_dir', workDir, '--fp16', 'False', '--verbose', 'False'],
          { timeout: 180_000 }
        )
        const txtPath = join(workDir, 'input.txt')
        if (result.code !== 0 || !existsSync(txtPath)) {
          throw new Error(`Whisper could not read the recording: ${failure(result)}`)
        }
        text = readFileSync(txtPath, 'utf8')
      } else {
        const result = await exec(engine.command, [engine.modelPath ?? '', wavPath], {
          timeout: 120_000
        })
        if (result.code !== 0) throw new Error(`whisper could not read the recording: ${failure(result)}`)
        text = result.stdout
      }

      return { text: cleanTranscript(text), engine: engine.engine, ms: Date.now() - started }
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        /* temp cleanup is best-effort */
      }
    }
  }
}

/**
 * The last useful stderr lines. Whisper writes progress bars and, on failure, a
 * traceback; without this the chat showed either a wall of text or the raw
 * stderr — which used to be returned as if it were the person's own words.
 */
function failure(result: ExecResult): string {
  if (result.timedOut) return 'the engine timed out'
  const lines = (result.stderr || result.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('%|'))
  const detail = lines.slice(-2).join(' ')
  return detail.slice(0, 200) || 'the engine exited with an error'
}

const NOISE = /^\[(blank_audio|silence|music|applause|inaudible)\]$/i

export function cleanTranscript(raw: string): string {
  const withoutTimestamps = raw
    .replace(/^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/gm, '')
    .replace(/\[[\d:]{2,}[\d:.,]*\s*-->\s*[\d:.,]+\]/g, '')
  return withoutTimestamps
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !NOISE.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}
