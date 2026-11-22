import type { Board } from '@/data/board'
import type { GenConstraints, GenEvent } from './types'
import { beginBoardGeneration } from './researchHandoff.ts'

export type { GenConstraints, GenEvent, GenStage } from './types'

export interface GenerateOptions {
  signal?: AbortSignal
  constraints?: GenConstraints
  /** defaults to /api/generate */
  endpoint?: string
}

/**
 * Ask the server to generate a board from a natural-language prompt.
 * Progress arrives as NDJSON events (forwarded to onEvent); resolves with the
 * board once the stream reports `done`. Rejects on an `error` event, a non-2xx
 * response, or abort (AbortError).
 */
export async function generateBoard(
  prompt: string,
  onEvent: (e: GenEvent) => void = () => {},
  opts: GenerateOptions = {},
): Promise<Board> {
  const generation = beginBoardGeneration(prompt)
  try { return await readGeneratedBoard(prompt, onEvent, opts, generation) }
  finally { generation.finish() }
}

async function readGeneratedBoard(
  prompt: string, onEvent: (e: GenEvent) => void, opts: GenerateOptions,
  generation: ReturnType<typeof beginBoardGeneration>,
): Promise<Board> {
  const res = await fetch(opts.endpoint ?? '/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson', ...keyHeader() },
    body: JSON.stringify({ prompt, constraints: opts.constraints, research: generation.reference }),
    signal: opts.signal,
  })
  if (!res.ok || !res.body) {
    let message = `Generation failed (${res.status})`
    try {
      const j = (await res.json()) as { message?: string }
      if (j.message) message = j.message
    } catch {
      /* not JSON */
    }
    throw new Error(message)
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  const onAbort = () => void reader.cancel().catch(() => {})
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  let buf = ''
  let board: Board | null = null
  let done = false

  const handle = (line: string) => {
    if (!line.trim()) return
    let e: GenEvent
    try {
      e = JSON.parse(line) as GenEvent
    } catch {
      throw new Error('Invalid generation response. The board was not accepted.')
    }
    generation.assertCurrent()
    if (!e || typeof e.type !== 'string' || done) throw new Error('Invalid generation event order')
    if (e.type === 'board') {
      if (board || !e.board) throw new Error('Invalid board response')
      const returnedHash = e.board.researchHandoff?.envelope.bundle_sha256
      if (returnedHash !== generation.reference?.bundleSha256) throw new Error('Generated board does not match the research handoff')
      board = e.board
    }
    else if (e.type === 'done') {
      if (!board) throw new Error('Server finished without a board')
      done = true
    }
    else if (e.type === 'error') throw new Error(e.message)
    onEvent(e)
  }

  try {
    for (;;) {
      const { value, done: eof } = await reader.read()
      if (opts.signal?.aborted) throw new DOMException('Generation aborted', 'AbortError')
      if (value) {
        buf += value
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          handle(buf.slice(0, nl))
          buf = buf.slice(nl + 1)
        }
      }
      if (eof) break
    }
    handle(buf)
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  if (opts.signal?.aborted) throw new DOMException('Generation aborted', 'AbortError')
  generation.assertCurrent()
  if (!done || !board) throw new Error('Connection closed before generation completed. The board was not accepted.')
  return board
}

const KEY_STORE = 'forge.geminiKey'

/** The Gemini API key the user entered, kept in this browser only. */
export function storedGeminiKey(): string {
  try {
    return localStorage.getItem(KEY_STORE) ?? ''
  } catch {
    return ''
  }
}

export function storeGeminiKey(key: string) {
  try {
    if (key) localStorage.setItem(KEY_STORE, key)
    else localStorage.removeItem(KEY_STORE)
  } catch {
    // storage blocked: the key just is not remembered
  }
}

function keyHeader(): Record<string, string> {
  const key = storedGeminiKey().trim()
  return key ? { 'x-gemini-key': key } : {}
}
