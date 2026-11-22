import { ladder, retail, type CatalogItem, type DesignRules } from './types.ts'

/**
 * Generic passives and connectors. `resistorItem` snaps to E24 so an agent
 * can mint a value that is not in the prelisted set. Footprint `kind` is the
 * closest body the studio can draw; the package string is the real one.
 * `designRules` are usual economic limits, not a live quote.
 */

export const E24 = [
  1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0,
  3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1,
] as const

export type ChipSize = '0402' | '0603' | '0805'

function tidy(n: number): number {
  if (n >= 100) return Math.round(n)
  if (n >= 10) return Math.round(n * 10) / 10
  if (n >= 1) return Math.round(n * 100) / 100
  return Math.round(n * 1000) / 1000
}

/** Closest E24 value in ohms. Returns 0 for a non-positive input. */
export function nearestE24(ohms: number): number {
  if (!(ohms > 0) || !Number.isFinite(ohms)) return 0
  const exp = Math.floor(Math.log10(ohms))
  let best = 0
  let bestErr = Infinity
  for (let d = exp - 1; d <= exp + 1; d++) {
    const scale = 10 ** d
    for (const m of E24) {
      const v = tidy(m * scale)
      const err = Math.abs(Math.log(v / ohms))
      if (err < bestErr) {
        best = v
        bestErr = err
      }
    }
  }
  return best
}

function trimNum(n: number): string {
  const t = tidy(n)
  return Number.isInteger(t) ? String(t) : String(t)
}

/** `10k`, `4.7k`, `10Ω`, `0Ω`. */
export function formatResistance(ohms: number): string {
  if (ohms === 0) return '0Ω'
  if (ohms >= 1e6) return `${trimNum(ohms / 1e6)}M`
  if (ohms >= 1e3) return `${trimNum(ohms / 1e3)}k`
  return `${trimNum(ohms)}Ω`
}

/** Catalog `value` without a unit glyph: `10k`, `4.7k`, `10`, `0`. */
function resistanceValue(ohms: number): string {
  if (ohms === 0) return '0'
  if (ohms >= 1e6) return `${trimNum(ohms / 1e6)}M`
  if (ohms >= 1e3) return `${trimNum(ohms / 1e3)}k`
  return String(tidy(ohms))
}

/** Yageo shorthand: 10R, 2K2, 4K7, 10K, 1M. */
function yageoToken(ohms: number): string {
  if (ohms === 0) return '0R'
  const token = (n: number, mark: string) => {
    const t = tidy(n)
    if (Number.isInteger(t)) return `${t}${mark}`
    const [whole, frac] = String(t).split('.')
    return `${whole}${mark}${frac}`
  }
  if (ohms < 1000) return token(ohms, 'R')
  if (ohms < 1e6) return token(ohms / 1000, 'K')
  return token(ohms / 1e6, 'M')
}

const RESISTOR = {
  '0402': { w: 1.0, h: 0.5, t: 0.35, power: '1/16 W', vmax: 50, price: [0.012, 0.004, 0.0015] as const },
  '0603': { w: 1.6, h: 0.8, t: 0.45, power: '1/10 W', vmax: 75, price: [0.01, 0.003, 0.001] as const },
  '0805': { w: 2.0, h: 1.25, t: 0.5, power: '1/8 W', vmax: 150, price: [0.012, 0.004, 0.0012] as const },
} as const

function resistorId(size: ChipSize, ohms: number): string {
  return `r-${size}-${resistanceValue(ohms).toLowerCase()}`
}

/**
 * One thick-film resistor. Positive ohms snap to E24. Zero is a jumper.
 * 0402 omits `footprint.size` because the renderer only knows 0603 and 0805.
 */
export function resistorItem(size: ChipSize, ohms: number, popularity = 160): CatalogItem {
  const snapped = ohms === 0 ? 0 : nearestE24(ohms)
  const spec = RESISTOR[size]
  const jumper = snapped === 0
  const token = yageoToken(snapped)
  const mpn = jumper ? `RC${size}JR-07${token}L` : `RC${size}FR-07${token}L`
  const value = resistanceValue(snapped)
  const others = (['0402', '0603', '0805'] as const).filter((s) => s !== size)
  return {
    id: resistorId(size, snapped),
    name: jumper ? `${size} 0 Ω jumper` : `${size} ${formatResistance(snapped)} resistor`,
    category: 'passive',
    manufacturer: 'Yageo',
    mpn,
    description: jumper
      ? `${size} thick-film jumper, Yageo ${mpn}. The J tolerance mark is the usual 0 Ω ordering code. Resistance is under 50 mΩ.`
      : `${size} thick-film resistor, ${formatResistance(snapped)} ±1%, ${spec.power}, ${spec.vmax} V working. Yageo ordering code ${mpn}.`,
    tags: jumper ? ['resistor', 'jumper', '0r', size] : ['resistor', 'e24', value.toLowerCase(), size],
    interfaces: [],
    voltage: { min: 0, max: spec.vmax, logic: 0 },
    currentMa: 0,
    dimensions: { w: spec.w, h: spec.h, thickness: spec.t },
    pins: [
      { name: '1', fn: 'Terminal' },
      { name: '2', fn: 'Terminal' },
    ],
    mounting: 'smd',
    footprint: size === '0402' ? { kind: 'chip', pkg: '0402' } : { kind: 'chip', pkg: size, size },
    pricing: ladder(spec.price[0], spec.price[1], spec.price[2]),
    alternates: others.map((s) => resistorId(s, snapped)),
    popularity,
    value,
    notes: size === '0402'
      ? 'The studio chip footprint has no 0402 body, so this lands as an 0805 outline until a 0402 pad stack exists.'
      : undefined,
  }
}

const COMMON_OHMS = [0, 10, 100, 220, 330, 470, 1000, 2200, 4700, 10000, 22000, 47000, 100000, 1_000_000]

function resistorPopularity(size: ChipSize, ohms: number): number {
  if (size === '0603' && ohms === 10_000) return 24
  if (size === '0603' && ohms === 1000) return 46
  if (size === '0603' && ohms === 4700) return 47
  if (size === '0603' && ohms === 100) return 49
  return 155
}

const resistors: CatalogItem[] = (['0402', '0603', '0805'] as const).flatMap((size) =>
  COMMON_OHMS.map((ohms) => resistorItem(size, ohms, resistorPopularity(size, ohms))),
)

interface CapSpec {
  id: string
  size: ChipSize
  value: string
  mpn: string
  volts: number
  dielectric: string
  t: number
  price: readonly [number, number, number]
  popularity: number
  mpnApprox?: boolean
  thicknessApprox?: boolean
  notes?: string
  alternates: string[]
}

const CERAMIC_BODY: Record<ChipSize, { w: number; h: number }> = {
  '0402': { w: 1.0, h: 0.5 },
  '0603': { w: 1.6, h: 0.8 },
  '0805': { w: 2.0, h: 1.25 },
}

