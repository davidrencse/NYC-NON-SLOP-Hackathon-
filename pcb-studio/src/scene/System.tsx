// System scale: the custom PCB mounted on a rover chassis together with every
// off-board device it drives. Scroll in (or click the PCB) to dive into the
// board; the board view hands the camera back when you scroll out.
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { CameraControls } from '@react-three/drei'
import { byId } from '@/data/catalog'
import type { Board } from '@/data/board'
import { BUS_COLOR, type Prim, type PrimMaterial, type SystemDesign, type SystemDevice } from '@/data/system'
import { routeNets } from '@/pcb/footprint'
import { getStudio, setStudio, useStudio } from '@/state/studio'
import { SceneLabel } from './SceneLabel'
import { buildDevice } from './devices'
import { partHeight } from './packages'
import { BoardMesh, ExportBridge, Parts } from './Scene'
import { handoff, takeHandoff } from './handoff'
import { HoloSwap } from './HoloSwap'

const anodized = new THREE.MeshPhysicalMaterial({ color: 0x24272b, roughness: 0.42, metalness: 0.75, clearcoat: 0.2 })
const holeMat = new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.9 })
const brass = new THREE.MeshStandardMaterial({ color: 0xb89b5e, roughness: 0.32, metalness: 1 })

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

/** Where a device sits when assembled and how far it travels when exploded. */
function mount(sys: SystemDesign, d: SystemDevice) {
  const item = byId[d.catalogId]
  const base = new THREE.Vector3(d.x, d.y + (d.stand ? item.dimensions.h / 2 : 0), d.z)
  const out = new THREE.Vector3(d.x, 0, d.z).normalize().multiplyScalar(d.bus === 'motor' ? 26 : 18)
  const lift = d.bus === 'motor' ? -6 : 34 + Math.abs(d.z) * 0.08
  return { base, explode: new THREE.Vector3(out.x, lift, out.z), size: Math.max(item.dimensions.w, item.dimensions.h), sys }
}

/** Cable end point on a device, in the device's local frame. */
function anchorLocal(d: SystemDevice) {
  const item = byId[d.catalogId]
  const { w, h } = item.dimensions
  if (d.bus === 'motor') return new THREE.Vector3(w * 0.42, h * 0.75, 0)
  if (d.stand) return new THREE.Vector3(0, 2, -h / 2 + 1.6)
  return new THREE.Vector3(0, 2.2, -h / 2 + 1.6)
}

function Chassis({ sys }: { sys: SystemDesign }) {
  const { w, d, t } = sys.chassis
  const band = sys.form === 'band'
  const plate = useMemo(() => {
    const r = band ? w / 2 - 0.5 : 10
    const s = new THREE.Shape()
    s.moveTo(-w / 2 + r, -d / 2)
    s.lineTo(w / 2 - r, -d / 2)
    s.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r)
    s.lineTo(w / 2, d / 2 - r)
    s.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2)
    s.lineTo(-w / 2 + r, d / 2)
    s.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r)
    s.lineTo(-w / 2, -d / 2 + r)
    s.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2)
    // lightening slots down both sides (a band gets a row of strap holes instead)
    if (band) {
      for (let z = d / 2 - 30; z > d / 2 - 90; z -= 12) {
        const hole = new THREE.Path()
        hole.absarc(0, z, 2.2, 0, Math.PI * 2, true)
        s.holes.push(hole)
      }
    } else for (const sx of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const cz = -d / 2 + 52 + i * ((d - 104) / 3)
        const hole = new THREE.Path()
        hole.absarc(sx * (w / 2 - 14), cz, 4.2, 0, Math.PI * 2, true)
        s.holes.push(hole)
      }
    }
    const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: true, bevelSize: 0.6, bevelThickness: 0.6, bevelSegments: 3, curveSegments: 24 })
    g.rotateX(Math.PI / 2)
    return g
  }, [w, d, t, band])
  // M3 hole grid as instanced dark discs
  const grid = useMemo(() => {
    const pts: [number, number][] = []
    if (band) return pts
    for (let x = -w / 2 + 26; x <= w / 2 - 26; x += 10) {
      for (let z = -d / 2 + 14; z <= d / 2 - 14; z += 10) {
        if (Math.abs(x) < 46 && Math.abs(z) < 36) continue // under the PCB
        if (Math.abs(z) > 48 && Math.abs(z) < 108 && Math.abs(x) > 18) continue
        pts.push([x, z])
      }
    }
    return pts
  }, [w, d, band])
  const inst = useRef<THREE.InstancedMesh>(null)
  useEffect(() => {
    const m = inst.current
    if (!m) return
    const o = new THREE.Object3D()
    grid.forEach(([x, z], i) => {
      o.position.set(x, 0.62, z)
      o.updateMatrix()
      m.setMatrixAt(i, o.matrix)
    })
    m.instanceMatrix.needsUpdate = true
  }, [grid])
  return (
    <group>
      <mesh geometry={plate} material={anodized} castShadow receiveShadow />
      <instancedMesh ref={inst} args={[undefined, undefined, grid.length]} material={holeMat} receiveShadow>
        <cylinderGeometry args={[1.6, 1.6, 0.1, 18]} />
      </instancedMesh>
    </group>
  )
}

