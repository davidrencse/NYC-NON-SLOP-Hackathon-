// System-scale assembly: the custom PCB plus the off-board devices it drives.
// Coordinates in mm, world X right, Z toward the viewer (rover front is -Z).
import { byId, catalog, type CatalogItem } from './catalog/index.ts'
import { WEARABLE, VEHICLE, FLYER, EYEWEAR, BREWER, LAMP, PRINTER } from './bodyPolicy.ts'
export { hasBuiltInBody as hasHandBuiltBody } from './bodyPolicy.ts'

export type Bus = 'power' | 'motor' | 'i2c' | 'gpio' | 'data'

export const BUS_COLOR: Record<Bus, string> = {
  power: '#ffffff',
  motor: '#d4d4d4',
  i2c: '#a3a3a3',
  gpio: '#737373',
  data: '#e5e5e5',
}

export interface SystemDevice {
  id: string
  catalogId: string
  label: string
  role: string
  bus: Bus
  /** Board connector this device plugs into, e.g. "J7". */
  port: string
  x: number
  z: number
  /** Height of the device's mount above the chassis top. Negative hangs below. */
  y: number
  rot: number // degrees about Y
  /** Stand the device up on its edge (sonar facing forward). */
  stand?: boolean
  /** Rail the device is powered from, used for compatibility checks. */
  rail: number
}

export interface SystemDesign {
  name: string
  /** plate: flat chassis (rovers, enclosures). band: wrist strap for wearables. */
  form?: 'plate' | 'band' | 'none'
  chassis: { w: number; d: number; t: number }
  pcbHeight: number // standoff height under the custom PCB
  devices: SystemDevice[]
  /** Mechanical parts around the chassis: arms, rotors, walls, legs. Millimetres, y up, plate top at y = 0. */
  structure?: Prim[]
}

export type PrimMaterial = 'metal' | 'plastic' | 'rubber' | 'carbon' | 'clear'
export interface Prim {
  shape: 'box' | 'cyl' | 'ring' | 'sphere'
  /** box: width, height, depth. cyl: radius, height, unused. ring: radius, tube radius, unused (stands upright, facing z). */
  size: [number, number, number]
  pos: [number, number, number]
  /** Rotation about y in degrees. */
  yaw?: number
  /** Full rotation [x, y, z] in degrees. Wins over yaw. */
  rot?: [number, number, number]
  mat: PrimMaterial
  /** Spins about y in the viewer (rotors). */
  spin?: boolean
}

const motor = (id: string, port: string, x: number, z: number, label: string): SystemDevice => ({
  id, catalogId: 'tt-motor-148', label, role: `Drive · ${port}`, bus: 'motor', port,
  x, z, y: -22.5, rot: x < 0 ? 0 : 180, rail: 7.4,
})

export const defaultSystem: SystemDesign = {
  name: 'Rover R1',
  chassis: { w: 150, d: 230, t: 3 },
  pcbHeight: 12,
  devices: [
    motor('m1', 'J2', -40, -78, 'Front-left drive'),
    motor('m2', 'J3', -40, 78, 'Rear-left drive'),
    motor('m3', 'J4', 40, -78, 'Front-right drive'),
    motor('m4', 'J5', 40, 78, 'Rear-right drive'),
    { id: 'bat', catalogId: 'holder-18650', label: 'Battery', role: 'Power · 2S Li-ion', bus: 'power', port: 'J6', x: 0, z: 62, y: 0, rot: 0, rail: 7.4 },
    { id: 'oled', catalogId: 'ssd1306-096', label: 'Status display', role: 'HMI · I²C 0x3C', bus: 'i2c', port: 'J7', x: 34, z: -62, y: 6, rot: 0, rail: 3.3 },
    { id: 'imu', catalogId: 'mpu6050', label: 'IMU', role: 'Heading · I²C 0x68', bus: 'i2c', port: 'J7', x: -30, z: -58, y: 6, rot: 0, rail: 3.3 },
    { id: 'sonar', catalogId: 'hcsr04', label: 'Range finder', role: 'Obstacle · GPIO', bus: 'gpio', port: 'J7', x: 0, z: -104, y: 0, rot: 0, stand: true, rail: 5 },
    { id: 'leds', catalogId: 'ws2812b-strip', label: 'Light bar', role: 'Lighting · 1-wire', bus: 'data', port: 'J7', x: 0, z: 104, y: 0, rot: 0, rail: 5 },
  ],
}