function mlcc(spec: CapSpec): CatalogItem {
  const body = CERAMIC_BODY[spec.size]
  const approxFields = [
    ...(spec.mpnApprox ? ['mpn'] : []),
    ...(spec.thicknessApprox ? ['dimensions.thickness'] : []),
  ]
  return {
    id: spec.id,
    name: `${spec.size} ${spec.value} MLCC`,
    category: 'passive',
    manufacturer: 'Murata',
    mpn: spec.mpn,
    description: `${spec.size} multilayer ceramic, ${spec.value}, ${spec.volts} V, ${spec.dielectric}. Decouple a power pin with the 100 nF; use 1 µF and up for bulk next to a regulator or a radio.`,
    tags: ['mlcc', 'capacitor', 'ceramic', spec.value.toLowerCase(), spec.size],
    interfaces: [],
    voltage: { min: 0, max: spec.volts, logic: 0 },
    currentMa: 0,
    dimensions: { w: body.w, h: body.h, thickness: spec.t },
    pins: [
      { name: '1', fn: 'Terminal' },
      { name: '2', fn: 'Terminal' },
    ],
    mounting: 'smd',
    footprint: spec.size === '0402' ? { kind: 'chip', pkg: '0402' } : { kind: 'chip', pkg: spec.size, size: spec.size },
    pricing: ladder(spec.price[0], spec.price[1], spec.price[2]),
    alternates: spec.alternates,
    popularity: spec.popularity,
    value: spec.value,
    approx: approxFields.length > 0,
    approxFields: approxFields.length > 0 ? approxFields : undefined,
    notes: spec.notes ?? (spec.size === '0402'
      ? 'Rendered as an 0805 chip. The real body is 1.0 × 0.5 mm.'
      : undefined),
  }
}

const ceramics: CatalogItem[] = [
  mlcc({
    id: 'c-0402-100n',
    size: '0402',
    value: '100nF',
    mpn: 'GRM155R71C104KA88D',
    volts: 16,
    dielectric: 'X7R ±10%',
    t: 0.5,
    price: [0.012, 0.004, 0.0015],
    popularity: 156,
    mpnApprox: true,
    notes: '0402 100 nF 16 V X7R is the usual Murata GRM155 code. The packing suffix is the part to confirm. Rendered as an 0805 chip.',
    alternates: ['c-0603-100n', 'c-0805-100n'],
  }),
  mlcc({
    id: 'c-0603-100n',
    size: '0603',
    value: '100nF',
    mpn: 'GRM188R71H104KA93D',
    volts: 50,
    dielectric: 'X7R ±10%',
    t: 0.8,
    price: [0.01, 0.003, 0.001],
    popularity: 25,
    notes: 'Classic 0603 100 nF 50 V X7R. Some distributors list this exact Murata code as obsolete; any current 0603 100 nF X7R at 16 V or more is the substitute.',
    alternates: ['c-0402-100n', 'c-0805-100n'],
  }),
  mlcc({
    id: 'c-0805-100n',
    size: '0805',
    value: '100nF',
    mpn: 'GRM21BR71H104KA01L',
    volts: 50,
    dielectric: 'X7R ±10%',
    t: 0.85,
    price: [0.015, 0.005, 0.002],
    popularity: 157,
    mpnApprox: true,
    thicknessApprox: true,
    alternates: ['c-0603-100n', 'c-0402-100n'],
  }),
  mlcc({
    id: 'c-0402-1u',
    size: '0402',
    value: '1uF',
    mpn: 'GRM155R61A105KE15D',
    volts: 10,
    dielectric: 'X5R ±10%',
    t: 0.5,
    price: [0.02, 0.008, 0.003],
    popularity: 170,
    mpnApprox: true,
    notes: '0402 1 µF is voltage-limited, commonly 6.3 V or 10 V X5R. Confirm the suffix. Rendered as an 0805 chip.',
    alternates: ['c-0603-1u', 'c-0805-1u'],
  }),
  mlcc({
    id: 'c-0603-1u',
    size: '0603',
    value: '1uF',
    mpn: 'GRM188R61C105KA93D',
    volts: 16,
    dielectric: 'X5R ±10%',
    t: 0.8,
    price: [0.02, 0.008, 0.003],
    popularity: 80,
    mpnApprox: true,
    alternates: ['c-0402-1u', 'c-0805-1u'],
  }),
  mlcc({
    id: 'c-0805-1u',
    size: '0805',
    value: '1uF',
    mpn: 'GRM21BR71H105KA12L',
    volts: 50,
    dielectric: 'X7R ±10%',
    t: 1.25,
    price: [0.03, 0.012, 0.005],
    popularity: 158,
    mpnApprox: true,
    thicknessApprox: true,
    alternates: ['c-0603-1u', 'c-0402-1u'],
  }),
  mlcc({
    id: 'c-0603-10u',
    size: '0603',
    value: '10uF',
    mpn: 'GRM188R60J106ME47D',
    volts: 6.3,
    dielectric: 'X5R ±20%',
    t: 0.8,
    price: [0.06, 0.025, 0.012],
    popularity: 90,
    mpnApprox: true,
    thicknessApprox: true,
    notes: '0603 10 µF only exists at low voltage. Do not put it on a 12 V rail.',
    alternates: ['c-0805-10u'],
  }),
  mlcc({
    id: 'c-0805-10u',
    size: '0805',
    value: '10uF',
    mpn: 'GRM21BR61A106KE19L',
    volts: 10,
    dielectric: 'X5R ±10%',
    t: 1.25,
    price: [0.06, 0.025, 0.012],
    popularity: 85,
    mpnApprox: true,
    thicknessApprox: true,
    alternates: ['c-0603-10u', 'c-0805-22u'],
  }),
  mlcc({
    id: 'c-0805-22u',
    size: '0805',
    value: '22uF',
    mpn: 'GRM21BR60J226ME39L',
    volts: 6.3,
    dielectric: 'X5R ±20%',
    t: 1.25,
    price: [0.1, 0.04, 0.02],
    popularity: 110,
    notes: '0805 22 µF 6.3 V X5R, body 2.0 × 1.25 × 1.25 mm. Capacitance falls hard under DC bias.',
    alternates: ['c-0805-10u'],
  }),
]

interface EcapSpec {
  id: string
  value: string
  mpn: string
  manufacturer: string
  volts: number
  diameter: number
  length: number
  price: readonly [number, number, number]
  popularity: number
  approx: boolean
  notes: string
  alternates: string[]
}

function ecap(spec: EcapSpec): CatalogItem {
  return {
    id: spec.id,
    name: `${spec.value} ${spec.volts} V electrolytic`,
    category: 'passive',
    manufacturer: spec.manufacturer,
    mpn: spec.mpn,
    description: `Radial aluminium electrolytic, ${spec.value}, ${spec.volts} V, about Ø${spec.diameter} × ${spec.length} mm. Observe polarity. The studio draws a generic two-pad radial body.`,
    tags: ['electrolytic', 'capacitor', spec.value.toLowerCase(), 'radial'],
    interfaces: [],
    voltage: { min: 0, max: spec.volts, logic: 0 },
    currentMa: 0,
    dimensions: { w: spec.diameter, h: spec.diameter, thickness: spec.length },
    pins: [
      { name: '+', fn: 'Positive. The longer lead, and the pad that is not marked with the stripe.' },
      { name: '−', fn: 'Negative. The can stripe.' },
    ],
    mounting: 'tht',
    footprint: { kind: 'ecap', pkg: `radial Ø${spec.diameter}` },
    pricing: ladder(spec.price[0], spec.price[1], spec.price[2]),
    alternates: spec.alternates,
    popularity: spec.popularity,
    value: spec.value,
    approx: spec.approx,
    approxFields: spec.approx ? ['mpn', 'dimensions'] : undefined,
    notes: spec.notes,
  }
}