const PRIM_MAT: Record<PrimMaterial, THREE.Material> = {
  metal: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.3, metalness: 1 }),
  plastic: new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.6, metalness: 0.1 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x101113, roughness: 0.95 }),
  carbon: new THREE.MeshPhysicalMaterial({ color: 0x15171a, roughness: 0.35, metalness: 0.4, clearcoat: 0.6 }),
  clear: new THREE.MeshPhysicalMaterial({ color: 0xcfd6dd, roughness: 0.2, transparent: true, opacity: 0.22, depthWrite: false }),
}

/** Arms, rotors, walls and feet described by the system design. */
function Structure({ prims }: { prims: Prim[] }) {
  const spinners = useRef<(THREE.Mesh | null)[]>([])
  useFrame((_, dt) => {
    for (const m of spinners.current) if (m) m.rotation.y += dt * 9
  })
  return (
    <group>
      {prims.map((p, i) => (
        <mesh
          key={i}
          ref={(m) => {
            if (p.spin) spinners.current[i] = m
          }}
          position={p.pos}
          rotation={p.rot ? [(p.rot[0] * Math.PI) / 180, (p.rot[1] * Math.PI) / 180, (p.rot[2] * Math.PI) / 180] : [0, ((p.yaw ?? 0) * Math.PI) / 180, 0]}
          material={PRIM_MAT[p.mat]}
          castShadow
          receiveShadow
        >
          {p.shape === 'box' ? <boxGeometry args={p.size} /> : p.shape === 'ring' ? <torusGeometry args={[p.size[0], p.size[1], 14, 48]} /> : p.shape === 'sphere' ? <sphereGeometry args={[p.size[0], 32, 20]} /> : <cylinderGeometry args={[p.size[0], p.size[0], p.size[1], 28]} />}
        </mesh>
      ))}
    </group>
  )
}

function Standoffs({ board, height }: { board: Board; height: number }) {
  return (
    <>
      {board.holes.map((h, i) => (
        <group key={i} position={[h.x, 0, h.y]}>
          <mesh material={brass} position-y={height / 2} castShadow>
            <cylinderGeometry args={[2.6, 2.6, height, 6]} />
          </mesh>
          <mesh material={brass} position-y={height + board.thickness + 1}>
            <cylinderGeometry args={[2.8, 2.8, 2, 24]} />
          </mesh>
        </group>
      ))}
    </>
  )
}