// ---------------------------------------------------------------- generated systems

const SKIP: string[] = ['board', 'mcu', 'module', 'passive', 'connector', 'driver', 'indicator']
// Words that map to catalog items even when the brief does not name the part.
const SYNONYMS: [RegExp, string][] = [
  [/\b(emg|muscle|myo|electromyograph)/i, 'myoware-emg'],
  [/\b(imu|accel|gyro|motion|orientation|tilt|gesture)/i, 'mpu6050'],
  [/\b(heart|pulse|spo2|oximet)/i, 'max30102'],
  [/\b(temperature|humidity|weather|climate)/i, 'bme280'],
  [/\b(distance|ultrasonic|sonar|obstacle)/i, 'hcsr04'],
  [/\b(lidar|time[- ]of[- ]flight|tof)\b/i, 'vl53l0x'],
  [/\b(display|screen|oled|status)\b/i, 'ssd1306-096'],
  [/\b(e-?ink|e-?paper)/i, 'epaper-29'],
  [/\b(led strip|light bar|neopixel|rgb)/i, 'ws2812b-strip'],
  [/\b(haptic|vibrat|buzz|alarm|beep)/i, 'buzzer-active'],
  [/\b(servo)/i, 'sg90'],
  [/\b(stepper)/i, '28byj-48'],
  [/\b(pump|valve|solenoid|relay|water)/i, 'relay-1ch'],
  [/\b(gps|location|track)/i, 'neo6m'],
  [/\b(lora|long range)/i, 'rfm95w'],
  [/\b(motion sensor|pir|presence)/i, 'hcsr501'],
  [/\b(mic|microphone|voice|audio|sound)/i, 'inmp441'],
  [/\b(speaker|amp)/i, 'max98357a'],
  [/\b(button|press|click)/i, 'tact-6mm'],
  [/\b(knob|encoder|dial)/i, 'ec11'],
  [/\b(touch)/i, 'ttp223'],
  [/\b(joystick|gamepad|controller)/i, 'joystick-ky023'],
  [/\b(keypad)/i, 'keypad-4x4'],
  [/\b(sd card|log|storage)/i, 'microsd-module'],
  [/\b(soil|moisture|plant)/i, 'ads1115'],
  [/\b(current|power monitor)/i, 'ina219'],
  [/\b(color|colour)/i, 'tcs34725'],
  [/\b(temp probe|ds18b20|waterproof temp)/i, 'ds18b20'],
]

function busFor(item: CatalogItem): Bus {
  if (item.category === 'actuator' && item.footprint.kind === 'terminal') return 'motor'
  if (item.category === 'power') return 'power'
  if (item.interfaces.includes('i2c')) return 'i2c'
  if (/ws2812|strip|uart|spi|i2s/.test(item.id + item.interfaces.join(' '))) return 'data'
  return 'gpio'
}

function railFor(item: CatalogItem, bus: Bus, battery: number): number {
  if (bus === 'motor' || bus === 'power') return battery
  if (item.voltage.min <= 3.3 && item.voltage.max >= 3.3) return 3.3
  return 5
}

