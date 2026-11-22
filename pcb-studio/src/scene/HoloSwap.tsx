// Holographic replacement picker that hangs off a selected device in the 3D
// system view: a leader line from the part to a vertical "spine" of compatible
// replacements, each with inline compare and swap.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Html } from '@react-three/drei'
import { byId } from '@/data/catalog'
import { alternativesFor, systemCost, type SystemDevice } from '@/data/system'
import { setStudio, useStudio } from '@/state/studio'

const usd = (n: number) => `$${Math.abs(n).toFixed(2)}`

function swap(dev: SystemDevice, catalogId: string) {
  setStudio((s) => ({
    system: { ...s.system, devices: s.system.devices.map((d) => (d.id === dev.id ? { ...d, catalogId } : d)) },
  }))
}

export function HoloSwap({ dev, index, position }: { dev: SystemDevice; index: number; position: [number, number, number] }) {
  const sys = useStudio((s) => s.system)
  const item = byId[dev.catalogId]
  const alts = useMemo(() => alternativesFor(dev), [dev])
  const total = systemCost(sys)
  const maxPrice = Math.max(...alts.map((a) => a.price), 0.01)
  const [cursor, setCursor] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [left, setLeft] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  // Flip to the left of the part when the panel would run off the viewport's right edge.
  useEffect(() => {
    const check = () => {
      const el = root.current
      const host = document.querySelector('canvas')?.parentElement
      if (!el || !host) return
      const anchor = el.getBoundingClientRect().left + (left ? el.offsetWidth - 4 : 4)
      const bounds = host.getBoundingClientRect()
      const width = el.offsetWidth
      setLeft(anchor + width > bounds.right - 8 && anchor - width > bounds.left + 8)
    }
    const id = window.setInterval(check, 200)
    check()
    return () => window.clearInterval(id)
  }, [left])

  const doSwap = (id: string) => {
    swap(dev, id)
    setFlash(id)
    window.setTimeout(() => setFlash(null), 900)
  }

  // ↑/↓ move, → expand, Enter swap, Esc close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key === 'Escape') setStudio({ device: null })
      else if (e.key === 'ArrowDown') setCursor((c) => Math.min(alts.length - 1, c + 1))
      else if (e.key === 'ArrowUp') setCursor((c) => Math.max(0, c - 1))
      else if (e.key === 'ArrowRight') setOpen(alts[cursor]?.item.id ?? null)
      else if (e.key === 'ArrowLeft') setOpen(null)
      else if (e.key === 'Enter' && alts[cursor] && !alts[cursor].current) doSwap(alts[cursor].item.id)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!item) return null
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  return (
    <Html position={position} zIndexRange={[40, 30]} style={{ pointerEvents: 'none' }}>
      <div ref={root} className={`holo ${left ? 'is-left' : ''}`}>
        <svg className="holo-lead" width="96" height="60" viewBox="0 0 96 60" aria-hidden>
          <circle cx="4" cy="56" r="3" className="holo-dot" />
          <circle cx="4" cy="56" r="8" className="holo-ping" />
          <path d="M4 56 L40 16 L96 16" className="holo-path" />
        </svg>
        <div
          className="holo-panel"
          role="dialog"
          aria-label={`Replacements for ${item.name}`}
          onPointerDown={stop}
          onPointerUp={stop}
          onClick={stop}
          onWheel={stop}
          onDoubleClick={stop}
        >
          <div className="holo-head">
            <span className="holo-idx">{String(index + 1).padStart(2, '0')}</span>
            <div className="holo-title">
              <span className="holo-kicker">SWAP // {dev.port} · {dev.role}</span>
              <span className="holo-name">{item.name}</span>
            </div>
            <button type="button" className="holo-x" aria-label="Close" onClick={() => setStudio({ device: null })}>×</button>
          </div>

          {alts.length <= 1 ? (
            <div className="holo-empty">No compatible replacements in catalog.</div>
          ) : (
            <ol className="holo-spine">
              {alts.map((a, i) => {
                const expanded = open === a.item.id
                const warn = a.warnings.length > 0
                return (
                  <li
                    key={a.item.id}
                    className={`holo-row ${a.current ? 'is-current' : ''} ${i === cursor ? 'is-cursor' : ''} ${flash === a.item.id ? 'is-flash' : ''}`}
                    style={{ animationDelay: `${80 + i * 45}ms` }}
                    onMouseEnter={() => setCursor(i)}
                  >
                    <span className={`holo-node ${warn ? 'is-warn' : ''}`} aria-hidden />
                    <div className="holo-main">
                      <button type="button" className="holo-label" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : a.item.id)}>
                        <span className="holo-caret">{expanded ? '▾' : '▸'}</span>
                        <span className="holo-rname">{a.item.name}</span>
                        {warn && <span className="holo-warn" title={a.warnings.join('\n')}>!</span>}
                      </button>
                      <div className="holo-meter">
                        <span className="holo-bar"><i style={{ width: `${(a.price / maxPrice) * 100}%` }} /></span>
                        <span className="holo-price">{usd(a.price)}</span>
                        <span className={`holo-delta ${a.delta < 0 ? 'is-down' : a.delta > 0 ? 'is-up' : ''}`}>
                          {a.current ? 'IN USE' : `${a.delta < 0 ? '−' : '+'}${usd(a.delta)}`}
                        </span>
                      </div>
                      {expanded && (
                        <div className="holo-detail">
                          <div className="holo-stats">
                            <span><em>SYS</em>${(total + (a.current ? 0 : a.delta)).toFixed(2)}</span>
                            <span><em>Δ mA</em>{a.currentDelta >= 0 ? '+' : '−'}{Math.abs(a.currentDelta)}</span>
                            <span><em>IF</em>{a.item.interfaces.join('/').toUpperCase()}</span>
                          </div>
                          {a.reasons.map((r) => <div key={r} className="holo-ok">+ {r}</div>)}
                          {a.warnings.map((r) => <div key={r} className="holo-bad">! {r}</div>)}
                        </div>
                      )}
                    </div>
                    {a.current ? (
                      <span className="holo-tagcur">●</span>
                    ) : (
                      <button type="button" className="holo-swap" onClick={() => doSwap(a.item.id)}>SWAP</button>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
          <div className="holo-foot">
            <span>{Math.max(alts.length - 1, 0)} compatible</span>
            <span>↑↓ nav · ⏎ swap · esc</span>
          </div>
        </div>
      </div>
    </Html>
  )
}
