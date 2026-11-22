import type { Part } from '../board.ts'
import { boards } from './boards.ts'
import { generalParts, designRules } from './general.ts'
import { peripherals } from './peripherals.ts'
import type { CatalogCategory, CatalogItem } from './types.ts'

/** Bump when the static data changes. Safe to use as a cache key. */
export const CATALOG_VERSION = '2026.11.21'

export const catalog: CatalogItem[] = [...boards, ...peripherals, ...generalParts]

export const byId: Record<string, CatalogItem> = Object.fromEntries(
  catalog.map((item) => [item.id, item]),
)

const CATEGORY_ORDER: CatalogCategory[] = [
  'board',
  'mcu',
  'module',
  'sensor',
  'actuator',
  'driver',
  'power',
  'display',
  'connector',
  'passive',
  'input',
  'indicator',
  'comms',
  'storage',
  'audio',
]

function countCategories(): Record<CatalogCategory, number> {
  const counts = Object.fromEntries(CATEGORY_ORDER.map((category) => [category, 0])) as Record<
    CatalogCategory,
    number
  >
  for (const item of catalog) counts[item.category] += 1
  return counts
}

/** Every category, including ones with nothing in them yet. */
export const categories: Record<CatalogCategory, number> = countCategories()

export interface CatalogQuery {
  category?: CatalogCategory
  /** Matched against `interfaces`, case-insensitive. */
  interface?: string
}

export interface CatalogHit {
  item: CatalogItem
  score: number
}

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Exact, then prefix, then substring, then a loose subsequence. */
function fuzzy(hay: string, needle: string): number {
  if (!needle || !hay) return 0
  if (hay === needle) return 100
  if (hay.startsWith(needle)) return 86
  if (hay.includes(needle)) return 64
  // Subsequence stays inside one word so "imu" does not hit "microsd … module".
  for (const word of hay.split(' ')) {
    if (word.length < needle.length) continue
    let i = 0
    for (const ch of word) {
      if (ch === needle[i]) i += 1
      if (i === needle.length) return 28
    }
  }
  return 0
}

function bestField(fields: string[], needle: string): number {
  let top = 0
  for (const field of fields) {
    const score = fuzzy(norm(field), needle)
    if (score > top) top = score
  }
  return top
}

/**
 * Token-AND search over name, id, MPN, value and tags.
 * Manufacturer and description only add to a token that already matched.
 * An empty query returns the filtered set, most popular first.
 */
export function search(query: string, opts: CatalogQuery = {}): CatalogHit[] {
  const tokens = norm(query).split(/\s+/).filter(Boolean)
  const iface = opts.interface?.toLowerCase()
  const hits: CatalogHit[] = []

  for (const item of catalog) {
    if (opts.category && item.category !== opts.category) continue
    if (iface && !item.interfaces.some((name) => name.toLowerCase() === iface)) continue

    if (tokens.length === 0) {
      hits.push({ item, score: 1000 - item.popularity })
      continue
    }

    let score = 0
    let matched = true
    for (const token of tokens) {
      const primary = Math.max(
        fuzzy(norm(item.name), token),
        fuzzy(norm(item.id), token),
        fuzzy(norm(item.mpn), token),
        fuzzy(norm(item.value ?? ''), token),
        bestField(item.tags, token),
      )
      if (primary <= 0) {
        matched = false
        break
      }
      const secondary = Math.max(
        fuzzy(norm(item.manufacturer), token) * 0.4,
        fuzzy(norm(item.description), token) * 0.25,
      )
      score += primary + secondary
    }
    if (!matched) continue
    score += Math.max(0, 40 - item.popularity) * 0.2
    hits.push({ item, score })
  }

  hits.sort((a, b) => b.score - a.score || a.item.popularity - b.item.popularity || (a.item.id < b.item.id ? -1 : 1))
  return hits
}

/**
 * Drop a catalog row onto a board. `major` is set for boards and solder-down
 * modules. Header and terminal pin counts, and 0603/0805 body size, are copied
 * when the catalog row has them. 0402 leaves `size` unset.
 */
export function toPart(item: CatalogItem, ref: string, x: number, y: number, rot = 0): Part {
  const part: Part = {
    ref,
    kind: item.footprint.kind,
    name: item.name,
    mpn: item.mpn,
    manufacturer: item.manufacturer,
    description: item.description,
    pkg: item.footprint.pkg,
    x,
    y,
    rot,
    category: item.category,
    pricing: item.pricing.map((band) => ({ qty: band.qty, price: band.unit })),
    catalogId: item.id,
  }
  if (item.value !== undefined) part.value = item.value
  if (item.footprint.pins !== undefined) part.pins = item.footprint.pins
  if (item.footprint.size !== undefined) part.size = item.footprint.size
  if (item.category === 'board' || item.category === 'module') part.major = true
  return part
}

export { boards, peripherals, generalParts, designRules }
export { E24, formatResistance, nearestE24, resistorItem } from './general.ts'
export { INTERFACE_NAMES, ladder, money, retail } from './types.ts'
export type {
  BoardHeader,
  CatalogCategory,
  CatalogDimensions,
  CatalogFootprint,
  CatalogItem,
  CatalogPin,
  CatalogPrice,
  CatalogVoltage,
  DesignRules,
  MountingHole,
} from './types.ts'