/** Catalog items a brief asks for: explicit names first, then synonyms. */
export function devicesForBrief(text: string): CatalogItem[] {
  const lower = text.toLowerCase()
  const words = new Set(lower.split(/[^a-z0-9.+-]+/).filter((w) => w.length > 2))
  const scored = new Map<string, number>()
  for (const item of catalog) {
    if (SKIP.includes(item.category) || item.category === 'power') continue
    let score = 0
    if (lower.includes(item.id)) score += 6
    if (item.mpn && lower.includes(item.mpn.toLowerCase())) score += 6
    const nameHead = item.name.toLowerCase().split(/[ ,/]+/)[0]
    if (nameHead.length > 3 && words.has(nameHead)) score += 4
    for (const tag of item.tags) if (tag.length > 2 && !GENERIC_TAGS.has(tag) && words.has(tag.toLowerCase())) score += 3
    if (score) scored.set(item.id, score)
  }
  for (const [re, id] of SYNONYMS) if (re.test(text) && byId[id]) scored.set(id, (scored.get(id) ?? 0) + 2)
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => byId[id])
    .reduce<CatalogItem[]>((out, item) => {
      // One part per job: skip items that share a functional tag with a better match.
      const jobs = item.tags.filter((t) => !GENERIC_TAGS.has(t) && t !== item.id)
      if (!out.some((o) => o.tags.some((t) => jobs.includes(t)))) out.push(item)
      return out
    }, [])
    .slice(0, 7)
}

function titleFor(text: string, fallback: string) {
  const m = text.match(/(?:design|build|make|create)?\s*(?:an?|the)?\s*([a-z0-9 -]{3,40}?)\s+(?:using|with|that|for|which|to)\b/i)
  const raw = (m?.[1] ?? text.split(/[.,]/)[0]).trim().split(/\s+/).filter((w) => !/^(and|or|of|the|an?|my)$/i.test(w)).slice(-3).join(' ')
  const t = raw.replace(/\b\w/g, (c) => c.toUpperCase())
  return t.length >= 3 && t.length <= 32 ? t : fallback
}

const GENERIC_TAGS = new Set(['breakout', 'module', 'sensor', 'i2c', 'spi', 'uart', 'gpio', 'adc', 'analog', 'digital', '3.3v', '5v', 'light', 'led', 'board', 'power', 'low-power'])

const port = (i: number) => `J${i + 2}`

function wearable(text: string, picks: CatalogItem[]): SystemDesign {
  const emg = picks.filter((p) => p.id === 'myoware-emg')
  const others = picks.filter((p) => p.id !== 'myoware-emg').slice(0, 4)
  // Gesture bands read several muscle groups: three EMG channels around the forearm.
  const channels = emg.length ? (/\b(single|one)\b/i.test(text) ? 1 : 3) : 0
  const devices: SystemDevice[] = []
  const slots = [-62, 62, -96, 96, -128, 128]
  let slot = 0
  for (let i = 0; i < channels; i++) {
    devices.push({ id: `emg${i + 1}`, catalogId: 'myoware-emg', label: `EMG channel ${i + 1}`, role: `Muscle · ADC${i + 1}`, bus: 'gpio', port: 'J2', x: 0, z: slots[slot++], y: 0, rot: 90, rail: 3.3 })
  }
  others.forEach((item, i) => {
    const bus = busFor(item)
    devices.push({ id: `${item.id}-${i}`, catalogId: item.id, label: item.name, role: `${item.category} · ${bus.toUpperCase()}`, bus, port: port(i + 1), x: 0, z: slots[slot++] ?? 150, y: 0, rot: 90, rail: railFor(item, bus, 3.7) })
  })
  devices.push({ id: 'bat', catalogId: 'lipo-jst-ph-2', label: 'Battery', role: 'Power · 1S LiPo', bus: 'power', port: 'J1', x: 0, z: slots[slot++] ?? -150, y: 0, rot: 90, rail: 3.7 })
  return { name: titleFor(text, 'Wearable W1'), form: 'band', chassis: { w: 46, d: 330, t: 2.5 }, pcbHeight: 5, devices }
}