const electrolytics: CatalogItem[] = [
  ecap({
    id: 'ecap-10u-25',
    value: '10uF',
    mpn: 'UVR1E100MDD',
    manufacturer: 'Nichicon',
    volts: 25,
    diameter: 5,
    length: 11,
    price: [0.08, 0.04, 0.02],
    popularity: 140,
    approx: true,
    notes: 'Nichicon UVR general-purpose series, 10 µF 25 V, typically 5 × 11 mm. Confirm the case suffix before ordering.',
    alternates: ['ecap-100u-16', 'c-0805-10u'],
  }),
  ecap({
    id: 'ecap-100u-16',
    value: '100uF',
    mpn: 'UVR1C101MED',
    manufacturer: 'Nichicon',
    volts: 16,
    diameter: 6.3,
    length: 11,
    price: [0.1, 0.05, 0.025],
    popularity: 130,
    approx: true,
    notes: '100 µF 16 V radial, typically 6.3 × 11 mm. The UVR suffix is an estimate.',
    alternates: ['ecap-10u-25', 'ecap-220u-25'],
  }),
  ecap({
    id: 'ecap-220u-25',
    value: '220uF',
    mpn: 'RVT1E221M0810',
    manufacturer: 'Rubycon',
    volts: 25,
    diameter: 8,
    length: 10,
    price: [0.12, 0.06, 0.03],
    popularity: 100,
    approx: false,
    notes: 'Rubycon RVT, 220 µF 25 V, 8 × 10 mm. Same part the sample motor board uses.',
    alternates: ['ecap-100u-16', 'ecap-470u-16'],
  }),
  ecap({
    id: 'ecap-470u-16',
    value: '470uF',
    mpn: 'UVR1C471MPD',
    manufacturer: 'Nichicon',
    volts: 16,
    diameter: 8,
    length: 12,
    price: [0.16, 0.08, 0.04],
    popularity: 135,
    approx: true,
    notes: '470 µF 16 V radial. Case is commonly 8 × 11.5 mm or 10 × 12.5 mm; 8 × 12 mm here is a planning size.',
    alternates: ['ecap-220u-25', 'ecap-100u-16'],
  }),
]

interface LedSpec {
  id: string
  name: string
  mpn: string
  manufacturer: string
  color: string
  pkg: string
  size?: '0603' | '0805'
  mounting: 'smd' | 'tht'
  w: number
  h: number
  t: number
  vfMin: number
  vfMax: number
  popularity: number
  approx?: boolean
  approxFields?: string[]
  notes?: string
  alternates: string[]
  price?: number
}

function led(spec: LedSpec): CatalogItem {
  return {
    id: spec.id,
    name: spec.name,
    category: 'indicator',
    manufacturer: spec.manufacturer,
    mpn: spec.mpn,
    description: `${spec.color} indicator LED, ${spec.pkg}. Design the series resistor for 5–20 mA; 10 mA is a normal panel current. Forward voltage below is the range at that current, not a supply rail.`,
    tags: ['led', spec.color.toLowerCase(), spec.pkg.toLowerCase(), 'indicator'],
    interfaces: ['gpio'],
    voltage: { min: spec.vfMin, max: spec.vfMax, logic: 0 },
    currentMa: 10,
    dimensions: { w: spec.w, h: spec.h, thickness: spec.t },
    pins: [
      { name: 'A', fn: 'Anode, positive' },
      { name: 'K', fn: 'Cathode, the marked end or the flat / shorter lead' },
    ],
    mounting: spec.mounting,
    footprint: spec.size
      ? { kind: 'led', pkg: spec.pkg, size: spec.size }
      : { kind: 'led', pkg: spec.pkg },
    pricing: ladder(spec.price ?? 0.05, 0.02, 0.008),
    alternates: spec.alternates,
    popularity: spec.popularity,
    value: spec.color.toLowerCase(),
    approx: spec.approx,
    approxFields: spec.approxFields,
    notes: spec.notes,
  }
}

const leds: CatalogItem[] = [
  led({
    id: 'led-0603-red',
    name: '0603 red LED',
    mpn: 'LTST-C190KRKT',
    manufacturer: 'Lite-On',
    color: 'Red',
    pkg: '0603',
    size: '0603',
    mounting: 'smd',
    w: 1.6, h: 0.8, t: 0.6,
    vfMin: 1.6, vfMax: 2.4,
    popularity: 50,
    alternates: ['led-0603-green', 'led-0603-yellow', 'led-0805-red', 'led-3mm-red', 'led-5mm-red'],
  }),
  led({
    id: 'led-0603-green',
    name: '0603 green LED',
    mpn: 'LTST-C190KGKT',
    manufacturer: 'Lite-On',
    color: 'Green',
    pkg: '0603',
    size: '0603',
    mounting: 'smd',
    w: 1.6, h: 0.8, t: 0.6,
    vfMin: 1.8, vfMax: 2.4,
    popularity: 72,
    alternates: ['led-0603-red', 'led-0603-blue', 'led-0603-yellow'],
  }),
  led({
    id: 'led-0603-blue',
    name: '0603 blue LED',
    mpn: 'LTST-C190TBKT',
    manufacturer: 'Lite-On',
    color: 'Blue',
    pkg: '0603',
    size: '0603',
    mounting: 'smd',
    w: 1.6, h: 0.8, t: 0.6,
    vfMin: 2.6, vfMax: 3.4,
    popularity: 96,
    approx: true,
    approxFields: ['voltage'],
    alternates: ['led-0603-green', 'led-0603-red'],
    notes: 'Blue Vf is commonly near 3 V and may not fully light from a weak 3.3 V GPIO without checking the bin.',
  }),
  led({
    id: 'led-0603-yellow',
    name: '0603 yellow LED',
    mpn: 'LTST-C190YKT',
    manufacturer: 'Lite-On',
    color: 'Yellow',
    pkg: '0603',
    size: '0603',
    mounting: 'smd',
    w: 1.6, h: 0.8, t: 0.6,
    vfMin: 1.8, vfMax: 2.4,
    popularity: 120,
    approx: true,
    approxFields: ['mpn'],
    alternates: ['led-0603-red', 'led-0603-green'],
    notes: 'LTST-C190 yellow ordering code is easy to confuse with the orange bin. Confirm the colour letter before buying.',
  }),
  led({
    id: 'led-0805-red',
    name: '0805 red LED',
    mpn: 'LTST-C170KRKT',
    manufacturer: 'Lite-On',
    color: 'Red',
    pkg: '0805',
    size: '0805',
    mounting: 'smd',
    w: 2.0, h: 1.25, t: 0.8,
    vfMin: 1.6, vfMax: 2.4,
    popularity: 88,
    alternates: ['led-0603-red', 'led-5mm-red'],
    notes: 'The studio LED body is drawn at 0603 size even when the pads are 0805.',
  }),
  led({
    id: 'led-3mm-red',
    name: '3 mm red LED',
    mpn: 'WP710A10ID',
    manufacturer: 'Kingbright',
    color: 'Red',
    pkg: 'T-1 3mm',
    mounting: 'tht',
    w: 3, h: 3, t: 5.3,
    vfMin: 1.7, vfMax: 2.4,
    popularity: 74,
    approx: true,
    approxFields: ['dimensions'],
    alternates: ['led-5mm-red', 'led-0603-red'],
    notes: 'Diffused 3 mm red. Body length excludes the leads. The studio draws a 0603 LED body as a stand-in.',
  }),
  led({
    id: 'led-5mm-red',
    name: '5 mm red LED',
    mpn: 'WP7113ID',
    manufacturer: 'Kingbright',
    color: 'Red',
    pkg: 'T-1 3/4 5mm',
    mounting: 'tht',
    w: 5, h: 5, t: 8.6,
    vfMin: 1.7, vfMax: 2.4,
    popularity: 60,
    approx: true,
    approxFields: ['dimensions'],
    alternates: ['led-3mm-red', 'led-0603-red'],
    notes: 'Diffused 5 mm red, the common panel LED. Body length excludes the leads. Drawn as a 0603 LED stand-in.',
  }),
]

