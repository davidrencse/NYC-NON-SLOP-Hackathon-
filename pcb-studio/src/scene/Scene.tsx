// Forge 3D board scene. Studio lighting recipe adapted from STC-B Board 3D Viewer
// (Apache-2.0), https://github.com/DeliciousBuding/stcb-board-3d-viewer
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { CameraControls, Line } from '@react-three/drei'
import { EffectComposer, N8AO, SMAA, Bloom } from '@react-three/postprocessing'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import type { Board, Part } from '@/data/board'
import { bodyFor, routeNets, type Trace } from '@/pcb/footprint'
import { getStudio, setStudio, useStudio } from '@/state/studio'
import { createBoardArtwork } from './boardTexture'
import { buildPart, partHeight } from './packages'
import { surfaceMap } from './vendor/surface-maps'
import { SceneLabel } from './SceneLabel'
import { SystemRoot } from './System'
import { handoff, takeHandoff } from './handoff'

const FLOOR_Y = -3.4
const SYSTEM_FLOOR_Y = -44.2
export const FX = new URLSearchParams(location.search).get('fx') !== '0'

function Studio() {
  const { gl, scene } = useThree()
  const view = useStudio((s) => s.view)
  const scale = useStudio((s) => s.scale)
  const sys = scale === 'system'
  const floorY = sys ? SYSTEM_FLOOR_Y : FLOOR_Y
  const ext = sys ? 190 : 75
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl)
    const env = new RoomEnvironment()
    const target = pmrem.fromScene(env, 0.025)
    scene.environment = target.texture
    scene.environmentIntensity = 0.72
    scene.background = new THREE.Color(0x0c0d0f)
    pmrem.dispose()
    return () => target.dispose()
  }, [gl, scene])
  const back = view === 'bottom'
  return (
    <>
      <hemisphereLight args={[0xeef0f4, 0x26272b, 0.24]} />
      <directionalLight
        key={scale}
        position={sys ? [-150, 260, 60] : [-60, 100, 20]}
        intensity={3.05}
        color={0xfff6ea}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-ext}
        shadow-camera-right={ext}
        shadow-camera-top={ext}
        shadow-camera-bottom={-ext}
        shadow-camera-near={1}
        shadow-camera-far={sys ? 700 : 260}
        shadow-bias={-0.00002}
        shadow-normalBias={0.018}
        shadow-radius={2.2}
      />
      <directionalLight position={[65, 48, 35]} intensity={0.58} color={0xdfe6f2} />
      <directionalLight position={[10, 30, -85]} intensity={1.25} />
      <directionalLight position={[-45, -95, -60]} intensity={2.25} visible={back} />
      <mesh rotation-x={-Math.PI / 2} position-y={floorY} receiveShadow visible={!back} userData={{ noExport: true }}>
        <planeGeometry args={[2000, 2000]} />
        <meshStandardMaterial color={0x141518} roughness={0.96} />
      </mesh>
      <gridHelper args={sys ? [1200, 120, 0x2c2f34, 0x1c1e22] : [400, 80, 0x2c2f34, 0x1c1e22]} position-y={floorY + 0.02} visible={!back && !new URLSearchParams(location.search).has('demo-view')} userData={{ noExport: true }} />
    </>
  )
}

