import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { MessageSquare, Send, X } from 'lucide-react'
import { getStudio } from '@/state/studio'
import { systemCost } from '@/data/system'
import { authHeaders } from '@/ai/generate'
import { cn } from '@/lib/utils'

type Turn = { role: 'user' | 'assistant'; content: string }

/** Snapshot of the design on screen, sent with each question. Read-only. */
function designContext(): string {
  const s = getStudio()
  const sys = s.system
  const b = s.board
  const lines = [
    s.brief ? `brief: ${s.brief}` : '',
    `system: ${sys.name} (form ${sys.form ?? 'plate'}, chassis ${sys.chassis.w}x${sys.chassis.d}x${sys.chassis.t} mm)`,
    `devices: ${sys.devices.map((d) => `${d.label} [${d.role}, ${d.bus}, port ${d.port}, ${d.rail} V]`).join('; ')}`,
    `cost: off-board devices about $${systemCost(sys).toFixed(2)}`,
    `power: rails used ${[...new Set(sys.devices.map((d) => d.rail))].join(', ')} V`,
    `board: ${b.name} rev ${b.revision}, ${b.width}x${b.height} mm, ${b.parts.length} parts`,
    `board parts: ${b.parts.slice(0, 60).map((p) => `${p.ref} ${p.name}${p.mpn ? ` (${p.mpn})` : ''}${p.value ? ` ${p.value}` : ''}`).join('; ')}`,
  ]
  return lines.filter(Boolean).join('\n')
}

const STARTERS = ['What does this design do?', 'Is the battery big enough?', 'Where can I cut cost?']

export function EngineerChat() {
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const ctrl = useRef<AbortController | null>(null)

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' })
  }, [turns, busy])
  useEffect(() => () => ctrl.current?.abort(), [])

  const ask = async (q: string) => {
    const question = q.trim()
    if (!question || busy) return
    const next: Turn[] = [...turns, { role: 'user', content: question }]
    setTurns(next)
    setText('')
    setBusy(true)
    ctrl.current = new AbortController()
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ messages: next, context: designContext() }),
        signal: AbortSignal.any([ctrl.current.signal, AbortSignal.timeout(75_000)]),
      })
      const data = (await r.json().catch(() => ({}))) as { answer?: string; error?: string }
      setTurns((t) => [...t, { role: 'assistant', content: data.answer ?? data.error ?? 'No answer.' }])
    } catch {
      setTurns((t) => [...t, { role: 'assistant', content: 'The assistant did not answer in time. Try again.' }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="absolute bottom-4 right-4 z-20 flex flex-col items-end gap-2">
      <AnimatePresence>
        {open && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18 }}
            aria-label="Ask about this design"
            className="flex h-[min(460px,calc(100dvh-180px))] w-[min(360px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-border bg-background/95 shadow-2xl backdrop-blur-md"
          >
            <header className="flex items-center justify-between border-b border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium">Ask about this design</p>
                <p className="text-[11px] text-muted-foreground">Answers only. It does not change the board.</p>
              </div>
              <button aria-label="Close chat" onClick={() => setOpen(false)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                <X className="size-4" />
              </button>
            </header>
            <div ref={list} className="flex-1 space-y-2 overflow-y-auto px-3 py-3 text-sm" aria-live="polite">
              {turns.length === 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Ask about parts, power, cost or layout.</p>
                  {STARTERS.map((s) => (
                    <button key={s} onClick={() => void ask(s)} className="block w-full rounded-md border border-border px-2.5 py-1.5 text-left text-xs hover:bg-accent">
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {turns.map((t, i) => (
                <div key={i} className={cn('max-w-[88%] whitespace-pre-wrap rounded-lg px-2.5 py-1.5 leading-relaxed', t.role === 'user' ? 'ml-auto bg-foreground text-background' : 'bg-accent text-foreground')}>
                  {t.content}
                </div>
              ))}
              {busy && <div className="w-fit rounded-lg bg-accent px-2.5 py-1.5 text-muted-foreground">Thinking…</div>}
            </div>
            <form
              onSubmit={(e) => { e.preventDefault(); void ask(text) }}
              className="flex items-center gap-2 border-t border-border p-2"
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Ask a question…"
                aria-label="Question"
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
              <button type="submit" disabled={busy || !text.trim()} aria-label="Send" className="rounded-md bg-foreground p-2 text-background disabled:opacity-40">
                <Send className="size-3.5" />
              </button>
            </form>
          </motion.section>
        )}
      </AnimatePresence>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full border border-border bg-background/90 px-3.5 py-2 text-sm shadow-xl backdrop-blur-md hover:bg-accent"
      >
        <MessageSquare className="size-4" />
        {open ? 'Hide chat' : 'Ask about design'}
      </button>
    </div>
  )
}