function plate(text: string, picks: CatalogItem[]): SystemDesign {
  const motors = picks.filter((p) => busFor(p) === 'motor')
  const rest = picks.filter((p) => busFor(p) !== 'motor')
  const n = rest.length
  const d = Math.max(180, 120 + Math.ceil(n / 2) * 42)
  const w = 170
  const devices: SystemDevice[] = []
  motors.slice(0, 4).forEach((item, i) => {
    const x = i % 2 ? 50 : -50
    const z = i < 2 ? -d / 2 + 40 : d / 2 - 40
    devices.push({ id: `m${i + 1}`, catalogId: item.id, label: `Drive ${i + 1}`, role: `Drive · ${port(i)}`, bus: 'motor', port: port(i), x, z, y: -22.5, rot: x < 0 ? 0 : 180, rail: 7.4 })
  })
  rest.forEach((item, i) => {
    const bus = busFor(item)
    const side = i % 2 ? 1 : -1
    const row = Math.floor(i / 2)
    const rows = Math.max(1, Math.ceil(n / 2))
    const z = -d / 2 + 30 + (row + 0.5) * ((d - 60) / rows)
    const x = Math.abs(z) < 48 ? side * (w / 2 - 22) : side * 34
    devices.push({ id: `${item.id}-${i}`, catalogId: item.id, label: item.name, role: `${item.category} · ${bus.toUpperCase()}`, bus, port: port(motors.length + i), x, z, y: bus === 'gpio' && item.id === 'hcsr04' ? 0 : 4, rot: 0, stand: item.id === 'hcsr04' || undefined, rail: railFor(item, bus, 7.4) })
  })
  devices.push({ id: 'bat', catalogId: 'holder-18650', label: 'Battery', role: 'Power · 2S Li-ion', bus: 'power', port: 'J1', x: 0, z: d / 2 - 22, y: 0, rot: 0, rail: 7.4 })
  return { name: titleFor(text, 'Device D1'), form: 'plate', chassis: { w, d, t: 3 }, pcbHeight: 12, devices }
}

/**
 * The off-board system for any brief. Rovers use the reference rover, wearables
 * a wrist band, everything else a mounting plate with the devices the brief asks
 * for. Never empty: with no matches it falls back to a status display and button.
 */

/** Multirotor airframe around a centre plate: arms, motors, rotors and skids. */
function airframe(text: string, picks: CatalogItem[]): SystemDesign {
  const base = plate(text, picks.filter((p) => busFor(p) !== 'motor'))
  const arms = /octo/i.test(text) ? 8 : /hexa/i.test(text) ? 6 : 4
  const { w, d } = base.chassis
  const reach = Math.hypot(w, d) / 2 + 95
  const structure: Prim[] = []
  for (let i = 0; i < arms; i++) {
    const a = ((i + 0.5) / arms) * Math.PI * 2
    const x = Math.sin(a) * reach
    const z = Math.cos(a) * reach
    const yaw = (a * 180) / Math.PI
    structure.push({ shape: 'box', size: [14, 5, reach], pos: [x / 2, -2.5, z / 2], yaw, mat: 'carbon' })
    structure.push({ shape: 'cyl', size: [14, 18, 0], pos: [x, 9, z], mat: 'metal' })
    structure.push({ shape: 'box', size: [124, 1.4, 13], pos: [x, 20, z], yaw: i * 37, mat: 'clear', spin: true })
    structure.push({ shape: 'cyl', size: [3, 34, 0], pos: [x * 0.55, -22, z * 0.55], mat: 'plastic' })
  }
  return { ...base, name: titleFor(text, 'Airframe A1'), structure }
}