/** Board substrate: rounded outline with holes, top artwork from the netlist. */
export function BoardMesh({ board, traces }: { board: Board; traces: Trace[] }) {
  const showTraces = useStudio((s) => s.showTraces)
  const showSilk = useStudio((s) => s.showSilk)
  const artwork = useMemo(() => createBoardArtwork(board, traces, { traces: true, silk: true }), [board, traces])
  useEffect(() => () => artwork.dispose(), [artwork])
  useEffect(() => artwork.repaint({ traces: showTraces, silk: showSilk }), [artwork, showTraces, showSilk])

  const geometry = useMemo(() => {
    const { width: W, height: H, thickness: T, cornerRadius: r } = board
    const s = new THREE.Shape()
    s.moveTo(-W / 2 + r, -H / 2)
    s.lineTo(W / 2 - r, -H / 2); s.quadraticCurveTo(W / 2, -H / 2, W / 2, -H / 2 + r)
    s.lineTo(W / 2, H / 2 - r); s.quadraticCurveTo(W / 2, H / 2, W / 2 - r, H / 2)
    s.lineTo(-W / 2 + r, H / 2); s.quadraticCurveTo(-W / 2, H / 2, -W / 2, H / 2 - r)
    s.lineTo(-W / 2, -H / 2 + r); s.quadraticCurveTo(-W / 2, -H / 2, -W / 2 + r, -H / 2)
    for (const h of board.holes) {
      const p = new THREE.Path()
      p.absarc(h.x, -h.y, h.d / 2, 0, Math.PI * 2, true)
      s.holes.push(p)
    }
    const g = new THREE.ExtrudeGeometry(s, { depth: T, bevelEnabled: false, curveSegments: 24 })
    g.rotateX(-Math.PI / 2) // shape y -> -z, extrusion -> +y
    const pos = g.getAttribute('position')
    const nrm = g.getAttribute('normal')
    const uv = new Float32Array(pos.count * 2)
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = (pos.getX(i) + W / 2) / W
      uv[i * 2 + 1] = 1 - (pos.getZ(i) + H / 2) / H
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    // regroup triangles: 0 top, 1 bottom, 2 edge
    const buckets: number[][] = [[], [], []]
    for (let t = 0; t < pos.count / 3; t++) {
      const ny = nrm.getY(t * 3)
      buckets[ny > 0.5 ? 0 : ny < -0.5 ? 1 : 2].push(t * 3, t * 3 + 1, t * 3 + 2)
    }
    g.setIndex(buckets.flat())
    g.clearGroups()
    let start = 0
    buckets.forEach((b, i) => {
      g.addGroup(start, b.length, i)
      start += b.length
    })
    return g
  }, [board])

  const mats = useMemo(() => {
    const top = new THREE.MeshPhysicalMaterial({
      map: artwork.color,
      roughness: 1,
      metalness: 1,
      roughnessMap: artwork.orm,
      metalnessMap: artwork.orm,
      bumpMap: artwork.bump,
      bumpScale: 0.6,
      clearcoat: 0.32,
      clearcoatRoughness: 0.38,
      specularIntensity: 0.4,
      envMapIntensity: 1.05,
    })
    const bottom = new THREE.MeshPhysicalMaterial({
      color: 0x0d0e0f, roughness: 0.62, clearcoat: 0.3, clearcoatRoughness: 0.4, bumpMap: surfaceMap('mask'), bumpScale: 0.01,
    })
    const edge = new THREE.MeshStandardMaterial({ color: 0x4a4636, roughness: 0.88, bumpMap: surfaceMap('grain'), bumpScale: 0.02 })
    return [top, bottom, edge]
  }, [artwork])

  return <mesh geometry={geometry} material={mats} castShadow receiveShadow name="substrate" />
}