const diodes: CatalogItem[] = [
  {
    id: '1n4148w',
    name: '1N4148W switching diode',
    category: 'passive',
    manufacturer: 'Diodes Incorporated',
    mpn: '1N4148W-7-F',
    description:
      '100 V small-signal diode in SOD-123, the SMD form of the 1N4148. Continuous forward current is about 150 mA; peak is higher for a short pulse. The axial DO-35 1N4148 is the through-hole alternate. Drawn as an 0805 chip.',
    tags: ['diode', '1n4148', 'switching', 'sod-123'],
    interfaces: [],
    voltage: { min: 0, max: 100, logic: 0 },
    currentMa: 0,
    ioutMa: 150,
    dimensions: { w: 2.7, h: 1.6, thickness: 1.15 },
    pins: [
      { name: 'A', fn: 'Anode' },
      { name: 'K', fn: 'Cathode, the banded end' },
    ],
    mounting: 'smd',
    footprint: { kind: 'chip', pkg: 'SOD-123' },
    pricing: ladder(0.04, 0.015, 0.006),
    alternates: ['1n5819', 'ss34'],
    popularity: 65,
    notes: 'Axial 1N4148 is documented at https://www.vishay.com/docs/81857/1n4148.pdf. This row is the SOD-123 part, not that DO-35 body. Vr 75 V on some 1N4148W bins and 100 V on the Diodes Inc datasheet; 100 V is used here.',
  },
  {
    id: 'ss34',
    name: 'SS34 Schottky',
    category: 'passive',
    manufacturer: 'Vishay',
    mpn: 'SS34-E3/57T',
    description:
      'SMA Schottky, 40 V, 3 A. Use it as a buck catch diode or a reverse-protection diode where a 1N4148 would overheat. The studio draws an 0805 chip; the real land is an SMA (DO-214AC) pad, about 4.5 × 2.8 mm.',
    tags: ['diode', 'schottky', 'ss34', 'sma'],
    interfaces: [],
    voltage: { min: 0, max: 40, logic: 0 },
    currentMa: 0,
    ioutMa: 3000,
    dimensions: { w: 4.5, h: 2.8, thickness: 2.15 },
    pins: [
      { name: 'A', fn: 'Anode' },
      { name: 'K', fn: 'Cathode, the band' },
    ],
    mounting: 'smd',
    footprint: { kind: 'chip', pkg: 'SMA', size: '0805' },
    pricing: ladder(0.1, 0.04, 0.018),
    datasheetUrl: 'https://www.vishay.com/docs/88751/ss32.pdf',
    alternates: ['1n5819', '1n4148w'],
    popularity: 78,
  },
  {
    id: '1n5819',
    name: '1N5819 Schottky',
    category: 'passive',
    manufacturer: 'Vishay',
    mpn: '1N5819-E3/54',
    description:
      'Axial Schottky, DO-41, 40 V, 1 A. The through-hole companion to the SS34. Forward drop is about 0.4 V at a few hundred milliamps. Drawn as a chip stand-in.',
    tags: ['diode', 'schottky', '1n5819', 'do-41'],
    interfaces: [],
    voltage: { min: 0, max: 40, logic: 0 },
    currentMa: 0,
    ioutMa: 1000,
    dimensions: { w: 2.7, h: 5.2, thickness: 2.7 },
    pins: [
      { name: 'A', fn: 'Anode' },
      { name: 'K', fn: 'Cathode, the band' },
    ],
    mounting: 'tht',
    footprint: { kind: 'chip', pkg: 'DO-41' },
    pricing: ladder(0.06, 0.025, 0.01),
    datasheetUrl: 'https://www.vishay.com/docs/88525/1n5817.pdf',
    alternates: ['ss34', '1n4148w'],
    popularity: 82,
    approx: true,
    approxFields: ['dimensions'],
  },
]

const mosfets: CatalogItem[] = [
  {
    id: '2n7002',
    name: '2N7002 N-MOSFET',
    category: 'driver',
    manufacturer: 'onsemi',
    mpn: '2N7002',
    description:
      'SOT-23 N-channel MOSFET, 60 V. The small-signal switch for a relay, a buzzer, or a logic-level load under a couple of hundred milliamps. Continuous current depends on the vendor and the copper; plan on about 115 mA and read the datasheet if the load is larger. Drawn as an SOT-223 stand-in.',
    tags: ['mosfet', 'n-channel', '2n7002', 'sot-23'],
    interfaces: ['gpio'],
    voltage: { min: 0, max: 60, logic: 0 },
    currentMa: 0,
    ioutMa: 115,
    dimensions: { w: 2.9, h: 1.3, thickness: 1.0 },
    pins: [
      { name: '1 G', fn: 'Gate. onsemi pinout.' },
      { name: '2 S', fn: 'Source' },
      { name: '3 D', fn: 'Drain' },
    ],
    mounting: 'smd',
    footprint: { kind: 'sot223', pkg: 'SOT-23' },
    pricing: ladder(0.05, 0.02, 0.008),
    datasheetUrl: 'https://www.onsemi.com/pdf/datasheet/2n7002-d.pdf',
    alternates: ['bss138', 'ao3400'],
    popularity: 40,
    approx: true,
    approxFields: ['ioutMa', 'dimensions'],
    notes: 'Vgs(th) is about 2.1 V typical. A 3.3 V GPIO turns it on for light loads. Some second-source 2N7002 parts claim 200 mA or more.',
  },
  {
    id: 'bss138',
    name: 'BSS138 N-MOSFET',
    category: 'driver',
    manufacturer: 'onsemi',
    mpn: 'BSS138',
    description:
      'SOT-23 N-channel, 50 V, about 200 mA. The usual MOSFET in a discrete I2C level shifter (one device per line, gate at the low-side rail). Drawn as an SOT-223 stand-in.',
    tags: ['mosfet', 'n-channel', 'bss138', 'level-shifter', 'sot-23'],
    interfaces: ['gpio', 'i2c'],
    voltage: { min: 0, max: 50, logic: 0 },
    currentMa: 0,
    ioutMa: 200,
    dimensions: { w: 2.9, h: 1.3, thickness: 1.0 },
    pins: [
      { name: '1 G', fn: 'Gate' },
      { name: '2 S', fn: 'Source, the low-voltage side in a shifter' },
      { name: '3 D', fn: 'Drain' },
    ],
    mounting: 'smd',
    footprint: { kind: 'sot223', pkg: 'SOT-23' },
    pricing: ladder(0.06, 0.02, 0.01),
    datasheetUrl: 'https://www.onsemi.com/pdf/datasheet/bss138-d.pdf',
    alternates: ['2n7002', 'ao3400'],
    popularity: 64,
    approx: true,
    approxFields: ['dimensions'],
  },
  {
    id: 'ao3400',
    name: 'AO3400 N-MOSFET',
    category: 'driver',
    manufacturer: 'Alpha & Omega',
    mpn: 'AO3400',
    description:
      'SOT-23 N-channel, 30 V. Rds(on) is roughly 30 mΩ at 10 V and about 50 mΩ at 4.5 V, so a 3.3 V GPIO can switch a couple of amps if the copper can take the heat. The silicon limit is 5.7 A; a small pad will not. Drawn as an SOT-223 stand-in.',
    tags: ['mosfet', 'n-channel', 'ao3400', 'logic-level', 'sot-23'],
    interfaces: ['gpio'],
    voltage: { min: 0, max: 30, logic: 0 },
    currentMa: 0,
    ioutMa: 2000,
    dimensions: { w: 2.9, h: 1.3, thickness: 1.0 },
    pins: [
      { name: '1 G', fn: 'Gate' },
      { name: '2 S', fn: 'Source' },
      { name: '3 D', fn: 'Drain' },
    ],
    mounting: 'smd',
    footprint: { kind: 'sot223', pkg: 'SOT-23' },
    pricing: ladder(0.08, 0.03, 0.012),
    datasheetUrl: 'https://www.aosmd.com/sites/default/files/res/datasheets/AO3400.pdf',
    alternates: ['2n7002', 'irlz44n'],
    popularity: 58,
    approx: true,
    approxFields: ['ioutMa', 'dimensions'],
    notes: '2 A is a practical PCB current, not the 5.7 A datasheet pulse rating.',
  },
]