/** Spectacle frame: rims, lenses, bridge, hinges and temples, with devices along the temples. */
function eyewear(text: string, picks: CatalogItem[]): SystemDesign {
  const base = plate(text, picks.filter((p) => busFor(p) !== 'motor').slice(0, 4))
  const y = 22, front = 62, r = 27, cx = 34, tx = cx + r + 9
  const structure: Prim[] = []
  for (const sx of [-1, 1]) {
    structure.push({ shape: 'ring', size: [r, 3, 0], pos: [sx * cx, y, front], mat: 'plastic' })
    structure.push({ shape: 'cyl', size: [r - 2, 1.6, 0], pos: [sx * cx, y, front], mat: 'clear', rot: [90, 0, 0] })
    structure.push({ shape: 'box', size: [12, 7, 5], pos: [sx * (cx + r + 4), y + 6, front], mat: 'plastic' })
    structure.push({ shape: 'box', size: [5, 8, 150], pos: [sx * tx, y + 6, front - 77], mat: 'plastic' })
    structure.push({ shape: 'box', size: [5, 16, 8], pos: [sx * tx, y, front - 152], mat: 'plastic' })
    structure.push({ shape: 'cyl', size: [3, 6, 0], pos: [sx * 9, y - 10, front - 6], mat: 'rubber' })
  }
  structure.push({ shape: 'box', size: [16, 5, 5], pos: [0, y + 8, front], mat: 'plastic' })
  const devices = base.devices.map((d, i) => {
    const side = i % 2 ? 1 : -1
    return { ...d, x: side * (tx + (d.id === 'bat' ? 0 : 10)), z: d.id === 'bat' ? front - 150 : front - 40 - Math.floor(i / 2) * 46, y: y + 10, stand: undefined }
  })
  return { ...base, name: titleFor(text, 'Eyewear E1'), form: 'none', chassis: { w: tx * 2, d: 170, t: 0 }, pcbHeight: y - 6, devices, structure }
}

/**
 * Enclosure built from the design itself, for any product with no dedicated shape:
 * walls as tall as the tallest device, a clear lid, corner posts, feet, and a
 * cable gland on the wall next to each device that sits at the edge.
 */
function tray(sys: SystemDesign): SystemDesign {
  const { w, d } = sys.chassis
  const tallest = Math.max(sys.pcbHeight + 14, ...sys.devices.map((v) => (byId[v.catalogId]?.dimensions.thickness ?? 8) + v.y + (v.stand ? byId[v.catalogId]?.dimensions.h ?? 0 : 0)))
  const h = Math.min(90, Math.ceil(tallest + 8))
  const wall = 2.4
  const structure: Prim[] = [
    { shape: 'box', size: [w, h, wall], pos: [0, h / 2, -d / 2 + wall / 2], mat: 'plastic' },
    { shape: 'box', size: [w, h, wall], pos: [0, h / 2, d / 2 - wall / 2], mat: 'plastic' },
    { shape: 'box', size: [wall, h, d], pos: [-w / 2 + wall / 2, h / 2, 0], mat: 'plastic' },
    { shape: 'box', size: [wall, h, d], pos: [w / 2 - wall / 2, h / 2, 0], mat: 'plastic' },
    { shape: 'box', size: [w, 1.6, d], pos: [0, h + 0.8, 0], mat: 'clear' },
  ]
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    structure.push({ shape: 'cyl', size: [7, 6, 0], pos: [sx * (w / 2 - 14), -6, sz * (d / 2 - 14)], mat: 'rubber' })
    structure.push({ shape: 'cyl', size: [3.2, h, 0], pos: [sx * (w / 2 - 7), h / 2, sz * (d / 2 - 7)], mat: 'metal' })
    structure.push({ shape: 'cyl', size: [2.2, 1.2, 0], pos: [sx * (w / 2 - 7), h + 2.2, sz * (d / 2 - 7)], mat: 'metal' })
  }
  for (const v of sys.devices) {
    const side = v.x < 0 ? -1 : 1
    if (Math.abs(v.x) < w / 2 - 30) continue
    structure.push({ shape: 'cyl', size: [5, 9, 0], pos: [side * (w / 2 + 2), Math.min(h - 8, v.y + 8), v.z], rot: [0, 0, 90], mat: 'metal' })
  }
  return { ...sys, structure }
}

/** Electronics on a base plate with a hand-built product body around them. */
function shaped(text: string, picks: CatalogItem[], fallback: string, body: (w: number, d: number) => Prim[]): SystemDesign {
  const parts = picks.filter((p) => busFor(p) !== 'motor')
  const base = plate(text, parts.length ? parts : [byId['ssd1306-096'], byId['tact-6mm']].filter(Boolean))
  return { ...base, name: titleFor(text, fallback), structure: body(base.chassis.w, base.chassis.d) }
}

