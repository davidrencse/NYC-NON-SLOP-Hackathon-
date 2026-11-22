import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Box, Boxes, Check, ChevronRight, CircuitBoard, Cpu, Download, Expand, ExternalLink, FileJson,
  Image as ImageIcon, Layers, Loader2, Maximize, Pause, Play, RotateCw, Search, ShieldCheck,
  ShoppingBag, Tag, Undo2, Wrench, X,
} from 'lucide-react'
import { PcbScene } from '@/scene/Scene'
import {
  commitBoardEdit, computeBoardBomCost, getStudio, goScale, requestExport, requestFit, setStudio,
  undoBoardEdit, useStudio, type ExportFormat, type ShopOffer, type ShopSearchEntry,
} from '@/state/studio'
import type { Board, Part } from '@/data/board'
import type { Verification as VerificationData } from '@/verify/types'
import { routeNets, traceLength } from '@/pcb/footprint'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tip, TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ResearchPane } from '@/components/Research'
import { ScaleSwitch, ScaleTransition, SystemInspector, SystemLibrary } from '@/components/SystemPanels'
import { hasHandBuiltBody, systemCost, systemFromPrompt, type SystemDesign } from '@/data/system'
import { storedGeminiKey } from '@/ai/generate'
import { firmwareFor, isController } from '@/data/firmware'

const ease = [0.16, 1, 0.3, 1] as const

// Modules written by the generation / verification workers. Loaded lazily so the
// studio still runs (offline) when they are absent.
const aiModules = import.meta.glob('./ai/generate.ts')
const verifyModules = import.meta.glob('./verify/verify.ts')

type GenLog = { stage: string; message: string }

function useBoardStats(board: Board) {
  const selectedOfferByMpn = useStudio((s) => s.selectedOfferByMpn)
  return useMemo(() => {
    const traces = routeNets(board)
    const length = traces.reduce((s, t) => s + traceLength(t), 0)
    const vias = traces.reduce((s, t) => s + t.vias.length, 0) + board.groundVias.length
    const { totalUsd, unpricedCount } = computeBoardBomCost(board, selectedOfferByMpn)
    return { traces: traces.length, length, vias, cost: totalUsd, unpricedCount }
  }, [board, selectedOfferByMpn])
}

async function fetchShopSearch(p: { mpn: string; name: string; manufacturer: string; query?: string }): Promise<ShopSearchEntry> {
  const res = await fetch('/api/shop/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(p),
  })
  const data = (await res.json()) as ShopSearchEntry
  setStudio((s) => ({ shopByMpn: { ...s.shopByMpn, [p.mpn]: data } }))
  return data
}

function TopBar() {
  const board = useStudio((s) => s.board)
  const sys = useStudio((s) => s.system)
  const scale = useStudio((s) => s.scale)
  const mode = useStudio((s) => s.mode)
  const historyLen = useStudio((s) => s.history.length)
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
      <div className="flex items-center gap-2">
        <div className="grid size-7 place-items-center rounded-md bg-foreground text-background">
          <CircuitBoard className="size-4" strokeWidth={2.2} />
        </div>
        <span className="text-sm font-semibold tracking-tight">Forge</span>
        <span className="label-mono hidden sm:inline">PCB Studio</span>
      </div>
      <ChevronRight className="size-3.5 text-muted-foreground" />
      <button onClick={() => goScale('system')} className={cn('truncate text-sm', scale === 'system' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>{sys.name}</button>
      <AnimatePresence initial={false}>
        {scale === 'board' && (
          <motion.span key="crumb" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6 }} transition={{ duration: 0.3, ease }} className="flex min-w-0 items-center gap-3">
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm">{board.name}</span>
          </motion.span>
        )}
      </AnimatePresence>
      <Badge className="label-mono !text-foreground">Rev {board.revision}</Badge>
      <div className="ml-auto flex items-center gap-2">
        {mode === 'engineer' && scale === 'board' && historyLen > 0 && (
          <Tip label="Undo last board edit">
            <Button size="sm" variant="ghost" onClick={undoBoardEdit}>
              <Undo2 className="size-3.5" /> Undo
            </Button>
          </Tip>
        )}
        <ScaleSwitch />
        <ExportMenu />
      </div>
    </header>
  )
}