const crystals: CatalogItem[] = [
  {
    id: 'xtal-8mhz',
    name: '8 MHz crystal 3225',
    category: 'passive',
    manufacturer: 'Abracon',
    mpn: 'ABM8G-8.000MHZ',
    description:
      '3.2 × 2.5 mm SMD crystal, 8.000 MHz, typically 12 pF load. ABM8G is the Abracon 3225 family; the full order code adds load, tolerance and packing. Drawn as an 0805 chip. A 4-pad land uses pads 1 and 3 for the crystal.',
    tags: ['crystal', '8mhz', '3225', 'xtal'],
    interfaces: [],
    voltage: { min: 0, max: 0, logic: 0 },
    currentMa: 0,
    dimensions: { w: 3.2, h: 2.5, thickness: 0.8 },
    pins: [
      { name: '1', fn: 'Crystal' },
      { name: '2', fn: 'GND or NC, on a 4-pad land' },
      { name: '3', fn: 'Crystal' },
      { name: '4', fn: 'GND or NC' },
    ],
    mounting: 'smd',
    footprint: { kind: 'chip', pkg: '3225' },
    pricing: retail(0.28),
    alternates: ['xtal-12mhz', 'xtal-16mhz'],
    popularity: 112,
    approx: true,
    approxFields: ['mpn', 'dimensions.thickness'],
  },
  {
    id: 'xtal-12mhz',
    name: '12 MHz crystal 3225',
    category: 'passive',
    manufacturer: 'Abracon',
    mpn: 'ABM8G-12.000MHZ',
    description:
      '3.2 × 2.5 mm crystal, 12.000 MHz, typically 12 pF. Common USB full-speed clock. Confirm the Abracon load-capacitance suffix. Drawn as an 0805 chip.',
    tags: ['crystal', '12mhz', '3225', 'usb', 'xtal'],
    interfaces: [],
    voltage: { min: 0, max: 0, logic: 0 },
    currentMa: 0,
    dimensions: { w: 3.2, h: 2.5, thickness: 0.8 },
    pins: [
      { name: '1', fn: 'Crystal' },
      { name: '2', fn: 'GND or NC' },
      { name: '3', fn: 'Crystal' },
      { name: '4', fn: 'GND or NC' },
    ],
    mounting: 'smd',
    footprint: { kind: 'chip', pkg: '3225' },
    pricing: retail(0.28),
    alternates: ['xtal-8mhz', 'xtal-16mhz'],
    popularity: 108,
    approx: true,
    approxFields: ['mpn', 'dimensions.thickness'],
  },
  {
    id: 'xtal-16mhz',
    name: '16 MHz crystal 3225',
    category: 'passive',
    manufacturer: 'Abracon',
    mpn: 'ABM8G-16.000MHZ',
    description:
      '3.2 × 2.5 mm crystal, 16.000 MHz, typically 12 pF. The ATmega328P and a lot of USB MCUs use this. Confirm the load suffix. Drawn as an 0805 chip.',
    tags: ['crystal', '16mhz', '3225', 'avr', 'xtal'],
    interfaces: [],
    voltage: { min: 0, max: 0, logic: 0 },
    currentMa: 0,
    dimensions: { w: 3.2, h: 2.5, thickness: 0.8 },
    pins: [
      { name: '1', fn: 'Crystal' },
      { name: '2', fn: 'GND or NC' },
      { name: '3', fn: 'Crystal' },
      { name: '4', fn: 'GND or NC' },
    ],
    mounting: 'smd',
    footprint: { kind: 'chip', pkg: '3225' },
    pricing: retail(0.28),
    alternates: ['xtal-8mhz', 'xtal-12mhz'],
    popularity: 86,
    approx: true,
    approxFields: ['mpn', 'dimensions.thickness'],
  },
  {
    id: 'xtal-32k768',
    name: '32.768 kHz crystal',
    category: 'passive',
    manufacturer: 'Abracon',
    mpn: 'ABS07-32.768KHZ-T',
    description:
      'Watch crystal, 32.768 kHz, 3.2 × 1.5 mm, typically 12.5 pF. Used for an RTC. The load-capacitance letter in the Abracon code is the digit to confirm. Drawn as an 0805 chip; the real land is two pads on a 3215 body.',
    tags: ['crystal', '32.768khz', 'rtc', 'watch', '3215'],
    interfaces: [],
    voltage: { min: 0, max: 0, logic: 0 },
    currentMa: 0,
    dimensions: { w: 3.2, h: 1.5, thickness: 0.9 },
    pins: [
      { name: '1', fn: 'Crystal' },
      { name: '2', fn: 'Crystal' },
    ],
    mounting: 'smd',
    footprint: { kind: 'chip', pkg: '3215' },
    pricing: retail(0.32),
    alternates: ['xtal-16mhz'],
    popularity: 102,
    approx: true,
    approxFields: ['mpn', 'dimensions'],
  },
]

const ferrite: CatalogItem = {
  id: 'ferrite-0603-600r',
  name: '0603 ferrite bead 600 Ω',
  category: 'passive',
  manufacturer: 'Murata',
  mpn: 'BLM18PG601SN1D',
  description:
    '0603 ferrite, 600 Ω at 100 MHz. Series element on a noisy 3.3 V or USB rail. Rated current is a few hundred milliamps and depends on the impedance curve and the allowed temperature rise; use the Murata plot instead of a single amp number.',
  tags: ['ferrite', 'bead', '0603', 'emi'],
  interfaces: [],
  voltage: { min: 0, max: 0, logic: 0 },
  currentMa: 0,
  dimensions: { w: 1.6, h: 0.8, thickness: 0.8 },
  pins: [
    { name: '1', fn: 'Terminal' },
    { name: '2', fn: 'Terminal' },
  ],
  mounting: 'smd',
  footprint: { kind: 'chip', pkg: '0603', size: '0603' },
  pricing: ladder(0.04, 0.015, 0.006),
  alternates: [],
  popularity: 70,
  value: '600R@100MHz',
}