/** Drip coffee machine: rear column, clear water reservoir, brew head over a glass jug on a drip tray. */
const brewer = (w: number, d: number): Prim[] => {
  const back = -d / 2 - 24, front = d / 2 + 52
  return [
    { shape: 'box', size: [w, 190, 44], pos: [0, 95, back], mat: 'plastic' },
    { shape: 'box', size: [w * 0.7, 120, 26], pos: [0, 120, back - 36], mat: 'clear' },
    { shape: 'box', size: [w, 34, d + 150], pos: [0, 207, 26], mat: 'plastic' },
    { shape: 'cyl', size: [24, 20, 0], pos: [0, 180, front], mat: 'metal' },
    { shape: 'cyl', size: [5, 12, 0], pos: [0, 164, front], mat: 'metal' },
    { shape: 'box', size: [w, 8, 96], pos: [0, -4, front], mat: 'metal' },
    { shape: 'cyl', size: [40, 3, 0], pos: [0, 1.5, front], mat: 'metal' },
    { shape: 'cyl', size: [36, 86, 0], pos: [0, 46, front], mat: 'clear' },
    { shape: 'cyl', size: [38, 6, 0], pos: [0, 92, front], mat: 'plastic' },
    { shape: 'box', size: [8, 52, 14], pos: [44, 50, front], mat: 'plastic' },
    ...[-1, 1].flatMap((sx): Prim[] => [-1, 1].map((sz) => ({ shape: 'cyl', size: [8, 6, 0], pos: [sx * (w / 2 - 12), -9, sz * (d / 2 - 4) + 12], mat: 'rubber' }))),
  ]
}

/** Desk lamp: weighted base, upright, angled arm, shade and bulb over the electronics. */
const lamp = (w: number, d: number): Prim[] => {
  const back = -d / 2 - 22
  return [
    { shape: 'cyl', size: [34, 8, 0], pos: [0, -4, back], mat: 'metal' },
    { shape: 'cyl', size: [5, 230, 0], pos: [0, 115, back], mat: 'metal' },
    { shape: 'sphere', size: [9, 9, 9], pos: [0, 232, back], mat: 'metal' },
    { shape: 'box', size: [8, 8, 150], pos: [0, 252, back + 68], rot: [-16, 0, 0], mat: 'metal' },
    { shape: 'sphere', size: [8, 8, 8], pos: [0, 272, back + 138], mat: 'metal' },
    { shape: 'cyl', size: [46, 44, 0], pos: [0, 252, back + 150], mat: 'metal' },
    { shape: 'cyl', size: [14, 16, 0], pos: [0, 280, back + 150], mat: 'plastic' },
    { shape: 'sphere', size: [20, 20, 20], pos: [0, 232, back + 150], mat: 'clear' },
    { shape: 'cyl', size: [3, w * 0.6, 0], pos: [0, 4, d / 2 + 14], rot: [0, 0, 90], mat: 'rubber' },
  ]
}