const easeOutBack = (t: number) => {
  const c1 = 1.25, c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

function explodeHeight(p: Part) {
  return 7 + partHeight(p) * 0.9 + (p.kind === 'chip' ? 2 : 0)
}

export function Parts({ board, passive = false }: { board: Board; passive?: boolean }) {
  const exploded = useStudio((s) => s.exploded)
  const showCallouts = useStudio((s) => s.showCallouts)
  const hovered = useStudio((s) => s.hovered)
  const selected = useStudio((s) => s.selected)
  const models = useMemo(() => board.parts.map((p) => buildPart(p)), [board])
  const groups = useRef<(THREE.Group | null)[]>([])
  const anim = useRef({ since: 0, from: 0, to: 0 })
  const leaders = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(board.parts.length * 6), 3))
    return g
  }, [board])
  const leaderMat = useRef<THREE.LineDashedMaterial>(null)
  const offsets = useRef<number[]>(board.parts.map(() => 0))
  const majors = board.parts.filter((p) => p.major).map((p) => p.ref)

  useEffect(() => {
    anim.current = { since: performance.now(), from: anim.current.to, to: exploded ? 1 : 0 }
  }, [exploded])

  useFrame((_, dt) => {
    const { since, from, to } = anim.current
    const elapsed = (performance.now() - since) / 1000
    const pos = leaders.getAttribute('position') as THREE.BufferAttribute
    let any = 0
    board.parts.forEach((p, i) => {
      const g = groups.current[i]
      if (!g) return
      // stagger: big parts first, passives ripple after
      const delay = (p.major ? 0 : 0.12) + (i / board.parts.length) * 0.35
      const t = Math.min(1, Math.max(0, (elapsed - delay) / 0.75))
      const e = from + (to - from) * (to > from ? easeOutBack(t) : 1 - Math.pow(1 - t, 3))
      const lift = p.ref === hovered || p.ref === selected ? 0.5 : 0
      offsets.current[i] = THREE.MathUtils.damp(offsets.current[i], lift, 12, dt)
      const y = board.thickness + e * explodeHeight(p) + offsets.current[i]
      g.position.y = y
      any = Math.max(any, e)
      pos.setXYZ(i * 2, p.x, board.thickness + 0.02, p.y)
      pos.setXYZ(i * 2 + 1, p.x, y, p.y)
    })
    pos.needsUpdate = true
    if (leaderMat.current) leaderMat.current.opacity = Math.min(0.55, any * 0.7)
  })

  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const ref = e.object.userData.ref as string | undefined
    if (ref && getStudio().hovered !== ref) setStudio({ hovered: ref })
    document.body.style.cursor = 'pointer'
  }
  const out = () => {
    setStudio({ hovered: null })
    document.body.style.cursor = ''
  }
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    if (e.delta > 4) return
    const ref = e.object.userData.ref as string | undefined
    if (ref) setStudio({ selected: ref })
  }

  return (
    <>
      {board.parts.map((p, i) => (
        <group
          key={p.ref}
          ref={(g) => { groups.current[i] = g }}
          position={[p.x, board.thickness, p.y]}
          rotation-y={(p.rot * Math.PI) / 180}
          onPointerOver={passive ? undefined : over}
          onPointerOut={passive ? undefined : out}
          onClick={passive ? undefined : click}
        >
          <primitive object={models[i]} />
          {showCallouts && !passive && p.major && (
            <SceneLabel position={[0, partHeight(p) + 1.6, 0]} fields={[String(majors.indexOf(p.ref) + 1).padStart(2, '0'), p.ref, p.name]} className={`forge-tag ${selected === p.ref ? 'is-active' : ''}`} />
          )}
        </group>
      ))}
      <lineSegments geometry={leaders} userData={{ noExport: true }} onUpdate={(l) => l.computeLineDistances()}>
        <lineDashedMaterial ref={leaderMat} color="#d8dade" dashSize={0.6} gapSize={0.5} transparent opacity={0} depthWrite={false} />
      </lineSegments>
    </>
  )
}

/** Footprint brackets for hover / selection (drawn just above the mask). */
function FootprintHighlight({ board }: { board: Board }) {
  const hovered = useStudio((s) => s.hovered)
  const selected = useStudio((s) => s.selected)
  const items = [selected, hovered !== selected ? hovered : null].filter(Boolean) as string[]
  return (
    <group userData={{ noExport: true }}>
      {items.map((ref) => {
        const p = board.parts.find((q) => q.ref === ref)
        if (!p) return null
        const b = bodyFor(p)
        const q = Math.round(((p.rot % 180) + 180) % 180) === 90
        const w = (q ? b.h : b.w) / 2 + 1, h = (q ? b.w : b.h) / 2 + 1
        const y = board.thickness + 0.05
        const L = Math.min(2.2, w * 0.6, h * 0.6)
        const pts: [number, number, number][][] = [
          [[-w + L, y, -h], [-w, y, -h], [-w, y, -h + L]],
          [[w - L, y, -h], [w, y, -h], [w, y, -h + L]],
          [[-w + L, y, h], [-w, y, h], [-w, y, h - L]],
          [[w - L, y, h], [w, y, h], [w, y, h - L]],
        ]
        return (
          <group key={ref} position={[p.x, 0, p.y]}>
            {pts.map((seg, i) => (
              <Line key={i} points={seg} color={ref === selected ? '#ffffff' : '#9da3aa'} lineWidth={ref === selected ? 2.2 : 1.4} />
            ))}
          </group>
        )
      })}
    </group>
  )
}