const usbC: CatalogItem = {
  id: 'usbc-16p',
  name: 'USB-C 16-pin receptacle',
  category: 'connector',
  manufacturer: 'Korean Hroparts',
  mpn: 'TYPE-C-31-M-12',
  description:
    'USB Type-C receptacle, 16 power and data pins, the part the sample board uses. Enough for USB 2.0 (D+, D−) plus VBUS, GND and CC. It does not break out the SuperSpeed pairs. Plan on about 3 A and treat a higher VBUS as something to confirm on the drawing.',
  tags: ['usb-c', 'connector', 'receptacle', '16p'],
  interfaces: ['usb'],
  voltage: { min: 0, max: 20, logic: 5 },
  currentMa: 0,
  ioutMa: 3000,
  dimensions: { w: 9.2, h: 7.3, thickness: 3.2 },
  pins: [
    { name: 'A1 / B12', fn: 'GND' },
    { name: 'A4 / B9', fn: 'VBUS' },
    { name: 'A5', fn: 'CC1' },
    { name: 'B5', fn: 'CC2' },
    { name: 'A6', fn: 'D+' },
    { name: 'A7', fn: 'D−' },
    { name: 'A8', fn: 'SBU1' },
    { name: 'B8', fn: 'SBU2' },
    { name: 'SHELL', fn: 'Shield, tie to GND through a capacitor or directly per the USB-C note you are following' },
  ],
  mounting: 'smd',
  footprint: { kind: 'usbc', pkg: 'USB-C-16P' },
  pricing: retail(0.24),
  alternates: ['micro-usb-b'],
  popularity: 32,
  approx: true,
  approxFields: ['dimensions', 'ioutMa', 'voltage.max'],
  notes: 'Same MPN as the sample board J1. Shell pads are part of the studio USB-C footprint.',
}

const microUsb: CatalogItem = {
  id: 'micro-usb-b',
  name: 'Micro-USB B receptacle',
  category: 'connector',
  manufacturer: 'Molex',
  mpn: '47346-0001',
  description:
    'Micro-USB B, bottom-mount, right-angle, with flange. Five contacts. Molex rates the power contacts at 1.8 A and the signal contacts at 1.0 A, 30 V. The studio draws a USB-C shell as the stand-in.',
  tags: ['micro-usb', 'usb', 'connector', 'receptacle'],
  interfaces: ['usb'],
  voltage: { min: 0, max: 30, logic: 5 },
  currentMa: 0,
  ioutMa: 1800,
  dimensions: { w: 7.5, h: 5.6, thickness: 2.6 },
  pins: [
    { name: '1', fn: 'VBUS' },
    { name: '2', fn: 'D−' },
    { name: '3', fn: 'D+' },
    { name: '4', fn: 'ID, open on a B receptacle used as a device' },
    { name: '5', fn: 'GND' },
    { name: 'SHELL', fn: 'Shield' },
  ],
  mounting: 'smd',
  footprint: { kind: 'usbc', pkg: 'Micro-USB-B' },
  pricing: retail(0.55),
  alternates: ['usbc-16p'],
  popularity: 66,
  approx: true,
  approxFields: ['dimensions'],
}

function jst(family: 'ph' | 'xh', n: number): CatalogItem {
  const ph = family === 'ph'
  const pitch = ph ? 2.0 : 2.5
  const mpn = ph ? `S${n}B-PH-K-S` : `B${n}B-XH-A`
  const neighbors: string[] = []
  if (n > 2) neighbors.push(`jst-${family}-${n - 1}`)
  if (n < 6) neighbors.push(`jst-${family}-${n + 1}`)
  neighbors.push(ph ? `jst-xh-${n}` : `jst-ph-${n}`)
  if (ph && n === 2) neighbors.push('lipo-jst-ph-2')
  return {
    id: `jst-${family}-${n}`,
    name: `JST ${family.toUpperCase()} ${n}-pin`,
    category: 'connector',
    manufacturer: 'JST',
    mpn,
    description: ph
      ? `JST PH side-entry header, ${n} circuits, 2.0 mm pitch, through-hole. Series rating 2 A, 100 V. AWG 24 is often derated to 1 A in the JST catalog. Mates with PHR-${n} housings.`
      : `JST XH top-entry header, ${n} circuits, 2.5 mm pitch, through-hole. Series rating 3 A, 250 V. Mates with XHP-${n} housings.`,
    tags: ['jst', family, 'connector', `${n}p`, `${pitch}mm`],
    interfaces: [],
    voltage: { min: 0, max: ph ? 100 : 250, logic: 0 },
    currentMa: 0,
    ioutMa: ph ? 2000 : 3000,
    dimensions: {
      w: ph ? 6.5 : 5.8,
      h: (ph ? 4.0 : 4.9) + (n - 1) * pitch,
      thickness: ph ? 6.0 : 9.2,
    },
    pins: Array.from({ length: n }, (_, i) => ({ name: `${i + 1}`, fn: 'Contact' })),
    mounting: 'tht',
    footprint: { kind: 'header', pkg: `JST-${family.toUpperCase()} ${n}P ${pitch}`, pins: n },
    pricing: retail(ph ? 0.08 + 0.03 * n : 0.1 + 0.04 * n),
    alternates: neighbors,
    popularity: ph && n === 2 ? 36 : 140 + n,
    approx: true,
    approxFields: ['dimensions'],
    notes: ph
      ? 'S*B-PH-K-S is the side-entry shrouded header. B*B-PH-K-S is the top-entry part if the cable must leave vertically.'
      : 'B*B-XH-A is the top-entry shrouded header. The studio draws a single 2.54 mm row; the real pitch is 2.5 mm.',
  }
}

const jstParts: CatalogItem[] = [
  ...([2, 3, 4, 5, 6] as const).map((n) => jst('ph', n)),
  ...([2, 3, 4, 5, 6] as const).map((n) => jst('xh', n)),
]

const HEADER_1 = [2, 3, 4, 6, 8, 10, 16, 20, 40]
const HEADER_2 = [2, 3, 4, 5, 8, 10, 20]

function pinHeader(rows: 1 | 2, n: number, series: number[]): CatalogItem {
  const i = series.indexOf(n)
  const alternates: string[] = []
  if (i > 0) alternates.push(`header-${rows}x${series[i - 1]}`)
  if (i >= 0 && i + 1 < series.length) alternates.push(`header-${rows}x${series[i + 1]}`)
  const pins = n <= 8
    ? Array.from({ length: n }, (_, k) => ({ name: `${k + 1}`, fn: rows === 2 ? `Row pair ${k + 1}` : 'Pin' }))
    : [
        { name: '1', fn: 'Pin 1, usually marked with a square pad' },
        { name: `${n}`, fn: `Pin ${n}` },
      ]
  const popularity = rows === 1 && n === 40 ? 42 : rows === 2 && n === 20 ? 44 : 150 + n
  return {
    id: `header-${rows}x${n}`,
    name: `Pin header ${rows}×${n} 2.54 mm`,
    category: 'connector',
    manufacturer: 'generic',
    mpn: `HDR-${rows}x${n}-2.54`,
    description: rows === 1
      ? `Breakaway pin header, 1 row of ${n}, 2.54 mm pitch. Unshrouded. A typical pin is rated around 3 A. Sold by the strip; snap to length.`
      : `Pin header, 2 rows of ${n} (2×${n}), 2.54 mm pitch. The studio draws one row and uses the pin count per row; the package string carries the real 2×${n} geometry.`,
    tags: ['header', '2.54', `${rows}x${n}`, 'pin-header'],
    interfaces: ['gpio'],
    voltage: { min: 0, max: 250, logic: 0 },
    currentMa: 0,
    ioutMa: 3000,
    dimensions: { w: rows === 1 ? 2.54 : 5.08, h: n * 2.54, thickness: 8.5 },
    pins,
    mounting: 'tht',
    footprint: { kind: 'header', pkg: `THT ${rows}×${n} 2.54`, pins: n },
    pricing: retail(Math.max(0.05, Math.round(0.015 * n * rows * 100) / 100)),
    alternates,
    popularity,
    approx: true,
    approxFields: ['mpn', 'dimensions', 'voltage.max', 'ioutMa'],
    notes: 'Generic breakaway header. Pitch and row count are the controlled numbers; there is no single manufacturer MPN.',
  }
}