function Pcb({ sys }: { sys: SystemDesign }) {
  const board = useStudio((s) => s.board)
  const traces = useMemo(() => routeNets(board), [board])
  const exploded = useStudio((s) => s.exploded)
  const hover = useStudio((s) => s.hoveredDevice === 'pcb')
  const g = useRef<THREE.Group>(null)
  const ring = useRef<THREE.Mesh>(null)
  const anim = useRef({ since: 0, from: 0, to: 0 })
  useEffect(() => {
    anim.current = { since: performance.now(), from: anim.current.to, to: exploded ? 1 : 0 }
  }, [exploded])
  useFrame((_, dt) => {
    const { since, from, to } = anim.current
    const t = Math.min(1, (performance.now() - since) / 900)
    const e = from + (to - from) * easeOut(t)
    if (g.current) g.current.position.y = sys.pcbHeight + e * 22
    if (ring.current) {
      const m = ring.current.material as THREE.MeshBasicMaterial
      m.opacity = THREE.MathUtils.damp(m.opacity, hover ? 0.9 : 0, 10, dt)
    }
  })
  const W = board.width + 6
  const H = board.height + 6
  return (
    <>
      <Standoffs board={board} height={sys.pcbHeight} />
      <group
        ref={g}
        position-y={sys.pcbHeight}
        name="system-pcb"
        onPointerOver={(e) => {
          e.stopPropagation()
          setStudio({ hoveredDevice: 'pcb' })
          document.body.style.cursor = 'zoom-in'
        }}
        onPointerOut={() => {
          setStudio({ hoveredDevice: null })
          document.body.style.cursor = ''
        }}
        onClick={(e) => {
          e.stopPropagation()
          if (e.delta > 4) return
          if (getStudio().device === 'pcb') window.dispatchEvent(new Event('forge:dive'))
          else setStudio({ device: 'pcb', touring: false })
        }}
      >
        <BoardMesh board={board} traces={traces} />
        <Parts board={board} passive />
        <mesh ref={ring} rotation-x={-Math.PI / 2} position-y={-0.4} userData={{ noExport: true }}>
          <ringGeometry args={[Math.hypot(W, H) / 2 - 0.6, Math.hypot(W, H) / 2, 96]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
    </>
  )
}

function Device({ d, index, sys, onReady }: { d: SystemDevice; index: number; sys: SystemDesign; onReady: (id: string, g: THREE.Group | null) => void }) {
  const item = byId[d.catalogId]
  const model = useMemo(() => buildDevice(item), [item])
  const exploded = useStudio((s) => s.exploded)
  const selected = useStudio((s) => s.device === d.id)
  const hovered = useStudio((s) => s.hoveredDevice === d.id)
  const showCallouts = useStudio((s) => s.showCallouts)
  const touring = useStudio((s) => s.touring)
  const otherSelected = useStudio((s) => s.device !== null && s.device !== d.id && !s.touring)
  const embedded = new URLSearchParams(location.search).has('demo-view')
  const g = useRef<THREE.Group>(null)
  const anim = useRef({ since: 0, from: 0, to: 0 })
  const lift = useRef(0)
  const m = useMemo(() => mount(sys, d), [sys, d])
  useEffect(() => {
    model.traverse((o) => {
      o.userData.device = d.id
    })
  }, [model, d.id])
  useEffect(() => {
    anim.current = { since: performance.now(), from: anim.current.to, to: exploded ? 1 : 0 }
  }, [exploded])
  useFrame((_, dt) => {
    const grp = g.current
    if (!grp) return
    const { since, from, to } = anim.current
    const delay = index * 0.05
    const t = Math.min(1, Math.max(0, ((performance.now() - since) / 1000 - delay) / 0.9))
    const e = from + (to - from) * easeOut(t)
    lift.current = THREE.MathUtils.damp(lift.current, hovered || selected ? 3 : 0, 10, dt)
    grp.position.set(m.base.x + m.explode.x * e, m.base.y + m.explode.y * e + lift.current, m.base.z + m.explode.z * e)
    const wheelStep = dt * (getStudio().touring ? 2.2 : 0.6) * (d.rot === 180 ? -1 : 1)
    grp.traverse((o) => {
      if (o.name === 'wheel') o.rotation.x -= wheelStep
    })
  })
  const tag = Math.max(item.dimensions.thickness, (model.userData.height as number) ?? 10)
  return (
    <group
      ref={(r) => {
        g.current = r
        onReady(d.id, r)
      }}
      position={m.base.toArray()}
      rotation={[d.stand ? -Math.PI / 2 : 0, (d.rot * Math.PI) / 180, 0, 'YXZ']}
      onPointerOver={(e) => {
        e.stopPropagation()
        if (getStudio().hoveredDevice !== d.id) setStudio({ hoveredDevice: d.id })
        document.body.style.cursor = 'pointer'
      }}
      onPointerOut={() => {
        setStudio({ hoveredDevice: null })
        document.body.style.cursor = ''
      }}
      onClick={(e) => {
        e.stopPropagation()
        if (e.delta > 4) return
        setStudio({ device: d.id, touring: false })
      }}
    >
      <primitive object={model} />
      {selected && !touring && !embedded && (
        <HoloSwap key={d.catalogId} dev={d} index={index} position={d.stand ? [0, 4, item.dimensions.h / 2 + 4] : [0, tag + 2, 0]} />
      )}
      {showCallouts && !(selected && !touring && !embedded) && (
        <SceneLabel
          position={d.stand ? [0, 4, item.dimensions.h / 2 + 8] : [d.bus === 'motor' ? item.dimensions.w * 0.1 : 0, tag + 8, 0]}
          fields={[String(index + 1).padStart(2, '0'), item.name, d.port]}
          className={`forge-tag ${selected ? 'is-active' : ''} ${hovered ? 'is-hover' : ''} ${otherSelected && !hovered ? 'is-dim' : ''}`}
          visible={!embedded || selected || hovered}
        />
      )}
    </group>
  )
}

/** Bus cables from the PCB connectors to each device, re-laid while parts move. */
function Cables({ sys, groups, pcb }: { sys: SystemDesign; groups: React.RefObject<Map<string, THREE.Group>>; pcb: () => THREE.Object3D | null }) {
  const board = useStudio((s) => s.board)
  const hoveredDevice = useStudio((s) => s.hoveredDevice)
  const selected = useStudio((s) => s.device)
  const meshes = useRef<(THREE.Mesh | null)[]>([])
  const portCount = new Map<string, number>()
  const ports = sys.devices.map((d) => {
    const p = board.parts.find((q) => q.ref === d.port)
    const k = portCount.get(d.port) ?? 0
    portCount.set(d.port, k + 1)
    return { part: p, k }
  })
  const tmp = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    const top = pcb()
    const pcbY = top ? top.position.y : sys.pcbHeight
    sys.devices.forEach((d, i) => {
      const mesh = meshes.current[i]
      const grp = groups.current?.get(d.id)
      if (!mesh || !grp) return
      const { part, k } = ports[i]
      const px = part ? part.x + (k - 1.5) * 1.4 : 0
      const pz = part ? part.y : 0
      const start = new THREE.Vector3(px, pcbY + board.thickness + (part ? partHeight(part) * 0.7 : 4), pz)
      grp.updateMatrixWorld()
      const end = tmp.copy(anchorLocal(d)).applyMatrix4(grp.matrixWorld).clone()
      const key = `${start.x.toFixed(2)},${start.y.toFixed(2)},${end.x.toFixed(2)},${end.y.toFixed(2)},${end.z.toFixed(2)}`
      if (mesh.userData.key === key) return
      mesh.userData.key = key
      const mid = start.clone().lerp(end, 0.5)
      mid.y = Math.max(start.y, end.y) + 10 + start.distanceTo(end) * 0.08
      const curve = new THREE.CatmullRomCurve3([
        start,
        start.clone().add(new THREE.Vector3(0, 6, 0)),
        mid,
        end.clone().add(new THREE.Vector3(0, d.bus === 'motor' ? 2 : 7, 0)),
        end,
      ], false, 'centripetal')
      mesh.geometry.dispose()
      mesh.geometry = new THREE.TubeGeometry(curve, 64, d.bus === 'power' || d.bus === 'motor' ? 0.85 : 0.6, 10, false)
    })
  })
  return (
    <>
      {sys.devices.map((d, i) => {
        const active = hoveredDevice === d.id || selected === d.id
        return (
          <mesh key={d.id} ref={(m) => { meshes.current[i] = m }} castShadow userData={{ noExport: false }}>
            <bufferGeometry />
            <meshStandardMaterial
              color={BUS_COLOR[d.bus]}
              roughness={0.55}
              emissive={BUS_COLOR[d.bus]}
              emissiveIntensity={active ? 0.55 : 0.04}
            />
          </mesh>
        )
      })}
    </>
  )
}