/** Glowing overlay for nets attached to the selection or a hovered net. */
function NetHighlight({ board, traces }: { board: Board; traces: Trace[] }) {
  const selected = useStudio((s) => s.selected)
  const hoveredNet = useStudio((s) => s.hoveredNet)
  const exploded = useStudio((s) => s.exploded)
  const active = useMemo(() => {
    const nets = new Set<string>()
    if (hoveredNet) nets.add(hoveredNet)
    else if (selected) for (const n of board.nets) if (n.path.some((s) => s.startsWith(selected + '.'))) nets.add(n.name)
    return traces.filter((t) => nets.has(t.net))
  }, [board, traces, selected, hoveredNet])
  const y = board.thickness + 0.06
  return (
    <group userData={{ noExport: true }}>
      {active.map((t, i) => (
        <Line
          key={t.net + i}
          points={t.points.map(([x, z]) => [x, t.layer === 'top' ? y : -0.06, z] as [number, number, number])}
          color={hoveredNet ? '#ffffff' : '#e8ecf0'}
          lineWidth={hoveredNet ? 3 : 2}
          transparent
          opacity={exploded ? 0.95 : 0.8}
          depthTest={t.layer === 'top'}
        />
      ))}
    </group>
  )
}

function CameraRig({ board, root }: { board: Board; root: React.RefObject<THREE.Group | null> }) {
  const controls = useRef<CameraControls>(null)
  const gl = useThree((t) => t.gl)
  const view = useStudio((s) => s.view)
  const fitNonce = useStudio((s) => s.fitNonce)
  const selected = useStudio((s) => s.selected)
  const intro = useRef(true)
  const lastView = useRef(view)
  const size = Math.max(board.width, board.height)

  useEffect(() => {
    const c = controls.current
    if (!c) return
    c.smoothTime = 0.45
    c.draggingSmoothTime = 0.12
    c.minDistance = 8
    c.maxDistance = 600
    // cinematic intro: continue the system-scale dive if there is one,
    // otherwise glide from straight above down to a 3/4 hero angle
    const h = takeHandoff()
    if (h) c.setLookAt(h.pos.x, h.pos.y, h.pos.z, h.target.x, h.target.y, h.target.z, false)
    else c.setLookAt(0, size * 3.2, 0.01, 0, 0, 0, false)
    const id = setTimeout(() => {
      c.smoothTime = 1.1
      c.setLookAt(size * 0.85, size * 1.1, size * 1.45, 0, 0, 0, true).then(() => {
        c.smoothTime = 0.45
        intro.current = false
      })
    }, 120)
    return () => clearTimeout(id)
  }, [size])

  // scroll out past the board → back to the system view, carrying the camera pose
  useEffect(() => {
    const c = controls.current
    if (!c) return
    let left = false
    const onUpdate = () => {
      if (intro.current || left || c.distance < size * 4.2) return
      left = true
      const pos = new THREE.Vector3()
      const target = new THREE.Vector3()
      c.getPosition(pos)
      c.getTarget(target)
      handoff.pos = pos
      handoff.target = target
      window.dispatchEvent(new CustomEvent('forge:scale', { detail: 'system' }))
    }
    c.addEventListener('update', onUpdate)
    return () => c.removeEventListener('update', onUpdate)
  }, [size])

  useEffect(() => {
    const c = controls.current
    if (!c || intro.current) return
    if (lastView.current === view) return
    lastView.current = view
    setStudio({ touring: false })
    if (view === 'top') c.setLookAt(0, size * 1.6, 0.001, 0, 0, 0, true)
    else if (view === 'bottom') c.setLookAt(0, -size * 1.6, 0.001, 0, 0, 0, true)
    else c.setLookAt(size * 0.85, size * 1.1, size * 1.45, 0, 0, 0, true)
  }, [view, size])

  useEffect(() => {
    const c = controls.current
    if (!c || !fitNonce || !root.current) return
    c.fitToBox(root.current, true, { paddingTop: 6, paddingBottom: 6, paddingLeft: 6, paddingRight: 6 })
  }, [fitNonce, root])

  // Showcase tour: explode, visit every major part / peripheral, reassemble, loop.
  const touring = useStudio((s) => s.touring)
  useEffect(() => {
    const c = controls.current
    if (!c || !touring) return
    const stops = board.parts.filter((p) => p.major)
    let alive = true
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const run = async () => {
      while (intro.current && alive) await wait(100)
      let lap = 0
      while (alive) {
        c.smoothTime = 1.0
        setStudio({ exploded: true, selected: null })
        await c.setLookAt(size * 0.95 * (lap % 2 ? -1 : 1), size * 1.05, size * 1.25, 0, 4, 0, true)
        await wait(900)
        for (let i = 0; i < stops.length && alive; i++) {
          const p = stops[i]
          const a = (i / stops.length) * Math.PI * 2 + lap
          const h = board.thickness + 7 + partHeight(p) * 1.4
          const d = 22 + Math.max(bodyFor(p).w, bodyFor(p).h) * 1.6
          setStudio({ selected: p.ref })
          c.smoothTime = 0.85
          await c.setLookAt(p.x + Math.cos(a) * d, h + d * 0.75, p.y + Math.sin(a) * d, p.x, h - 3, p.y, true)
          if (!alive) return
          // slow drift while the part is in focus
          c.smoothTime = 2.4
          c.rotate(0.35, 0, true)
          await wait(1700)
        }
        if (!alive) return
        c.smoothTime = 1.1
        setStudio({ exploded: false, selected: null })
        await c.setLookAt(size * 0.85, size * 1.1, size * 1.45, 0, 0, 0, true)
        c.smoothTime = 6
        c.rotate(Math.PI * 0.5, 0, true)
        await wait(4200)
        lap++
      }
    }
    run()
    const stop = () => setStudio({ touring: false })
    const el = gl.domElement
    el?.addEventListener('pointerdown', stop)
    el?.addEventListener('wheel', stop, { passive: true })
    return () => {
      alive = false
      c.smoothTime = 0.45
      el?.removeEventListener('pointerdown', stop)
      el?.removeEventListener('wheel', stop)
    }
  }, [touring, board, size, gl])

  useEffect(() => {
    const c = controls.current
    if (!c || intro.current || !selected || getStudio().touring) return
    const p = board.parts.find((q) => q.ref === selected)
    if (!p) return
    // gentle focus: slide target, keep the viewing direction
    c.moveTo(p.x * 0.6, 0, p.y * 0.6, true)
  }, [selected, board])

  return <CameraControls ref={controls} makeDefault />
}