const headers: CatalogItem[] = [
  ...HEADER_1.map((n) => pinHeader(1, n, HEADER_1)),
  ...HEADER_2.map((n) => pinHeader(2, n, HEADER_2)),
]

const screws: CatalogItem[] = [
  {
    id: 'screw-508-2',
    name: 'Screw terminal 5.08 mm 2-pin',
    category: 'connector',
    manufacturer: 'Phoenix Contact',
    mpn: 'MKDS 1/2-5.08',
    description:
      '5.08 mm pitch screw terminal, 2 positions, wire-to-board. MKDS 1/2-5.08 is the Phoenix series; the numeric order code depends on colour. A generic 5.08 mm block is the usual substitute. Plan on about 10 A and confirm the exact part.',
    tags: ['screw-terminal', '5.08', '2p', 'phoenix'],
    interfaces: [],
    voltage: { min: 0, max: 300, logic: 0 },
    currentMa: 0,
    ioutMa: 10000,
    dimensions: { w: 10.2, h: 8.2, thickness: 13 },
    pins: [
      { name: '1', fn: 'Contact' },
      { name: '2', fn: 'Contact' },
    ],
    mounting: 'tht',
    footprint: { kind: 'terminal', pkg: '5.08 mm 2P', pins: 2 },
    pricing: retail(0.38),
    alternates: ['screw-508-3', 'barrel-5521'],
    popularity: 76,
    approx: true,
    approxFields: ['mpn', 'dimensions', 'ioutMa', 'voltage.max'],
    notes: 'The sample board KF301 is 5.0 mm pitch, not 5.08 mm. This row is the 5.08 mm Euroblock.',
  },
  {
    id: 'screw-508-3',
    name: 'Screw terminal 5.08 mm 3-pin',
    category: 'connector',
    manufacturer: 'Phoenix Contact',
    mpn: 'MKDS 1/3-5.08',
    description:
      '5.08 mm pitch screw terminal, 3 positions. Same caveat as the 2-pin block: series name, not a single order code. About 10 A.',
    tags: ['screw-terminal', '5.08', '3p', 'phoenix'],
    interfaces: [],
    voltage: { min: 0, max: 300, logic: 0 },
    currentMa: 0,
    ioutMa: 10000,
    dimensions: { w: 15.2, h: 8.2, thickness: 13 },
    pins: [
      { name: '1', fn: 'Contact' },
      { name: '2', fn: 'Contact' },
      { name: '3', fn: 'Contact' },
    ],
    mounting: 'tht',
    footprint: { kind: 'terminal', pkg: '5.08 mm 3P', pins: 3 },
    pricing: retail(0.48),
    alternates: ['screw-508-2'],
    popularity: 98,
    approx: true,
    approxFields: ['mpn', 'dimensions', 'ioutMa', 'voltage.max'],
  },
]

const barrel: CatalogItem = {
  id: 'barrel-5521',
  name: 'Barrel jack 5.5 mm',
  category: 'connector',
  manufacturer: 'Same Sky',
  mpn: 'PJ-002A',
  description:
    'Right-angle DC barrel jack. The center pin is Ø2.0 mm and it mates with the common 5.5 × 2.1 mm plug. Rated 24 VDC, 2.5 A. Three contacts: tip, sleeve, and a switch that opens when the plug is inserted. Formerly sold as CUI Devices.',
  tags: ['barrel', 'dc-jack', '5.5x2.1', 'pj-002a'],
  interfaces: [],
  voltage: { min: 0, max: 24, logic: 0 },
  currentMa: 0,
  ioutMa: 2500,
  dimensions: { w: 14, h: 9, thickness: 11 },
  pins: [
    { name: 'tip', fn: 'Center contact. Usually the positive on a wall wart.' },
    { name: 'sleeve', fn: 'Outer contact. Usually ground.' },
    { name: 'switch', fn: 'Normally closed to the sleeve; opens when a plug is in.' },
  ],
  mounting: 'tht',
  footprint: { kind: 'terminal', pkg: 'barrel 5.5', pins: 3 },
  pricing: retail(0.85),
  alternates: ['screw-508-2', 'usbc-16p'],
  popularity: 68,
  approx: true,
  approxFields: ['dimensions'],
  notes: 'The studio terminal footprint is a 5.08 mm row, not the PJ-002A eyelet pattern. Pin Ø2.0 mm is the jack; the plug inner diameter is 2.1 mm.',
}