/** Open-frame 3D printer: four uprights, top rails, X gantry with hotend, heated bed and a filament spool. */
const printer = (w: number, d: number): Prim[] => {
  const fx = w / 2 + 30, fz = d / 2 + 30, top = 260, gy = 150
  const parts: Prim[] = []
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push({ shape: 'box', size: [14, top + 20, 14], pos: [sx * fx, top / 2 - 10, sz * fz], mat: 'metal' })
      parts.push({ shape: 'cyl', size: [9, 6, 0], pos: [sx * fx, -23, sz * fz], mat: 'rubber' })
    }
    parts.push({ shape: 'box', size: [14, 14, fz * 2], pos: [sx * fx, top, 0], mat: 'metal' })
    parts.push({ shape: 'box', size: [14, 14, fz * 2], pos: [sx * fx, -13, 0], mat: 'metal' })
    parts.push({ shape: 'cyl', size: [4, top, 0], pos: [sx * (fx - 16), top / 2, 0], mat: 'metal' })
    parts.push({ shape: 'box', size: [26, 30, 34], pos: [sx * (fx - 16), gy, 0], mat: 'plastic' })
  }
  for (const sz of [-1, 1]) parts.push({ shape: 'box', size: [fx * 2, 14, 14], pos: [0, top, sz * fz], mat: 'metal' })
  parts.push({ shape: 'box', size: [fx * 2 - 30, 8, 8], pos: [0, gy + 8, 0], mat: 'metal' })
  parts.push({ shape: 'box', size: [fx * 2 - 30, 8, 8], pos: [0, gy - 8, 0], mat: 'metal' })
  parts.push({ shape: 'box', size: [40, 46, 36], pos: [-18, gy, 22], mat: 'plastic' })
  parts.push({ shape: 'cyl', size: [9, 22, 0], pos: [-18, gy - 34, 22], mat: 'metal' })
  parts.push({ shape: 'cyl', size: [2, 10, 0], pos: [-18, gy - 50, 22], mat: 'metal' })
  parts.push({ shape: 'box', size: [w + 20, 3, d + 20], pos: [0, 62, 0], mat: 'clear' })
  parts.push({ shape: 'box', size: [w, 4, d], pos: [0, 58, 0], mat: 'metal' })
  parts.push({ shape: 'ring', size: [54, 16, 0], pos: [0, top + 70, -fz], mat: 'plastic' })
  parts.push({ shape: 'box', size: [8, 70, 8], pos: [0, top + 35, -fz], mat: 'metal' })
  return parts
}

export function systemFromPrompt(text: string): SystemDesign {
  const picks = devicesForBrief(text)
  if (FLYER.test(text)) return airframe(text, picks)
  if (EYEWEAR.test(text)) return eyewear(text, picks)
  // A wearable brief always gets the band, before any vehicle or appliance body.
  if (WEARABLE.test(text)) return wearable(text, picks)
  if (VEHICLE.test(text)) {
    const roverTags = new Set(defaultSystem.devices.flatMap((d) => byId[d.catalogId]?.tags ?? []).filter((t) => !GENERIC_TAGS.has(t)))
    const extra = picks.filter((p) => busFor(p) !== 'motor' && !p.tags.some((t) => roverTags.has(t))).slice(0, 2)
    if (!extra.length) return { ...defaultSystem, name: titleFor(text, defaultSystem.name) }
    const base = plate(text, extra)
    return { ...defaultSystem, name: titleFor(text, defaultSystem.name), devices: [...defaultSystem.devices, ...base.devices.filter((d) => d.id !== 'bat').map((d, i) => ({ ...d, port: `J${8 + i}`, x: i % 2 ? 58 : -58, z: 0 }))] }
  }
  if (BREWER.test(text)) return shaped(text, picks, 'Brewer B1', brewer)
  if (PRINTER.test(text)) return shaped(text, picks, 'Printer P1', printer)
  if (LAMP.test(text)) return shaped(text, picks, 'Lamp L1', lamp)
  const sys = plate(text, picks.length ? picks : [byId['ssd1306-096'], byId['tact-6mm']].filter(Boolean))
  // Wheeled builds keep an open plate so the drive motors and wheels stay visible.
  return sys.devices.some((d) => d.bus === 'motor') ? sys : tray(sys)
}