export function ExportBridge({ root }: { root: React.RefObject<THREE.Group | null> }) {
  const req = useStudio((s) => s.exportRequest)
  const { gl, scene, camera } = useThree()
  useEffect(() => {
    if (!req || !root.current) return
    const r = root.current
    import('@/export')
      .then((m) => m.exportScene(req.format, r, gl, scene, camera))
      .catch((err) => console.error('export failed', err))
  }, [req, root, gl, scene, camera])
  return null
}

function BoardRoot() {
  const board = useStudio((s) => s.board)
  const traces = useMemo(() => routeNets(board), [board])
  const root = useRef<THREE.Group>(null)
  return (
    <>
      <group name="pcb-root" ref={root} onPointerMissed={() => setStudio({ selected: null })}>
        <BoardMesh board={board} traces={traces} />
        <Parts board={board} />
      </group>
      <FootprintHighlight board={board} />
      <NetHighlight board={board} traces={traces} />
      <CameraRig board={board} root={root} />
      <ExportBridge root={root} />
    </>
  )
}

export function PcbScene() {
  const scale = useStudio((s) => s.scale)
  return (
    <Canvas
      shadows="soft"
      dpr={[1, 2]}
      gl={{ preserveDrawingBuffer: true, antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.05 }}
      camera={{ position: [60, 80, 100], fov: 32, near: 0.5, far: 2000 }}
      onPointerMissed={() => setStudio({ selected: null })}
    >
      <Studio />
      {scale === 'system' ? <SystemRoot /> : <BoardRoot />}
      {FX && (<EffectComposer multisampling={0} enableNormalPass={false}>
        <N8AO aoRadius={2.2} intensity={2.4} distanceFalloff={0.6} quality="medium" halfRes />
        <Bloom intensity={0.25} luminanceThreshold={0.92} mipmapBlur />
        <SMAA />
      </EffectComposer>)}
    </Canvas>
  )
}