const protection: CatalogItem[] = [
  {
    id: 'ptc-1206-500ma',
    name: 'PTC 1206 0.5 A',
    category: 'passive',
    manufacturer: 'Bourns',
    mpn: 'MF-NSMF050-2',
    description:
      'Resettable PTC, Bourns Multifuse 1206, 6 V, 0.50 A hold. The NSMF number is the hold current in hundredths of an amp, matching the 1.10 A NSMF110 code in the same 1206 family. Right for a USB VBUS rail, not for 12 V.',
    tags: ['ptc', 'fuse', 'polyfuse', '1206', 'usb'],
    interfaces: [],
    voltage: { min: 0, max: 6, logic: 0 },
    currentMa: 0,
    ioutMa: 500,
    dimensions: { w: 3.2, h: 1.6, thickness: 0.6 },
    pins: [
      { name: '1', fn: 'Terminal' },
      { name: '2', fn: 'Terminal' },
    ],
    mounting: 'smd',
    footprint: { kind: 'chip', pkg: '1206' },
    pricing: retail(0.12),
    alternates: ['ptc-1812-1a1', 'fuse-1206-1a'],
    popularity: 92,
    approx: true,
    approxFields: ['dimensions'],
    notes: 'Drawn as an 0805 chip. Hold current falls as temperature rises. Trip current is higher than 0.50 A.',
  },
  {
    id: 'ptc-1812-1a1',
    name: 'PTC 1812 1.1 A',
    category: 'passive',
    manufacturer: 'Bourns',
    mpn: 'MF-MSMF110-2',
    description:
      'Resettable PTC, Bourns Multifuse 1812, 6 V, 1.1 A hold, about 2.2 A trip. Body about 4.7 × 3.4 × 0.85 mm. A USB source fuse when 0.5 A is too small. Not a 12 V part.',
    tags: ['ptc', 'fuse', 'polyfuse', '1812', 'usb'],
    interfaces: [],
    voltage: { min: 0, max: 6, logic: 0 },
    currentMa: 0,
    ioutMa: 1100,
    dimensions: { w: 4.73, h: 3.41, thickness: 0.85 },
    pins: [
      { name: '1', fn: 'Terminal' },
      { name: '2', fn: 'Terminal' },
    ],
    mounting: 'smd',
    footprint: { kind: 'chip', pkg: '1812' },
    pricing: retail(0.22),
    alternates: ['ptc-1206-500ma', 'fuse-1206-1a'],
    popularity: 104,
    notes: 'Drawn as an 0805 chip. The 1812 land is larger.',
  },
  {
    id: 'fuse-1206-1a',
    name: 'Fuse 1206 1 A',
    category: 'passive',
    manufacturer: 'Littelfuse',
    mpn: '0451001.MRL',
    description:
      'One-time 1206 fast-acting fuse, 1 A, Littelfuse 0451 series. Unlike the PTCs above it does not reset. Confirm the voltage rating and the reel suffix on the current datasheet; 32 V is a safe planning number and several 0451 codes are rated higher.',
    tags: ['fuse', '1206', 'fast-acting'],
    interfaces: [],
    voltage: { min: 0, max: 32, logic: 0 },
    currentMa: 0,
    ioutMa: 1000,
    dimensions: { w: 3.2, h: 1.6, thickness: 0.6 },
    pins: [
      { name: '1', fn: 'Terminal' },
      { name: '2', fn: 'Terminal' },
    ],
    mounting: 'smd',
    footprint: { kind: 'chip', pkg: '1206' },
    pricing: retail(0.18),
    alternates: ['ptc-1206-500ma', 'ptc-1812-1a1'],
    popularity: 118,
    approx: true,
    approxFields: ['mpn', 'voltage.max', 'dimensions'],
    notes: 'Drawn as an 0805 chip.',
  },
  {
    id: 'usblc6-2sc6',
    name: 'USBLC6-2SC6',
    category: 'passive',
    manufacturer: 'STMicroelectronics',
    mpn: 'USBLC6-2SC6',
    description:
      'USB 2.0 low-capacitance TVS array, SOT-23-6. Two data lines plus VBUS, all clamped to ground. Put it next to the connector. The studio draws an SOT-223 stand-in; the real package is SOT-23-6.',
    tags: ['tvs', 'esd', 'usb', 'sot-23-6'],
    interfaces: ['usb'],
    voltage: { min: 0, max: 5.25, logic: 0 },
    currentMa: 0,
    dimensions: { w: 2.9, h: 1.6, thickness: 1.15 },
    pins: [
      { name: '1', fn: 'I/O1' },
      { name: '2', fn: 'GND' },
      { name: '3', fn: 'I/O2' },
      { name: '4', fn: 'I/O2' },
      { name: '5', fn: 'VBUS' },
      { name: '6', fn: 'I/O1' },
    ],
    mounting: 'smd',
    footprint: { kind: 'sot223', pkg: 'SOT-23-6' },
    pricing: retail(0.28),
    datasheetUrl: 'https://www.st.com/resource/en/datasheet/usblc6-2.pdf',
    alternates: ['usbc-16p'],
    popularity: 84,
    notes: 'Line capacitance is a few picofarads; use the datasheet figure rather than a remembered one. VBUS standoff is 5.25 V.',
  },
]

export const generalParts: CatalogItem[] = [
  ...resistors,
  ...ceramics,
  ...electrolytics,
  ...leds,
  ...diodes,
  ...mosfets,
  ...crystals,
  ferrite,
  usbC,
  microUsb,
  ...jstParts,
  ...headers,
  ...screws,
  barrel,
  ...protection,
]

const MASK = ['green', 'red', 'yellow', 'blue', 'white', 'black', 'purple']
const FINISH = ['HASL leaded', 'HASL lead-free', 'ENIG']

export const designRules: DesignRules[] = [
  {
    id: 'jlcpcb-2l',
    vendor: 'JLCPCB',
    layers: 2,
    name: 'JLCPCB 2-layer economic',
    minTraceMm: 0.127,
    minSpaceMm: 0.127,
    minViaDrillMm: 0.3,
    minAnnularMm: 0.075,
    minViaPadMm: 0.45,
    boardThicknessMm: [0.4, 0.6, 0.8, 1.0, 1.2, 1.6, 2.0],
    defaultThicknessMm: 1.6,
    copperOz: [1, 2],
    soldermask: MASK,
    silkscreen: ['white', 'black'],
    surfaceFinish: FINISH,
    minCopperEdgeMm: 0.3,
    notes:
      'Trace and space are 5/5 mil. The 0.30 mm drill and 0.45 mm pad (0.075 mm annular) are the tight via; prefer a 0.30 / 0.60 mm drill and pad unless the quote allows the smaller ring. 1.6 mm is the default thickness. Confirm the current capability page before a production order.',
  },
  {
    id: 'jlcpcb-4l',
    vendor: 'JLCPCB',
    layers: 4,
    name: 'JLCPCB 4-layer',
    minTraceMm: 0.09,
    minSpaceMm: 0.09,
    minViaDrillMm: 0.2,
    minAnnularMm: 0.075,
    minViaPadMm: 0.45,
    boardThicknessMm: [0.8, 1.0, 1.2, 1.6, 2.0],
    defaultThicknessMm: 1.6,
    copperOz: [1],
    soldermask: MASK,
    silkscreen: ['white', 'black'],
    surfaceFinish: FINISH,
    minCopperEdgeMm: 0.3,
    approx: true,
    notes:
      'Some JLCPCB quotes list 3.5 mil (0.09 mm) and others 4 mil (0.10 mm) as the 4-layer minimum. If the quote says 4 mil, use 0.10 mm. Inner copper is commonly 0.5 oz even when the outer is 1 oz. Prefer a 0.30 / 0.60 mm via.',
  },
  {
    id: 'pcbway-2l',
    vendor: 'PCBWay',
    layers: 2,
    name: 'PCBWay 2-layer capability',
    minTraceMm: 0.1,
    minSpaceMm: 0.1,
    minViaDrillMm: 0.2,
    minAnnularMm: 0.127,
    minViaPadMm: 0.45,
    boardThicknessMm: [0.4, 0.6, 0.8, 1.0, 1.2, 1.6, 2.0],
    defaultThicknessMm: 1.6,
    copperOz: [1, 2],
    soldermask: [...MASK, 'matte black', 'matte green'],
    silkscreen: ['white', 'black'],
    surfaceFinish: FINISH,
    minCopperEdgeMm: 0.3,
    notes:
      'Capability is about 0.10 mm trace and space, 0.20 mm drill, and at least 0.127 mm annular ring. A comfortable board is 0.15 mm trace and space with a 0.30 / 0.60 mm via. Matte black and matte green are extra mask choices.',
  },
  {
    id: 'pcbway-4l',
    vendor: 'PCBWay',
    layers: 4,
    name: 'PCBWay 4-layer',
    minTraceMm: 0.09,
    minSpaceMm: 0.09,
    minViaDrillMm: 0.2,
    minAnnularMm: 0.127,
    minViaPadMm: 0.45,
    boardThicknessMm: [0.8, 1.0, 1.2, 1.6, 2.0],
    defaultThicknessMm: 1.6,
    copperOz: [1],
    soldermask: [...MASK, 'matte black', 'matte green'],
    silkscreen: ['white', 'black'],
    surfaceFinish: FINISH,
    minCopperEdgeMm: 0.3,
    approx: true,
    notes:
      '4-layer minimum track is quoted as 3.5 mil or 4 mil depending on the process. Use 0.10 mm if the quote says 4 mil. Inner layers are often 0.5 oz. The comfortable via is still 0.30 / 0.60 mm.',
  },
]
