// POST /api/chat: question-and-answer about the design on screen. Chat only:
// the reply is text and never edits the board or system.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { callClaude, CLAUDE_TIERS, resolveClaudeKey } from './claude.ts'
import { callGemini, MODELS, resolveApiKey } from './gemini.ts'
import { readJson, sendJson } from './http.ts'

const SYSTEM = `You are FORGE's engineering assistant inside a PCB and hardware design studio.
Answer the user's questions about the design described in the context: parts, power, buses, cost, layout, assembly and trade-offs.
You can only explain and advise; you cannot edit the design. If asked to change something, say what they could change and why.
Be concise and concrete (under 180 words), use numbers from the context, and say plainly when the context does not contain something.`

const SCHEMA = { type: 'OBJECT', properties: { answer: { type: 'STRING' } }, required: ['answer'] }

type Turn = { role: 'user' | 'assistant'; content: string }

function transcript(context: string, turns: Turn[]): string {
  const history = turns.slice(-10).map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content.slice(0, 2000)}`).join('\n\n')
  return `Design context:\n${context}\n\nConversation:\n${history}\n\nReply to the last user message. Put the reply in "answer".`
}

function offlineAnswer(context: string, question: string): string {
  const q = question.toLowerCase()
  const line = (k: string) => context.split('\n').find((l) => l.toLowerCase().startsWith(k)) ?? ''
  if (/cost|price|budget|\$/.test(q)) return `${line('cost') || 'Cost data is in the BOM panel.'} Open BOM & Shop on the right for per-part pricing.`
  if (/power|battery|volt|current|rail/.test(q)) return `${line('power') || 'Power details are in the system inspector.'} Rails per device are listed under Devices.`
  if (/part|device|sensor|motor|what.*(on|in)/.test(q)) return `${line('devices') || 'See the device list in the left panel.'}`
  return 'Live answers need a Claude (or Gemini) API key on the server. Ask about cost, power or parts for an offline summary.'
}

export function chatHandler(env: () => Record<string, string | undefined>, log: (m: string) => void) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
    const body = (await readJson(req).catch(() => null)) as { messages?: unknown; context?: unknown } | null
    const turns = (Array.isArray(body?.messages) ? body.messages : [])
      .filter((t): t is Turn => !!t && typeof t === 'object' && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
    const context = typeof body?.context === 'string' ? body.context.slice(0, 8000) : ''
    const last = turns.at(-1)
    if (!last || last.role !== 'user' || !last.content.trim()) return sendJson(res, 400, { error: 'Ask a question.' })
    const config = env()
    const prompt = transcript(context, turns)
    const claudeKey = resolveClaudeKey(config)
    try {
      if (claudeKey) {
        const out = (await callClaude(claudeKey, { model: CLAUDE_TIERS.carbon.model, effort: 'low', system: SYSTEM, prompt, schema: SCHEMA, timeoutMs: 60_000, maxAttempts: 1 })) as { answer?: string }
        return sendJson(res, 200, { answer: String(out.answer ?? '').trim() || 'No answer.', provider: 'claude' })
      }
      const geminiKey = resolveApiKey(config)
      if (geminiKey) {
        const out = (await callGemini(geminiKey, { model: MODELS.carbon, system: SYSTEM, prompt, schema: SCHEMA, timeoutMs: 45_000, maxAttempts: 1 })) as { answer?: string }
        return sendJson(res, 200, { answer: String(out.answer ?? '').trim() || 'No answer.', provider: 'gemini' })
      }
    } catch (e) {
      log(`chat failed (${e instanceof Error ? e.message : String(e)})`)
      return sendJson(res, 200, { answer: `The model could not answer right now. ${offlineAnswer(context, last.content)}`, provider: 'offline' })
    }
    return sendJson(res, 200, { answer: offlineAnswer(context, last.content), provider: 'offline' })
  }
}
