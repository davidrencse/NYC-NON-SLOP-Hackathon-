import type { PartKind } from '../board.ts'

/**
 * Static hardware catalog. Numbers marked `approx` are best estimates,
 * not datasheet figures. `dimensions.thickness` is the PCB thickness for a
 * dev board and the body height for a component. Hole and header coordinates
 * are millimetres from the board centre; each board's `frame` says which way
 * +x and +y point.
 */

export type CatalogCategory =
  | 'board'
  | 'mcu'
  | 'module'
  | 'sensor'
  | 'actuator'
  | 'driver'
  | 'power'
  | 'display'
  | 'connector'
  | 'passive'
  | 'input'
  | 'indicator'
  | 'comms'
  | 'storage'
  | 'audio'

/** Preferred interface tokens. Items may use others. */
export const INTERFACE_NAMES = [
  'i2c',
  'spi',
  'uart',
  'usb',
  'gpio',
  'pwm',
  'adc',
  'dac',
  'can',
  'wifi',
  'ble',
  'bluetooth',
  'i2s',
  'sdio',
  'onewire',
  'swd',
  'jtag',
  'ethernet',
  'lora',
  'analog',
  'qwiic',
  'stemma',
  'pdm',
] as const

export interface CatalogPin {
  name: string
  /** Short function, for example "I2C SDA" or "GPIO / ADC". */
  fn: string
}

export interface CatalogVoltage {
  /** Minimum supply the catalogued form accepts, volts. */
  min: number
  /** Maximum supply, volts. */
  max: number
  /** Logic high the I/O expects, volts. 0 when the part has no logic rail. */
  logic: number
}

export interface CatalogDimensions {
  w: number
  h: number
  thickness: number
}

export interface CatalogPrice {
  qty: number
  /** USD each at this break. */
  unit: number
}

export interface CatalogFootprint {
  /** Closest kind `padsFor` / `bodyFor` know how to draw. */
  kind: PartKind
  pkg: string
  /** Pin count for `header` and `terminal` footprints. */
  pins?: number
  /** Chip body for `chip` and `led`. 0402 has no renderer size and is omitted. */
  size?: '0603' | '0805'
}

export interface MountingHole {
  x: number
  y: number
  /** Drill diameter, mm. */
  d: number
}

export interface BoardHeader {
  name: string
  pins: number
  rows?: 1 | 2
  pitch: number
  /** Centre of the header. Omitted when the drawing was not to hand. */
  x?: number
  y?: number
  rot?: number
}

export interface CatalogItem {
  id: string
  name: string
  category: CatalogCategory
  manufacturer: string
  mpn: string
  description: string
  tags: string[]
  interfaces: string[]
  voltage: CatalogVoltage
  /** Typical supply current in milliamps. 0 for a passive with no standing current. */
  currentMa: number
  dimensions: CatalogDimensions
  pins: CatalogPin[]
  mounting: 'smd' | 'tht' | 'module' | 'board'
  footprint: CatalogFootprint
  pricing: CatalogPrice[]
  /** Real manufacturer document. Omitted rather than guessed. */
  datasheetUrl?: string
  alternates: string[]
  /** 1 is the most popular. */
  popularity: number
  /** True when any numeric field is an estimate. See `approxFields`. */
  approx?: boolean
  /** Field paths that are estimates, for example "dimensions" or "mpn". */
  approxFields?: string[]
  /** Copied onto `Part.value` for passives. */
  value?: string
  /** Served asset, for example `/models/kb2040.glb`. */
  model?: string
  holes?: MountingHole[]
  headers?: BoardHeader[]
  /** How to read `holes` and `headers`. */
  frame?: string
  /** Output current a regulator or driver can source, mA. */
  ioutMa?: number
  notes?: string
}

export interface DesignRules {
  id: string
  vendor: string
  layers: 2 | 4
  name: string
  minTraceMm: number
  minSpaceMm: number
  minViaDrillMm: number
  minAnnularMm: number
  minViaPadMm: number
  boardThicknessMm: number[]
  defaultThicknessMm: number
  copperOz: number[]
  soldermask: string[]
  silkscreen: string[]
  surfaceFinish: string[]
  /** Copper to routed board edge, mm. */
  minCopperEdgeMm: number
  notes?: string
  approx?: boolean
}

export function money(n: number): number {
  return Math.round(n * 10000) / 10000
}

/** One / ten / hundred piece breaks from a single-unit street price. */
export function retail(unit: number): CatalogPrice[] {
  return [
    { qty: 1, unit: money(unit) },
    { qty: 10, unit: money(unit * 0.92) },
    { qty: 100, unit: money(unit * 0.8) },
  ]
}

/** Cut-tape, hundred, and reel prices for a passive. */
export function ladder(q1: number, q100: number, q1000: number): CatalogPrice[] {
  return [
    { qty: 1, unit: money(q1) },
    { qty: 100, unit: money(q100) },
    { qty: 1000, unit: money(q1000) },
  ]
}
