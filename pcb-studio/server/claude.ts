import Anthropic from '@anthropic-ai/sdk'
import { savedKey } from './gemini.ts'

/**
 * Claude client for the studio server: one structured-JSON call per request.
 * The key stays in this process and only goes to api.anthropic.com (pinned, so
 * an ANTHROPIC_BASE_URL inherited from a developer shell never reroutes it).
 */

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

function model(): string {
  return process.env.FORGE_CLAUDE_MODEL?.trim() || savedKey('FORGE_CLAUDE_MODEL') || 'claude-opus-5-5'
}

/** Logical model tiers used by the pipeline: same model, different effort. */
export const CLAUDE_TIERS = {
  argon: { get model() { return model() }, effort: 'medium' as Effort },
  carbon: { get model() { return model() }, effort: 'low' as Effort },
} as const

export function resolveClaudeKey(env: Record<string, string | undefined>): string | null {
  return env.ANTHROPIC_API_KEY?.trim() || savedKey('ANTHROPIC_API_KEY')
}

export interface ClaudeCallOpts {
  model: string
  effort?: Effort
  system: string
  prompt: string
  /** Gemini-style (upper-case types) or JSON Schema; converted for Claude. */
  schema: Record<string, unknown>
  temperature?: number
  signal?: AbortSignal
  timeoutMs?: number
  maxAttempts?: number
}

export interface ClaudeUsage {
  model: string
  ms: number
  promptTokens?: number
  outputTokens?: number
}

export class ClaudeError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

const DROP = new Set(['nullable', 'propertyOrdering', 'minimum', 'maximum', 'maxItems', 'minLength', 'maxLength', 'pattern', 'format', 'example', 'title'])

/** Gemini OpenAPI subset → JSON Schema accepted by Claude structured outputs. */
export function toJsonSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toJsonSchema)
  if (!s || typeof s !== 'object') return s
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (DROP.has(k)) continue
    if (k === 'minItems') { if (v === 0 || v === 1) out[k] = v; continue }
    if (k === 'type' && typeof v === 'string') { out[k] = v.toLowerCase(); continue }
    if (k === 'properties' && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, toJsonSchema(ps)]))
      continue
    }
    out[k] = toJsonSchema(v)
  }
  if (out.type === 'object') out.additionalProperties = false
  return out
}

const clients = new Map<string, Anthropic>()
function client(apiKey: string): Anthropic {
  let c = clients.get(apiKey)
  if (!c) {
    c = new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com', maxRetries: 0, fetch: (url, init) => globalThis.fetch(url, init) })
    clients.set(apiKey, c)
  }
  return c
}

function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  try {
    return JSON.parse(t)
  } catch {
    const a = t.indexOf('{')
    const b = t.lastIndexOf('}')
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1))
    throw new Error('not JSON')
  }
}

export async function callClaude(apiKey: string, o: ClaudeCallOpts, onUsage?: (u: ClaudeUsage) => void): Promise<unknown> {
  const schema = toJsonSchema(o.schema) as Record<string, unknown>
  let structured = true
  let lastErr: unknown
  const maxAttempts = Math.max(1, Math.min(3, o.maxAttempts ?? 2))
  let budget = maxAttempts
  for (let attempt = 0; attempt < budget; attempt++) {
    const started = Date.now()
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 180_000)
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
    const system = structured
      ? o.system
      : `${o.system}\n\nReply with a single JSON object matching this JSON Schema, and nothing else:\n${JSON.stringify(schema)}`
    try {
      const msg = await client(apiKey).messages
        .create(
          {
            model: o.model,
            max_tokens: 16000,
            system,
            messages: [{ role: 'user', content: o.prompt }],
            output_config: {
              effort: o.effort ?? 'low',
              ...(structured ? { format: { type: 'json_schema', schema } } : {}),
            },
          } as Anthropic.MessageCreateParamsNonStreaming,
          { signal, timeout: o.timeoutMs ?? 180_000 },
        )
      onUsage?.({ model: o.model, ms: Date.now() - started, promptTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens })
      if (msg.stop_reason === 'refusal') throw new ClaudeError(`Claude ${o.model}: declined the request`)
      const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      if (!text) throw new ClaudeError(`Claude ${o.model}: empty response (${msg.stop_reason ?? 'unknown'})`)
      try {
        return parseJson(text)
      } catch {
        lastErr = new ClaudeError(`Claude ${o.model}: response was not valid JSON (${msg.stop_reason ?? 'unknown'})`)
        continue
      }
    } catch (e) {
      if (o.signal?.aborted) throw new ClaudeError('aborted')
      if (e instanceof ClaudeError) { lastErr = e; continue }
      if (e instanceof Anthropic.BadRequestError && structured) {
        // Schema too complex / unsupported keyword: retry with the schema in the prompt.
        structured = false
        budget++ // schema fallback gets its own try
        lastErr = new ClaudeError(`Claude ${o.model}: ${e.message.slice(0, 200)}`, 400)
        continue
      }
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        throw new ClaudeError(`Claude ${o.model}: ${e.status} key rejected`, e.status)
      }
      if (e instanceof Anthropic.APIError && e.status && e.status < 500 && e.status !== 429) {
        throw new ClaudeError(`Claude ${o.model}: ${e.status} ${e.message.slice(0, 200)}`, e.status)
      }
      lastErr = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError' || e instanceof Anthropic.APIUserAbortError)
        ? new ClaudeError(`Claude ${o.model}: timed out`)
        : new ClaudeError(`Claude ${o.model}: ${e instanceof Error ? e.message.slice(0, 200) : 'request failed'}`, e instanceof Anthropic.APIError ? e.status : undefined)
      if (attempt + 1 < budget) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)))
    }
  }
  throw lastErr instanceof Error ? lastErr : new ClaudeError(`Claude ${o.model}: request failed`)
}