const HERO = new THREE.Vector3(250, 215, 320)
const HERO_TARGET = new THREE.Vector3(0, -6, 0)

/**
 * Hero camera pose. Bodies made of primitives (drone arms, a lamp arm, a printer
 * frame) can reach well past the base plate, so the camera backs off to fit them.
 * Systems without a structure (rover, wristband) keep the fixed pose.
 */
function heroPose(sys: SystemDesign): { pos: THREE.Vector3; target: THREE.Vector3 } {
  if (!sys.structure?.length) return { pos: new URLSearchParams(location.search).has('demo-view') ? HERO.clone().multiplyScalar(0.58) : HERO, target: HERO_TARGET }
  const box = new THREE.Box3()
  for (const p of sys.structure) {
    const half = p.shape === 'box' ? Math.max(...p.size) / 2 : Math.max(p.size[0], p.size[1] / 2)
    box.expandByPoint(new THREE.Vector3(p.pos[0] - half, p.pos[1] - half, p.pos[2] - half))
    box.expandByPoint(new THREE.Vector3(p.pos[0] + half, p.pos[1] + half, p.pos[2] + half))
  }
  const radius = box.getSize(new THREE.Vector3()).length() / 2
  const dist = radius * 3
  if (dist <= HERO.length()) return { pos: HERO, target: HERO_TARGET }
  const target = new THREE.Vector3(0, box.getCenter(new THREE.Vector3()).y, 0)
  return { pos: target.clone().addScaledVector(HERO.clone().normalize(), dist), target }
}