function ExportMenu() {
  const [open, setOpen] = useState(false)
  const items: { f: ExportFormat; label: string; sub: string; icon: typeof Box }[] = [
    { f: 'stl', label: 'STL', sub: 'Print / enclosure fit', icon: Box },
    { f: 'glb', label: 'GLB', sub: 'Full colour glTF', icon: Boxes },
    { f: 'obj', label: 'OBJ', sub: 'Mesh for CAD import', icon: Layers },
    { f: 'png', label: 'PNG', sub: 'Viewport render', icon: ImageIcon },
    { f: 'json', label: 'BOM', sub: 'Parts, nets, proofs', icon: FileJson },
  ]
  return (
    <div className="relative">
      <Button size="sm" onClick={() => setOpen((v) => !v)}>
        <Download className="size-3.5" /> Export
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.22, ease }}
            className="absolute right-0 top-10 z-50 w-60 origin-top-right rounded-lg border border-border bg-popover p-1 shadow-2xl"
          >
            {items.map((it, i) => (
              <motion.button
                key={it.f}
                initial={{ opacity: 0, x: 6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.03, duration: 0.25, ease }}
                onClick={() => { requestExport(it.f); setOpen(false) }}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-accent"
              >
                <it.icon className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">{it.label}</span>
                <span className="ml-auto text-xs text-muted-foreground">{it.sub}</span>
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Library() {
  const board = useStudio((s) => s.board)
  const selected = useStudio((s) => s.selected)
  const hovered = useStudio((s) => s.hovered)
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const m = new Map<string, Part[]>()
    for (const p of board.parts) {
      const s = `${p.ref} ${p.name} ${p.mpn} ${p.value ?? ''}`.toLowerCase()
      if (q && !s.includes(q.toLowerCase())) continue
      m.set(p.category, [...(m.get(p.category) ?? []), p])
    }
    return [...m]
  }, [board, q])
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border max-lg:hidden">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="label-mono">Library</span>
        <span className="label-mono tabular">{board.parts.length}</span>
      </div>
      <div className="relative px-3 pb-2">
        <Search className="pointer-events-none absolute left-5.5 top-2 size-3.5 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search parts" className="h-8 pl-8 text-xs" />
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 pb-3">
        {groups.map(([cat, parts]) => (
          <div key={cat} className="mt-2">
            <div className="label-mono px-2 py-1">{cat}</div>
            {parts.map((p) => (
              <button
                key={p.ref}
                onClick={() => setStudio({ selected: p.ref, touring: false })}
                onMouseEnter={() => setStudio({ hovered: p.ref })}
                onMouseLeave={() => setStudio({ hovered: null })}
                className={cn(
                  'relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                  selected === p.ref ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                  hovered === p.ref && selected !== p.ref && 'bg-accent/60',
                )}
              >
                {selected === p.ref && (
                  <motion.span layoutId="lib-sel" transition={{ duration: 0.35, ease }} className="absolute inset-0 rounded-md bg-accent" />
                )}
                <span className="relative w-9 font-mono text-[11px] text-foreground">{p.ref}</span>
                <span className="relative truncate">{p.value ? `${p.value} · ${p.pkg}` : p.name}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </aside>
  )
}

function Toolbar() {
  const view = useStudio((s) => s.view)
  const exploded = useStudio((s) => s.exploded)
  const showTraces = useStudio((s) => s.showTraces)
  const showCallouts = useStudio((s) => s.showCallouts)
  const touring = useStudio((s) => s.touring)
  const views = ['3d', 'top', 'bottom'] as const
  const scale = useStudio((s) => s.scale)
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.6, duration: 0.6, ease }}
      className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-border bg-background/80 p-1 shadow-2xl backdrop-blur-md"
    >
      <div className="relative flex rounded-lg bg-secondary p-0.5">
        {views.map((v) => (
          <button key={v} onClick={() => setStudio({ view: v })} className="label-mono relative px-3 py-1.5 !text-[10px]">
            {view === v && <motion.span layoutId="view-pill" transition={{ duration: 0.35, ease }} className="absolute inset-0 rounded-md bg-foreground" />}
            <span className={cn('relative', view === v ? 'text-background' : 'text-muted-foreground')}>{v}</span>
          </button>
        ))}
      </div>
      <div className="mx-1 h-5 w-px bg-border" />
      <Tip label="Showcase tour (T)">
        <Button size="sm" variant={touring ? 'default' : 'ghost'} onClick={() => setStudio((s) => ({ touring: !s.touring }))}>
          {touring ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} Tour
        </Button>
      </Tip>
      <Tip label="Explode assembly (E)">
        <Button size="sm" variant={exploded ? 'default' : 'ghost'} onClick={() => setStudio((s) => ({ exploded: !s.exploded, touring: false }))}>
          <Expand className="size-3.5" /> Explode
        </Button>
      </Tip>
      <Tip label={scale === 'system' ? 'Fit system (F)' : 'Fit board (F)'}>
        <Button size="sm" variant="ghost" onClick={requestFit}><Maximize className="size-3.5" /> Fit</Button>
      </Tip>
      <div className="mx-1 h-5 w-px bg-border" />
      <Tip label={scale === 'system' ? 'Zoom out to system / into board' : 'Back to system'}>
        <Button size="sm" variant="ghost" onClick={() => goScale(scale === 'system' ? 'board' : 'system')}>
          <Boxes className="size-3.5" /> {scale === 'system' ? 'Board' : 'System'}
        </Button>
      </Tip>
      <div className="mx-1 h-5 w-px bg-border" />
      <Tip label="Copper traces">
        <Button size="icon-sm" variant={showTraces ? 'secondary' : 'ghost'} onClick={() => setStudio((s) => ({ showTraces: !s.showTraces }))}>
          <Layers className="size-3.5" />
        </Button>
      </Tip>
      <Tip label="Callouts">
        <Button size="icon-sm" variant={showCallouts ? 'secondary' : 'ghost'} onClick={() => setStudio((s) => ({ showCallouts: !s.showCallouts }))}>
          <Tag className="size-3.5" />
        </Button>
      </Tip>
    </motion.div>
  )
}

function Prompt() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [bodyBusy, setBodyBusy] = useState(false)
  const bodyController = useRef<AbortController | null>(null)
  useEffect(() => () => {
    bodyController.current?.abort()
    bodyController.current = null
  }, [])
  const [log, setLog] = useState<GenLog[]>([])
  const [error, setError] = useState<string | null>(null)
  const pending = useStudio((s) => s.pendingPrompt)
  const started = useRef<string | null>(null)
  useEffect(() => {
    // StrictMode runs this effect twice; the ref stops a second generation of the same brief.
    if (!pending || busy || started.current === pending) return
    started.current = pending
    setStudio({ pendingPrompt: null })
    setText(pending)
    void run(pending).finally(() => { started.current = null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])
  const run = async (override?: string) => {
    const text_ = override ?? text
    if (!text_.trim() || busy) return
    bodyController.current?.abort()
    const controller = new AbortController()
    bodyController.current = controller
    setBodyBusy(false)
    setBusy(true); setError(null); setLog([])
    // The off-board system follows the brief right away, even before the board arrives.
    const drafted = systemFromPrompt(text_)
    // Rename the PCB at once, so the previous design's board name is not shown while the new one is planned.
    setStudio({ system: drafted, board: { ...getStudio().board, name: `${drafted.name} board (planning…)` }, scale: 'system', view: '3d', exploded: false, selected: null, device: null })
    requestFit()
    // Generate only unmatched bodies; catalog peripherals retain their existing meshes.
    void (async () => {
      if (hasHandBuiltBody(text_)) return
      setBodyBusy(true)
      setLog((l) => [...l, { stage: 'body', message: 'Gemini is designing the custom body…' }])
      const layout = `PCB height above origin: ${drafted.pcbHeight} mm.\nDevices:\n` + drafted.devices.map((d) => `- ${d.label} at x=${d.x}, y=${d.y}, z=${d.z}`).join('\n')
      try {
        const response = await fetch('/api/chassis', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gemini-key': storedGeminiKey() }, body: JSON.stringify({ prompt: text_, layout }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(22_000)]) })
        if (!response.ok) throw new Error(`Body generation failed (${response.status})`)
        const j = await response.json() as { parts?: SystemDesign['structure']; reason?: string }
        // Ignore late answers after a different design or a user edit.
        if (controller.signal.aborted || getStudio().system !== drafted) return
        if (j.parts?.length) {
          const count = j.parts.length
          setStudio({ system: { ...drafted, form: 'none', structure: j.parts } })
          requestFit()
          setLog((l) => [...l.slice(-5), { stage: 'body', message: `Custom body ready (${count} parts)` }])
        } else if (j.reason !== 'built-in') {
          setError(j.reason === 'no-key'
            ? 'Custom body needs a Gemini API key. Showing the local enclosure.'
            : 'Gemini could not produce a valid body. Showing the local enclosure.')
        }
      } catch {
        if (!controller.signal.aborted && getStudio().system === drafted) setError('Custom body generation failed. Showing the local enclosure.')
      } finally {
        if (bodyController.current === controller) setBodyBusy(false)
      }
    })()
    try {
      const loader = aiModules['./ai/generate.ts']
      if (!loader) throw new Error('Generation service not installed')
      const mod = (await loader()) as { generateBoard: (p: string, on: (e: { type: string; stage?: string; message?: string }) => void) => Promise<Board> }
      const board = await mod.generateBoard(text_, (e) => {
        if (e.type === 'stage') setLog((l) => [...l.slice(-5), { stage: e.stage ?? '', message: e.message ?? '' }])
      })
      setStudio({ board, selected: null, exploded: false, touring: true, verification: { status: 'idle', theorems: [] } })
      requestFit()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.45, duration: 0.6, ease }}
      className="absolute left-1/2 top-4 z-10 w-[min(560px,calc(100%-32px))] -translate-x-1/2"
    >
      <AnimatePresence>
        {(busy || bodyBusy || error) && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3, ease }}
            className="mt-2 overflow-hidden rounded-lg border border-border bg-background/85 backdrop-blur-md"
          >
            <div className="space-y-1 p-2.5 font-mono text-[11px]">
              {log.map((l, i) => (
                <motion.div key={i} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} className="flex gap-2">
                  <span className="w-12 uppercase text-muted-foreground">{l.stage}</span>
                  <span className="truncate">{l.message}</span>
                </motion.div>
              ))}
              {busy && !log.length && <div className="text-muted-foreground">Planning board…</div>}
              {error && <div className="text-red-300">{error}</div>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function Firmware({ part }: { part: Part }) {
  const board = useStudio((s) => s.board)
  const code = useMemo(() => firmwareFor(board, part), [board, part])
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="label-mono">Firmware · Arduino C++</span>
        <Button
          size="sm"
          variant="secondary"
          className="h-6 px-2 text-[11px]"
          onClick={() => { void navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="max-h-72 overflow-auto rounded-md border border-border bg-black/40 p-2 font-mono text-[10.5px] leading-relaxed text-foreground/90">{code}</pre>
    </div>
  )
}

function PartEditor({ part }: { part: Part }) {
  const [searching, setSearching] = useState(false)
  const shopEntry = useStudio((s) => s.shopByMpn[part.mpn])
  const selectedOffer = useStudio((s) => s.selectedOfferByMpn[part.mpn])

  const moveAxis = (axis: 'x' | 'y', val: number) => {
    if (!Number.isFinite(val)) return
    commitBoardEdit((draft) => {
      const target = draft.parts.find((p) => p.ref === part.ref)
      if (target) target[axis] = +val.toFixed(2)
    }, `Moved ${part.ref} ${axis.toUpperCase()} → ${val.toFixed(1)} mm`)
  }

  const rotatePart = () => {
    const nextRot = (part.rot + 90) % 360
    commitBoardEdit((draft) => {
      const target = draft.parts.find((p) => p.ref === part.ref)
      if (target) target.rot = nextRot
    }, `Rotated ${part.ref} → ${nextRot}°`)
  }

  const runPartShop = async () => {
    setSearching(true)
    try {
      await fetchShopSearch({ mpn: part.mpn, name: part.name, manufacturer: part.manufacturer })
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="mt-4 space-y-3 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <span className="label-mono">Placement Edit</span>
        <Button size="sm" variant="ghost" onClick={rotatePart} className="h-6 px-2 text-[11px]">
          <RotateCw className="size-3" /> {part.rot}°
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="label-mono !text-[9.5px]">X (mm)</span>
          <Input
            key={`${part.ref}-x-${part.x}`}
            type="number"
            step="0.5"
            defaultValue={part.x}
            onBlur={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v) && v !== part.x) moveAxis('x', v)
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            className="mt-1 h-7 font-mono text-xs"
          />
        </label>
        <label className="block">
          <span className="label-mono !text-[9.5px]">Y (mm)</span>
          <Input
            key={`${part.ref}-y-${part.y}`}
            type="number"
            step="0.5"
            defaultValue={part.y}
            onBlur={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v) && v !== part.y) moveAxis('y', v)
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            className="mt-1 h-7 font-mono text-xs"
          />
        </label>
      </div>

      {isController(part) && <Firmware part={part} />}

      <div className="flex items-center justify-between pt-1">
        <span className="label-mono">Live Procurement</span>
        <Button size="sm" variant="secondary" onClick={runPartShop} disabled={searching} className="h-6 px-2 text-[11px]">
          {searching ? <Loader2 className="size-3 animate-spin" /> : <ShoppingBag className="size-3" />}
          Shop.dev
        </Button>
      </div>

      {shopEntry && (
        <div className="space-y-1.5 text-xs">
          {shopEntry.status === 'no_results' && (
            <div className="rounded border border-dashed border-border p-2 text-[11px] text-muted-foreground">
              No verified Shopify listings for {part.mpn}; using catalog reference price.
            </div>
          )}
          {shopEntry.status === 'error' && <div className="text-[11px] text-red-300">{shopEntry.error}</div>}
          {shopEntry.offers.slice(0, 3).map((o) => {
            const active = selectedOffer?.offerId === o.offerId
            return (
              <div key={o.offerId} className={cn('rounded-md border p-2', active ? 'border-foreground/60 bg-accent/40' : 'border-border')}>
                <div className="flex items-start justify-between gap-2">
                  <span className="line-clamp-1 text-[11.5px] font-medium">{o.title}</span>
                  <span className="shrink-0 font-mono text-[11.5px]">{o.formattedPrice}</span>
                </div>
                <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                  {o.sellerName} · {o.available ? 'In stock' : 'Out of stock'} · {o.matchKind.replaceAll('_', ' ')}
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  {o.matchKind === 'exact_match' && o.available && o.currency === 'USD' && (
                    <Button
                      size="sm"
                      variant={active ? 'default' : 'outline'}
                      className="h-6 px-2 text-[10.5px]"
                      onClick={() =>
                        setStudio((s) => ({
                          selectedOfferByMpn: active
                            ? Object.fromEntries(Object.entries(s.selectedOfferByMpn).filter(([k]) => k !== part.mpn))
                            : { ...s.selectedOfferByMpn, [part.mpn]: o },
                          lastDiff: [
                            active
                              ? `Reverted ${part.mpn} to catalog quote`
                              : `Selected ${o.sellerName} (${o.formattedPrice}) for ${part.mpn}`,
                          ],
                        }))
                      }
                    >
                      {active ? 'Selected' : 'Use Offer'}
                    </Button>
                  )}
                  <a
                    href={o.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 font-mono text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    Store <ExternalLink className="size-2.5" />
                  </a>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function BomAndShopPanel() {
  const board = useStudio((s) => s.board)
  const budgetUsd = useStudio((s) => s.budgetUsd)
  const shopByMpn = useStudio((s) => s.shopByMpn)
  const selectedOfferByMpn = useStudio((s) => s.selectedOfferByMpn)
  const lastDiff = useStudio((s) => s.lastDiff)
  const [searchingAll, setSearchingAll] = useState(false)

  const lines = useMemo(() => {
    const map = new Map<string, { part: Part; refs: string[]; catUnit: number | null; offer?: ShopOffer }>()
    for (const p of board.parts) {
      const cur = map.get(p.mpn) ?? {
        part: p,
        refs: [],
        catUnit: p.pricing?.[0]?.price ?? null,
        offer: selectedOfferByMpn[p.mpn],
      }
      cur.refs.push(p.ref)
      map.set(p.mpn, cur)
    }
    return [...map.values()]
  }, [board, selectedOfferByMpn])

  const { totalUsd, unpricedCount } = useMemo(
    () => computeBoardBomCost(board, selectedOfferByMpn),
    [board, selectedOfferByMpn],
  )

  const searchMajorParts = async () => {
    setSearchingAll(true)
    try {
      const targets = lines
        .filter((l) => l.part.major || l.part.kind === 'module' || l.part.kind === 'ssop' || l.part.kind === 'soic')
        .slice(0, 5)
      await Promise.all(
        targets.map((t) =>
          fetchShopSearch({ mpn: t.part.mpn, name: t.part.name, manufacturer: t.part.manufacturer }),
        ),
      )
    } finally {
      setSearchingAll(false)
    }
  }

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="label-mono">Known Hardware BOM</div>
          <div className="mt-0.5 font-mono text-xl font-medium tabular">${totalUsd.toFixed(2)}</div>
        </div>
        <Button size="sm" variant="secondary" onClick={searchMajorParts} disabled={searchingAll}>
          {searchingAll ? <Loader2 className="size-3.5 animate-spin" /> : <ShoppingBag className="size-3.5" />}
          Shop.dev
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <span className="label-mono shrink-0">Budget ($)</span>
        <Input
          type="number"
          min="1"
          step="1"
          value={budgetUsd ?? ''}
          placeholder="No cap"
          onChange={(e) => {
            const raw = e.target.value.trim()
            const num = Number(raw)
            setStudio({
              budgetUsd: raw === '' ? null : Number.isFinite(num) && num >= 0 ? num : budgetUsd,
              lastDiff: [raw === '' ? 'Cleared budget cap — BOM unchanged' : `Budget cap $${num.toFixed(2)} — BOM unchanged`],
            })
          }}
          className="h-7 font-mono text-xs"
        />
      </div>

      {budgetUsd != null && (
        <div className={cn('rounded-md border px-2.5 py-1.5 font-mono text-[11px]', totalUsd > budgetUsd ? 'border-red-400/40 text-red-300' : 'border-border text-muted-foreground')}>
          {totalUsd > budgetUsd
            ? `Exceeded cap by $${(totalUsd - budgetUsd).toFixed(2)}`
            : `$${(budgetUsd - totalUsd).toFixed(2)} remaining under $${budgetUsd.toFixed(2)}`}
          {unpricedCount > 0 ? ` · ${unpricedCount} unpriced` : ''}
        </div>
      )}

      {lastDiff.length > 0 && (
        <div className="rounded-md border border-border bg-muted/40 p-2 font-mono text-[10.5px] text-muted-foreground">
          {lastDiff.join(' · ')}
        </div>
      )}

      <div className="space-y-1.5">
        {lines.map(({ part, refs, catUnit, offer }) => {
          const shop = shopByMpn[part.mpn]
          const bestExactUsd = shop?.offers.find((o) => o.matchKind === 'exact_match' && o.available && o.priceUsd != null)
          const effUnit = offer?.priceUsd ?? catUnit
          const ext = effUnit != null ? effUnit * refs.length : null
          return (
            <div key={part.mpn} className="rounded-md border border-border p-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <button
                  onClick={() => setStudio({ selected: refs[0], inspectorTab: 'inspect', touring: false })}
                  className="truncate text-left font-medium hover:underline"
                >
                  {part.name}
                </button>
                <span className="shrink-0 font-mono text-[11.5px] tabular">
                  {ext != null ? `$${ext.toFixed(2)}` : 'Unpriced'}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
                <span className="truncate">{part.mpn} ×{refs.length}</span>
                <span>{offer ? `Shop: ${offer.sellerName}` : catUnit != null ? `$${catUnit.toFixed(3)}/ea ref` : 'no quote'}</span>
              </div>
              {bestExactUsd && !offer && (
                <div className="mt-1.5 flex items-center justify-between border-t border-border/60 pt-1 text-[10.5px]">
                  <span className="truncate text-muted-foreground">
                    Live: {bestExactUsd.formattedPrice} · {bestExactUsd.sellerName}
                  </span>
                  <button
                    onClick={() =>
                      setStudio((s) => ({
                        selectedOfferByMpn: { ...s.selectedOfferByMpn, [part.mpn]: bestExactUsd },
                        lastDiff: [`Applied ${bestExactUsd.sellerName} offer (${bestExactUsd.formattedPrice}) to ${part.mpn}`],
                      }))
                    }
                    className="ml-2 shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] hover:bg-accent"
                  >
                    Apply
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        Component BOM only. Excludes bare PCB fabrication, assembly, shipping, and tax.
      </p>
    </div>
  )
}

function Inspector() {
  const board = useStudio((s) => s.board)
  const selected = useStudio((s) => s.selected)
  const tab = useStudio((s) => s.inspectorTab)
  const lastDiff = useStudio((s) => s.lastDiff)
  const part = board.parts.find((p) => p.ref === selected)
  const stats = useBoardStats(board)
  const nets = useMemo(
    () => (part ? board.nets.filter((n) => n.path.some((x) => x.startsWith(part.ref + '.'))) : []),
    [board, part],
  )
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border max-md:hidden">
      <Tabs
        value={tab}
        onValueChange={(v) => setStudio({ inspectorTab: v as 'inspect' | 'bom' })}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="border-b border-border px-3 py-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="inspect">{part ? `Part ${part.ref}` : 'Board'}</TabsTrigger>
            <TabsTrigger value="bom">BOM &amp; Shop</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="inspect" className="min-h-0 flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            {part ? (
              <motion.div
                key={part.ref}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.28, ease }}
                className="p-4"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="label-mono">Designator</div>
                    <div className="mt-1 font-mono text-3xl font-medium tracking-tight">{part.ref}</div>
                  </div>
                  <Button size="icon-sm" variant="ghost" onClick={() => setStudio({ selected: null })}><X className="size-3.5" /></Button>
                </div>
                <div className="mt-3 text-sm font-medium">{part.name}</div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{part.description}</p>
                <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
                  {[
                    ['MPN', part.mpn], ['Maker', part.manufacturer], ['Package', part.pkg], ['Value', part.value ?? '—'],
                    ['Position', `${part.x.toFixed(1)}, ${part.y.toFixed(1)} mm`], ['Rotation', `${part.rot}°`],
                  ].map(([k, v]) => (
                    <div key={k} className="bg-background p-2.5">
                      <dt className="label-mono !text-[9.5px]">{k}</dt>
                      <dd className="mt-1 truncate font-mono text-[11.5px]">{v}</dd>
                    </div>
                  ))}
                </dl>
                {part.pricing && (
                  <>
                    <div className="label-mono mt-5">Pricing</div>
                    <table className="mt-2 w-full text-xs tabular">
                      <tbody>
                        {part.pricing.map((b) => (
                          <tr key={b.qty} className="border-b border-border/60 last:border-0">
                            <td className="py-1.5 text-muted-foreground">{b.qty}+</td>
                            <td className="py-1.5 text-right font-mono">${b.price.toFixed(3)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
                <div className="label-mono mt-5">Nets · {nets.length}</div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {nets.map((n, i) => (
                    <button
                      key={n.name + i}
                      onMouseEnter={() => setStudio({ hoveredNet: n.name })}
                      onMouseLeave={() => setStudio({ hoveredNet: null })}
                      className="rounded border border-border px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
                    >
                      {n.name}
                    </button>
                  ))}
                </div>
                <PartEditor part={part} />
              </motion.div>
            ) : (
              <motion.div key="board" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="p-4">
                <div className="label-mono">Board</div>
                <div className="mt-1 text-lg font-medium tracking-tight">{board.name}</div>
                <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
                  {[
                    ['Size', `${board.width} × ${board.height} mm`], ['Thickness', `${board.thickness} mm`],
                    ['Parts', board.parts.length], ['Nets', board.nets.length],
                    ['Traces', `${stats.traces} · ${(stats.length / 10).toFixed(1)} cm`], ['Vias', stats.vias],
                  ].map(([k, v]) => (
                    <div key={k as string} className="bg-background p-2.5">
                      <div className="label-mono !text-[9.5px]">{k}</div>
                      <div className="mt-1 font-mono text-[11.5px]">{v}</div>
                    </div>
                  ))}
                </div>
                {lastDiff.length > 0 && (
                  <div className="mt-3 rounded-md border border-border bg-muted/40 p-2 font-mono text-[10.5px] text-muted-foreground">
                    {lastDiff.join(' · ')}
                  </div>
                )}
                <p className="mt-3 text-xs text-muted-foreground">Select a part on the board or in the library.</p>
              </motion.div>
            )}
          </AnimatePresence>
        </TabsContent>

        <TabsContent value="bom" className="min-h-0 flex-1 overflow-y-auto">
          <BomAndShopPanel />
        </TabsContent>
      </Tabs>
      <Verification />
    </aside>
  )
}

function Verification() {
  const v = useStudio((s) => s.verification)
  const [repairing, setRepairing] = useState(false)
  const [repairNote, setRepairNote] = useState<string | null>(null)

  const run = async () => {
    setRepairNote(null)
    setStudio({ verification: { status: 'running', theorems: [] } })
    try {
      const loader = verifyModules['./verify/verify.ts']
      if (!loader) throw new Error('Lean verifier not installed')
      const mod = (await loader()) as { verifyBoard: (b: Board) => Promise<VerificationData> }
      setStudio({ verification: await mod.verifyBoard(getStudio().board) })
    } catch (e) {
      setStudio({ verification: { status: 'failed', theorems: [], log: e instanceof Error ? e.message : String(e) } })
    }
  }

  const runRepair = async () => {
    if (repairing) return
    setRepairing(true)
    setRepairNote(null)
    try {
      const current = getStudio().board
      const prevVer = getStudio().verification
      const res = await fetch('/api/repair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ board: current }),
      })
      const data = (await res.json()) as {
        repaired?: boolean
        rationale?: string
        board?: Board
        verification?: VerificationData
        error?: string
      }
      if (!res.ok || data.error || !data.board || !data.verification) {
        throw new Error(data.error ?? `Repair HTTP ${res.status}`)
      }
      setStudio((s) => ({
        history: [...s.history.slice(-19), { board: current, verification: prevVer, label: 'Auto-repair DRC & Lean' }],
        board: data.board!,
        verification: data.verification!,
        lastDiff: [`Repaired → Rev ${data.board!.revision}`, data.repaired ? '15/15 Lean 4 theorems ✓' : 'Partial repair'],
        touring: false,
      }))
      setRepairNote(data.rationale ?? 'Repaired failed constraints and re-verified in Lean 4.')
    } catch (e) {
      setRepairNote(e instanceof Error ? e.message : String(e))
    } finally {
      setRepairing(false)
    }
  }

  const passed = v.theorems.filter((t) => t.ok).length
  const hasFailed = v.status === 'failed' && v.theorems.some((t) => !t.ok)

  return (
    <div className="border-t border-border p-4">
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4" />
          <span className="text-sm font-medium">Lean proofs</span>
          {v.theorems.length > 0 && (
            <span className="font-mono text-[10.5px] text-muted-foreground tabular">
              {passed}/{v.theorems.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {hasFailed && (
            <Tip label="Auto-repair failed Lean constraints with Gemini & re-verify">
              <Button size="sm" variant="default" onClick={runRepair} disabled={repairing || v.status === 'running'}>
                {repairing ? <Loader2 className="size-3.5 animate-spin" /> : <Wrench className="size-3.5" />}
                Repair
              </Button>
            </Tip>
          )}
          <Button size="sm" variant="secondary" onClick={run} disabled={v.status === 'running' || repairing}>
            {v.status === 'running' ? <Loader2 className="size-3.5 animate-spin" /> : 'Verify'}
          </Button>
        </div>
      </div>
      {repairNote && (
        <p className="mt-2 rounded border border-border bg-muted/40 p-2 font-mono text-[10.5px] text-muted-foreground">
          {repairNote}
        </p>
      )}
      {v.theorems.length > 0 && (
        <>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-secondary">
            <motion.div
              className="h-full bg-foreground"
              initial={{ width: 0 }}
              animate={{ width: `${(passed / v.theorems.length) * 100}%` }}
              transition={{ duration: 0.8, ease }}
            />
          </div>
          <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto">
            {v.theorems.map((t, i) => (
              <motion.li
                key={t.name}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04, ease }}
                title={t.statement}
                className="flex items-center gap-2 font-mono text-[11px]"
              >
                {t.ok ? <Check className="size-3" /> : <X className="size-3 text-red-300" />}
                <span className={t.ok ? '' : 'text-red-300'}>{t.name}</span>
              </motion.li>
            ))}
          </ul>
        </>
      )}
      {v.status === 'idle' && <p className="mt-2 text-xs text-muted-foreground">Prove clearances, connectivity, power and thermal limits.</p>}
      {v.status === 'failed' && v.theorems.length === 0 && v.log && <p className="mt-2 line-clamp-3 font-mono text-[11px] text-red-300">{v.log}</p>}
    </div>
  )
}

function StatusBar() {
  const board = useStudio((s) => s.board)
  const sys = useStudio((s) => s.system)
  const scale = useStudio((s) => s.scale)
  const hoveredDevice = useStudio((s) => s.hoveredDevice)
  const hovered = useStudio((s) => s.hovered)
  const stats = useBoardStats(board)
  const v = useStudio((s) => s.verification)
  return (
    <footer className="label-mono flex h-7 shrink-0 items-center gap-4 border-t border-border px-3 !text-[10px]">
      <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-foreground" /> Ready</span>
      <span>{scale === 'system' ? 'System' : 'Board'}</span>
      <span className="tabular">{scale === 'system' ? `${sys.devices.length} devices` : `${board.parts.length} parts`}</span>
      <span className="tabular">{board.nets.length} nets</span>
      <span className="tabular">BOM ${(stats.cost + (scale === 'system' ? systemCost(sys) : 0)).toFixed(2)}</span>
      <span>{v.status === 'passed' ? 'Proofs ✓' : v.status === 'failed' ? 'Proofs ✗' : 'Unverified'}</span>
      <span className="ml-auto flex items-center gap-1.5"><Cpu className="size-3" /> {scale === 'system' ? hoveredDevice ?? 'Hover a device · scroll into the PCB' : hovered ?? 'Hover a part'}</span>
    </footer>
  )
}

export default function App() {
  const scale = useStudio((s) => s.scale)
  const mode = useStudio((s) => s.mode)
  const device = useStudio(s => s.device)
  const embedded = new URLSearchParams(location.search).has('demo-view')
  useEffect(() => {
    if (!embedded) return
    window.parent.postMessage({ type: 'forge-selection', device }, location.origin)
  }, [device, embedded])
  useEffect(() => {
    if (!embedded) return
    let sequence = 0
    const on = async (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'forge-session') return
      const id = event.data.id
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return
      const pending = ++sequence
      try {
        const response = await fetch(`/api/consumer-repair/${id}/summary`)
        if (!response.ok) throw new Error(`Session HTTP ${response.status}`)
        const session = await response.json()
        if (pending === sequence) {
          setStudio({ system: session.analysis.system, scale: 'system', mode: 'engineer', touring: false })
          window.parent.postMessage({ type: 'forge-renderer-state', id, revision: session.revision }, location.origin)
        }
      } catch (error) {
        window.parent.postMessage({ type: 'forge-renderer-state', id, error: String(error) }, location.origin)
      }
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [embedded])
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if (e.key === 'e') setStudio((s) => ({ exploded: !s.exploded, touring: false }))
      if (e.key === 't') setStudio((s) => ({ touring: !s.touring }))
      if (e.key === 'f') { setStudio({ touring: false }); requestFit() }
      if (e.key === 'Escape') setStudio({ selected: null, device: null, touring: false })
      if (e.key === 'z') goScale(getStudio().scale === 'system' ? 'board' : 'system')
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])
  if (embedded) return <div className="h-dvh w-full bg-background"><PcbScene /></div>
  return (
    <TooltipProvider delayDuration={250}>
      <ResearchPane />
      {mode === 'engineer' && (
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <TopBar />
        <div className="relative flex min-h-0 flex-1">
          {scale === 'system' ? <SystemLibrary /> : <Library />}
          <motion.main
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1.2, ease }}
            className="relative min-w-0 flex-1"
          >
            <PcbScene />
            <Prompt />
            <Toolbar />
            <ScaleTransition />
          </motion.main>
          {scale === 'system' ? <SystemInspector /> : <Inspector />}
        </div>
        <StatusBar />
      </div>
      )}
    </TooltipProvider>
  )
}