/** Demo briefs. Each one must produce a working system and board. */
export const DEMO_BRIEFS: { id: string; label: string; brief: string }[] = [
  { id: 'wristband', label: 'EMG wristband', brief: 'Design a BLE wristband using EMG muscle sensors for finger gesture control, with haptic feedback.' },
  { id: 'rover', label: 'Rover', brief: 'Build a 4WD rover with an ultrasonic range finder, IMU, OLED status display and an LED light bar.' },
  { id: 'weather', label: 'Weather station', brief: 'Make a solar weather station with a BME280 temperature and humidity sensor and an e-paper display over LoRa.' },
  { id: 'plant', label: 'Plant waterer', brief: 'Create a smart plant watering system with a soil moisture sensor, a pump relay and Wi-Fi alerts.' },
  { id: 'pulse', label: 'Pulse monitor', brief: 'Build a fingertip heart rate and SpO2 monitor with an OLED display and a buzzer alarm.' },
  { id: 'drone', label: 'Drone', brief: 'Build a quadcopter drone with an IMU, GPS and a barometer for altitude hold.' },
  { id: 'glasses', label: 'Smart glasses', brief: 'Design smart glasses with a heads-up OLED display, an IMU and a touch button.' },
  { id: 'coffee', label: 'Coffee machine', brief: 'Make a smart coffee machine with a temperature sensor, a pump relay, an OLED display and a brew button.' },
  { id: 'lamp', label: 'Desk lamp', brief: 'Build a smart desk lamp with an LED strip, a light sensor and a touch dimmer over Wi-Fi.' },
  { id: 'printer', label: '3D printer', brief: 'Design a compact 3D printer controller with a hotend temperature sensor, an OLED status screen and a buzzer.' },
]

export const unitPrice = (item: CatalogItem) => item.pricing[0]?.unit ?? 0

export function systemCost(sys: SystemDesign) {
  return sys.devices.reduce((sum, d) => sum + unitPrice(byId[d.catalogId]), 0)
}

export interface Alternative {
  item: CatalogItem
  score: number
  price: number
  delta: number // vs current, USD
  currentDelta: number // mA vs current
  reasons: string[]
  warnings: string[]
  current: boolean
}

/**
 * Compatible replacements for a device: same category, shares an electrical
 * interface (or is a listed alternate), and runs from the device's rail.
 */
export function alternativesFor(dev: SystemDevice): Alternative[] {
  const cur = byId[dev.catalogId]
  if (!cur) return []
  const out: Alternative[] = []
  for (const item of catalog) {
    const isCur = item.id === cur.id
    const listed = cur.alternates.includes(item.id) || item.alternates.includes(cur.id)
    if (!isCur && item.category !== cur.category) continue
    const shared = item.interfaces.filter((i) => cur.interfaces.includes(i))
    if (!isCur && !listed && shared.length === 0) continue
    // keep motors with motors, displays with displays of similar kind
    if (!isCur && !listed && item.footprint.kind !== cur.footprint.kind) continue
    const reasons: string[] = []
    const warnings: string[] = []
    if (isCur) reasons.push('Current selection')
    if (listed) reasons.push('Drop-in alternate')
    if (shared.length) reasons.push(`Shares ${shared.map((s) => s.toUpperCase()).join(' / ')}`)
    const railOk = item.voltage.min <= dev.rail + 0.05 && item.voltage.max >= dev.rail - 0.05
    if (railOk) reasons.push(`Runs on ${dev.rail} V rail`)
    else warnings.push(`Needs ${item.voltage.min}–${item.voltage.max} V, rail is ${dev.rail} V`)
    if (item.voltage.logic > 3.6 && dev.bus !== 'motor' && dev.bus !== 'power') warnings.push(`${item.voltage.logic} V logic — level shift to ESP32`)
    const fits = item.dimensions.w <= cur.dimensions.w * 1.25 && item.dimensions.h <= cur.dimensions.h * 1.25
    if (!fits) warnings.push(`Larger: ${item.dimensions.w}×${item.dimensions.h} mm`)
    const score = (isCur ? 100 : 0) + (listed ? 6 : 0) + shared.length * 2 + (railOk ? 3 : -4) + (fits ? 1 : 0) + item.popularity / 40
    const price = unitPrice(item)
    out.push({
      item, score, price, delta: price - unitPrice(cur), currentDelta: item.currentMa - cur.currentMa,
      reasons, warnings, current: isCur,
    })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 7)
}