function SystemCamera({ sys, groups, root }: { sys: SystemDesign; groups: React.RefObject<Map<string, THREE.Group>>; root: React.RefObject<THREE.Group | null> }) {
  const controls = useRef<CameraControls>(null)
  const gl = useThree((t) => t.gl)
  const device = useStudio((s) => s.device)
  const fitNonce = useStudio((s) => s.fitNonce)
  const view = useStudio((s) => s.view)
  const touring = useStudio((s) => s.touring)
  const intro = useRef(true)
  const diving = useRef(false)
  const pcbCentre = useMemo(() => new THREE.Vector3(0, sys.pcbHeight, 0), [sys])
  const lastView = useRef(view)
  const hero = useMemo(() => heroPose(sys), [sys])
  const goHero = (c: CameraControls) => c.setLookAt(hero.pos.x, hero.pos.y, hero.pos.z, hero.target.x, hero.target.y, hero.target.z, true)

  // entry: continue from the board camera if we zoomed out of it, else a crane shot
  useEffect(() => {
    const c = controls.current
    if (!c) return
    c.smoothTime = 0.5
    c.draggingSmoothTime = 0.12
    c.minDistance = 25
    c.maxDistance = 1400
    const h = takeHandoff()
    if (h) {
      const p = h.pos.add(pcbCentre)
      const t = h.target.add(pcbCentre)
      c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false)
    } else {
      c.setLookAt(40, 900, 60, 0, 0, 0, false)
    }
    const id = setTimeout(() => {
      c.smoothTime = 1.15
      goHero(c).then(() => {
        c.smoothTime = 0.5
        intro.current = false
      })
    }, 60)
    return () => clearTimeout(id)
  }, [pcbCentre])

  // dive into the board: fly down onto the PCB, then hand the pose to the board view
  useEffect(() => {
    const dive = async () => {
      const c = controls.current
      if (!c || diving.current) return
      diving.current = true
      setStudio({ touring: false, exploded: false })
      c.smoothTime = 0.55
      const pos = new THREE.Vector3()
      c.getPosition(pos)
      const dir = pos.sub(pcbCentre).normalize()
      if (dir.y < 0.35) dir.setY(0.6).normalize()
      const near = pcbCentre.clone().addScaledVector(dir, 120)
      await c.setLookAt(near.x, near.y, near.z, 0, sys.pcbHeight, 0, true)
      handoff.pos = near.clone().sub(pcbCentre)
      handoff.target = new THREE.Vector3(0, 0, 0)
      window.dispatchEvent(new CustomEvent('forge:scale', { detail: 'board' }))
    }
    window.addEventListener('forge:dive', dive)
    return () => window.removeEventListener('forge:dive', dive)
  }, [pcbCentre, sys])

  // scroll-in threshold → dive
  useEffect(() => {
    const c = controls.current
    if (!c) return
    const onUpdate = () => {
      if (intro.current || diving.current) return
      const t = new THREE.Vector3()
      c.getTarget(t)
      if (c.distance < 95 && t.distanceTo(pcbCentre) < 60) window.dispatchEvent(new Event('forge:dive'))
    }
    c.addEventListener('update', onUpdate)
    return () => c.removeEventListener('update', onUpdate)
  }, [pcbCentre])

  // focus a device without changing the viewing direction
  useEffect(() => {
    const c = controls.current
    if (!c || intro.current || !device || getStudio().touring) return
    const grp = device === 'pcb' ? null : groups.current?.get(device)
    const box = new THREE.Box3()
    if (grp) box.setFromObject(grp)
    else box.setFromCenterAndSize(pcbCentre, new THREE.Vector3(90, 20, 70))
    const centre = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3()).length()
    const pos = new THREE.Vector3()
    c.getPosition(pos)
    const target = new THREE.Vector3()
    c.getTarget(target)
    const dir = pos.sub(target).normalize()
    const dist = Math.max(110, size * 2.4)
    const p = centre.clone().addScaledVector(dir, dist)
    c.setLookAt(p.x, p.y, p.z, centre.x, centre.y, centre.z, true)
  }, [device, groups, pcbCentre])

  useEffect(() => {
    const c = controls.current
    if (!c || !fitNonce || !root.current) return
    setStudio({ device: null })
    goHero(c)
  }, [fitNonce, root])

  useEffect(() => {
    const c = controls.current
    if (!c || intro.current || lastView.current === view) return
    lastView.current = view
    setStudio({ touring: false })
    if (view === 'top') c.setLookAt(0, 560, 0.01, 0, 0, 0, true)
    else if (view === 'bottom') c.setLookAt(0, -480, 0.01, 0, 0, 0, true)
    else goHero(c)
  }, [view])

  // showcase: orbit the rover, visiting each device, then dive into the PCB
  useEffect(() => {
    const c = controls.current
    if (!c || !touring) return
    let alive = true
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const run = async () => {
      while (intro.current && alive) await wait(100)
      await wait(700)
      let lap = 0
      while (alive) {
        c.smoothTime = 1.2
        setStudio({ exploded: true, device: null })
        await c.setLookAt(-hero.pos.x * (lap % 2 ? -1 : 1), hero.pos.y * 1.1, hero.pos.z, hero.target.x, hero.target.y + 16, hero.target.z, true)
        await wait(1500)
        for (let i = 0; i < sys.devices.length && alive; i++) {
          const d = sys.devices[i]
          const grp = groups.current?.get(d.id)
          if (!grp) continue
          const box = new THREE.Box3().setFromObject(grp)
          const centre = box.getCenter(new THREE.Vector3())
          const a = Math.atan2(d.z, d.x) + 0.5
          const dist = Math.max(120, box.getSize(new THREE.Vector3()).length() * 2.2)
          setStudio({ device: d.id })
          c.smoothTime = 0.9
          await c.setLookAt(centre.x + Math.cos(a) * dist, centre.y + dist * 0.65, centre.z + Math.sin(a) * dist, centre.x, centre.y, centre.z, true)
          if (!alive) return
          c.smoothTime = 2.4
          c.rotate(0.3, 0, true)
          await wait(1500)
        }
        if (!alive) return
        c.smoothTime = 1.2
        setStudio({ exploded: false, device: null })
        await goHero(c)
        c.smoothTime = 6
        c.rotate(Math.PI * 0.6, 0, true)
        await wait(4500)
        lap++
      }
    }
    run()
    const stop = () => setStudio({ touring: false })
    const el = gl.domElement
    el.addEventListener('pointerdown', stop)
    el.addEventListener('wheel', stop, { passive: true })
    return () => {
      alive = false
      c.smoothTime = 0.5
      el.removeEventListener('pointerdown', stop)
      el.removeEventListener('wheel', stop)
    }
  }, [touring, sys, groups, gl])

  return <CameraControls ref={controls} makeDefault />
}

export function SystemRoot() {
  const sys = useStudio((s) => s.system)
  const root = useRef<THREE.Group>(null)
  const groups = useRef(new Map<string, THREE.Group>())
  const pcbRef = () => root.current?.getObjectByName('system-pcb') ?? null
  const onReady = (id: string, g: THREE.Group | null) => {
    if (g) groups.current.set(id, g)
    else groups.current.delete(id)
  }
  return (
    <>
      <group name="pcb-root" ref={root} onPointerMissed={() => setStudio({ device: null })}>
        {sys.form !== 'none' && <Chassis sys={sys} />}
        {sys.structure && <Structure prims={sys.structure} />}
        <Pcb sys={sys} />
        {sys.devices.map((d, i) => (
          <Device key={d.id} d={d} index={i} sys={sys} onReady={onReady} />
        ))}
        <Cables sys={sys} groups={groups} pcb={pcbRef} />
      </group>
      <SystemCamera sys={sys} groups={groups} root={root} />
      <ExportBridge root={root} />
    </>
  )
}
