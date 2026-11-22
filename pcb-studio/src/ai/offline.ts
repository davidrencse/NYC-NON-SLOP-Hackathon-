import type { LlmCall } from './types'
// Wrist briefs always get the wristband: no drive motors on a band, even when it controls a rover.
const WRIST_BRIEF = /wrist|bracelet|armband|wearable|forearm|smart ?watch/

/**
 * Deterministic, key-free stand-in for the Gemini calls made by runPipeline.
 *
 * The planner expands product archetypes (drone, 3D printer, thermostat, ...) into
 * functional blocks, keyword-matches the request against the catalog digest that the
 * pipeline puts in the plan prompt and designs a complete ESP32 board (power
 * entry, 3V3 regulator, decoupling, reset/boot, status LED, one connector or
 * module per off-board device). It remembers the connection intent of every
 * part it planned, so the netlist call can wire them exactly; parts it did not
 * plan are wired by pin-name matching on the "Parts and pins" block.
 *
 * Create one instance per generation (the plan → nets hand-off is kept in the
 * closure).
 */

// ---------------------------------------------------------------- types

interface DigestItem {
  id: string
  name: string
  category: string
  interfaces: string[]
  pads: number
  desc: string
}

/** Net token: a net name, or "@GPIO:NAME" / "@ADC:NAME" = allocate an MCU pin into net NAME. */
type Tok = string | null

interface Intent {
  ref: string
  catalogId: string
  purpose: string
  role: 'connector' | 'mcu' | 'ic' | 'power' | 'decoupling' | 'passive' | 'indicator' | 'switch' | 'other'
  near?: string
  edge?: 'front' | 'back' | 'left' | 'right'
  dev: 'mcu' | 'reg' | 'usb' | 'tb6612' | 'stepdrv' | 'device' | 'fixed'
  /** explicit pin number → net token */
  nets?: Record<number, Tok>
  /** pin function names overriding whatever the block lists */
  pinFns?: string[]
  /** supply rail for "device" parts */
  rail?: string
  /** net-name prefix for signals of "device" parts */
  label?: string
  adc?: boolean
  /** tb6612: the two motor labels driven by A and B */
  motors?: [string, string]
  /** rails seen by the mcu */
  inRail?: string
}

interface BlockPart {
  ref: string
  name: string
  kind: string
  pins: number
  names?: string[]
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---------------------------------------------------------------- default pinouts (pad order of the rendered footprints)

const ESP32_PINS = [
  'GND', '3V3', 'EN', 'IO36', 'IO39', 'IO34', 'IO35', 'IO32', 'IO33', 'IO25', 'IO26', 'IO27', 'IO14', 'IO12',
  'GND', 'IO13', 'SD2', 'SD3', 'CMD', 'CLK', 'SD0', 'SD1', 'IO15', 'IO2',
  'IO0', 'IO4', 'IO16', 'IO17', 'IO5', 'IO18', 'IO19', 'NC', 'IO21', 'RXD0', 'TXD0', 'IO22', 'IO23', 'GND',
]
const TB6612_PINS = [
  'AO1', 'AO1', 'PGND1', 'PGND1', 'AO2', 'AO2', 'BO2', 'BO2', 'PGND2', 'PGND2', 'BO1', 'BO1',
  'VM2', 'VM3', 'PWMB', 'BIN2', 'BIN1', 'GND', 'STBY', 'VCC', 'AIN1', 'AIN2', 'PWMA', 'VM1',
]
const CH340_PINS = ['GND', 'TXD', 'RXD', 'V3', 'UD+', 'UD-', 'NC', 'NC', 'CTS', 'DSR', 'RI', 'DCD', 'DTR', 'RTS', 'R232', 'VCC']
const USBC_PINS = ['VBUS', 'GND', 'SBU1', 'CC1', 'DN2', 'DP1', 'DN1', 'DP2', 'CC2', 'SBU2', 'GND', 'VBUS', 'SHIELD', 'SHIELD', 'SHIELD', 'SHIELD']

const IO_POOL = ['IO25', 'IO26', 'IO27', 'IO14', 'IO13', 'IO4', 'IO16', 'IO17', 'IO5', 'IO18', 'IO19', 'IO23', 'IO32', 'IO33', 'IO2', 'IO15']
const ADC_POOL = ['IO36', 'IO39', 'IO34', 'IO35', 'IO32', 'IO33']

const norm = (s: string) =>
  s
    .replace(/\(.*?\)/g, '')
    .replace(/−/g, '-')
    .trim()
    .toUpperCase()
const netName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_+\-]/g, '_').replace(/_+/g, '_').slice(0, 32)

// ---------------------------------------------------------------- parsing

function parseDigest(prompt: string): DigestItem[] {
  const i = prompt.indexOf('Catalog (')
  const body = i >= 0 ? prompt.slice(prompt.indexOf('\n', i) + 1) : prompt
  const out: DigestItem[] = []
  for (const line of body.split('\n')) {
    const f = line.split(' | ')
    if (f.length < 9) continue
    out.push({
      id: f[0].trim(),
      name: f[1].trim(),
      category: f[2].trim(),
      interfaces: f[3] === '-' ? [] : f[3].toLowerCase().split('/'),
      pads: parseInt(f[7], 10) || 0,
      desc: f.slice(8).join(' | '),
    })
  }
  return out
}

const KINDS = 'module|ssop|soic|sot223|chip|ecap|terminal|header|usbc|tact|led'
const HEAD_RE = new RegExp(`^([A-Z]{1,3}\\d{1,3}) = (.*?) \\((.*), (${KINDS})(?:, [^)]*)?\\)`)

function parseBlock(prompt: string): BlockPart[] {
  const i = prompt.indexOf('Parts and pins:')
  if (i < 0) return []
  const lines = prompt.slice(i).split('\n').slice(1)
  const out: BlockPart[] = []
  for (let k = 0; k < lines.length; k++) {
    const m = HEAD_RE.exec(lines[k])
    if (!m) {
      if (out.length && !lines[k].trim()) break
      continue
    }
    const part: BlockPart = { ref: m[1], name: m[2], kind: m[4], pins: 0 }
    const pl = (lines[k + 1] ?? '').trim()
    const range = /^pins 1-(\d+)$/.exec(pl)
    if (range) part.pins = Number(range[1])
    else if (/^1 /.test(pl)) {
      const names = pl.split(/, (?=\d+ )/).map((x) => x.replace(/^\d+ /, ''))
      part.pins = names.length
      part.names = names
    }
    if (part.pins) k++
    out.push(part)
  }
  return out
}

// ---------------------------------------------------------------- planner

const WORDNUM: Record<string, number> = {
  one: 1, single: 1, two: 2, dual: 2, twin: 2, three: 3, triple: 3, four: 4, quad: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
}
const NUM_RE = '(\\d{1,3}|one|single|two|dual|twin|three|triple|four|quad|five|six|seven|eight|nine|ten|twelve)'

/** Count written before a noun ("4 servos", "two soil probes", "6-axis"); dflt when none is given. */
function countOf(q: string, noun: string, dflt: number, max = 6): number {
  const m = new RegExp(`\\b${NUM_RE}[\\s-]*(?:x\\s*)?(?:channel\\s+|ch\\s+)?(?:\\w+\\s+){0,2}?(?:${noun})`).exec(q)
  if (!m) return dflt
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : WORDNUM[m[1]]
  return Math.max(1, Math.min(n || dflt, max))
}

interface Device {
  ids: (string | RegExp)[]
  label: string
  purpose: string
  rail?: '5V'
  adc?: boolean
  pinFns?: string[]
  /** MCU pins the module needs, when the interface list would mis-estimate it */
  cost?: number
}

/** Catalog sensor/display/comms modules: placed as their own header socket and wired by pin name. */
const MODULES: { re: RegExp; dev: Device }[] = [
  { re: /bme ?280|weather|humidity|barometr|altitude|altimet/, dev: { ids: ['bme280', 'bmp280', 'sht31'], label: 'ENV', purpose: 'temperature / humidity / pressure sensor (I2C)' } },
  { re: /ds18b20|water temp|temperature probe|waterproof temp/, dev: { ids: ['ds18b20'], label: 'PROBE', purpose: 'waterproof temperature probe (1-Wire)', cost: 1 } },
  { re: /temperature|thermomet|thermostat/, dev: { ids: ['sht31', 'ds18b20', 'dht22', 'bme280'], label: 'TEMP', purpose: 'temperature sensor' } },
  { re: /\bimu\b|acceler|gyro|mpu-?6050|orientation|tilt|balanc|9-?dof|6-?dof/, dev: { ids: ['mpu6050', 'gy521-mpu6050', 'icm20948', 'bno055'], label: 'IMU', purpose: '6-axis IMU (I2C)' } },
  { re: /ultrasonic|sonar|hc-?sr04|obstacle/, dev: { ids: ['hcsr04', 'vl53l0x'], label: 'SONAR', purpose: 'ultrasonic distance sensor', rail: '5V' } },
  { re: /lidar|\btof\b|time.of.flight|laser distance/, dev: { ids: ['vl53l0x'], label: 'TOF', purpose: 'time-of-flight distance sensor (I2C)' } },
  { re: /\bpir\b|presence|occupancy|motion sens|motion detect/, dev: { ids: ['hcsr501'], label: 'PIR', purpose: 'PIR motion sensor', rail: '5V' } },
  { re: /current sens|power monitor|ina219|energy meter/, dev: { ids: ['ina219'], label: 'INA', purpose: 'current / power monitor (I2C)' } },
  { re: /heart|pulse ox|\bpulse sens|spo2|oximet/, dev: { ids: ['max30102'], label: 'PPG', purpose: 'pulse oximeter / heart-rate sensor (I2C)' } },
  { re: /colou?r sens/, dev: { ids: ['tcs34725'], label: 'RGB', purpose: 'colour sensor (I2C)' } },
  { re: /\bgps\b|gnss|location track/, dev: { ids: ['neo6m'], label: 'GPS', purpose: 'GPS receiver (UART)' } },
  { re: /\bgsm\b|cellular|\bsim ?card|\bsms\b|\bgprs\b|sim800/, dev: { ids: ['sim800l'], label: 'GSM', purpose: 'GSM / GPRS modem (UART)', cost: 3 } },
  { re: /e-?ink|e-?paper/, dev: { ids: ['epaper-29'], label: 'EPD', purpose: '2.9" e-paper display (SPI)' } },
  { re: /\btft\b|\blcd\b|colou?r (display|screen)|touchscreen/, dev: { ids: ['st7789-20', 'st7789-154', 'ili9341-28'], label: 'TFT', purpose: 'colour TFT display (SPI)' } },
  { re: /oled|display|screen|readout|\bshow(s|ing)?\b/, dev: { ids: ['ssd1306-096', 'sh1106-13'], label: 'OLED', purpose: '0.96" OLED display (I2C)' } },
  { re: /led matrix|8x8/, dev: { ids: ['max7219-8x8'], label: 'MATRIX', purpose: '8×8 LED matrix (SPI)', rail: '5V' } },
  { re: /nrf24|2\.4 ?ghz radio/, dev: { ids: ['nrf24l01'], label: 'NRF', purpose: 'nRF24L01 2.4 GHz radio (SPI)' } },
  { re: /hc-?05|classic bluetooth|bluetooth serial/, dev: { ids: ['hc05'], label: 'BT', purpose: 'HC-05 Bluetooth serial module (UART)', rail: '5V' } },
  { re: /ethernet|\blan\b|rj45/, dev: { ids: ['w5500'], label: 'ETH', purpose: 'W5500 Ethernet module (SPI)' } },
  { re: /can ?bus|\bcan\b(?! (be|you|i|we|it)\b)/, dev: { ids: ['mcp2515'], label: 'CAN', purpose: 'MCP2515 CAN controller (SPI)', rail: '5V' } },
  { re: /sd ?card|micro ?sd|data ?log|logging|logger|\blogs?\b|\brecord(s|ing)?\b/, dev: { ids: ['microsd-module'], label: 'SD', purpose: 'microSD card socket (SPI)' } },
  { re: /speaker|audio out|amplifier|music|sound output/, dev: { ids: ['max98357a'], label: 'AMP', purpose: 'I2S class-D amplifier', rail: '5V', cost: 4 } },
  { re: /microphone|\bmic\b|voice|sound sens/, dev: { ids: ['inmp441'], label: 'MIC', purpose: 'I2S MEMS microphone', cost: 3 } },
  { re: /buzzer|beep|alarm|chime/, dev: { ids: ['buzzer-active', 'buzzer-passive'], label: 'BUZZER', purpose: 'buzzer', pinFns: ['SIG', 'GND'], cost: 1 } },
  { re: /rotary|encoder|knob/, dev: { ids: ['ec11'], label: 'ENC', purpose: 'rotary encoder with push switch', pinFns: ['A', 'B', 'GND', 'SW', 'GND'], cost: 3 } },
  { re: /joystick|gamepad|game ?controller|thumbstick/, dev: { ids: ['joystick-ky023'], label: 'JOY', purpose: 'analog joystick', adc: true, cost: 1 } },
  { re: /keypad|keyboard|pin pad/, dev: { ids: ['keypad-4x4'], label: 'KEY', purpose: '4×4 keypad connector', cost: 8 } },
  { re: /touch (button|sens|pad)|capacitive/, dev: { ids: ['ttp223'], label: 'TOUCH', purpose: 'capacitive touch sensor' } },
  { re: /relay|mains|appliance/, dev: { ids: ['relay-1ch'], label: 'RELAY', purpose: '1-channel relay module', rail: '5V' } },
]

/** Off-board analog sensors with no catalog module: a 3-pin connector (VCC, GND, SIG) each. */
const ANALOG: { re: RegExp; noun: string; label: string; purpose: string; plural: number }[] = [
  { re: /\bemg\b|muscle|myo|electromyo/, noun: '(?:emg|muscle|myo)', label: 'EMG', purpose: 'EMG muscle sensor front-end (MyoWare/AD8232 style) input', plural: 3 },
  { re: /\becg\b|\bekg\b|electrocardio/, noun: '(?:ecg|ekg)', label: 'ECG', purpose: 'ECG front-end (AD8232) input', plural: 1 },
  { re: /soil|moisture/, noun: '(?:soil|moisture)', label: 'SOIL', purpose: 'capacitive soil-moisture probe', plural: 2 },
  { re: /\blight sens|\bldr\b|photo ?resist|ambient light|\blux\b/, noun: '(?:light|ldr)', label: 'LIGHT', purpose: 'light sensor (LDR / analog)', plural: 1 },
  { re: /\bflex\b|bend sens/, noun: 'flex', label: 'FLEX', purpose: 'flex sensor', plural: 5 },
  { re: /\bforce\b|\bfsr\b|pressure pad|weight/, noun: '(?:force|fsr)', label: 'FSR', purpose: 'force-sensitive resistor', plural: 2 },
  { re: /\bgas\b|\bmq-?\d|smoke|air quality|co2/, noun: '(?:gas|mq|smoke)', label: 'GAS', purpose: 'MQ-series gas sensor', plural: 1 },
  { re: /potentiometer|\bpots?\b|slider|fader/, noun: '(?:potentiometer|pot|slider|fader)', label: 'POT', purpose: 'potentiometer input', plural: 2 },
  { re: /water level|rain sens|leak/, noun: '(?:water|rain|leak)', label: 'WATER', purpose: 'water level / rain / leak sensor', plural: 1 },
  { re: /analog sens|sensor input/, noun: 'sensor', label: 'AIN', purpose: 'analog sensor input', plural: 2 },
]

/** Switched loads: low-side MOSFET + flyback diode + 2-pin terminal. */
const LOADS: { re: RegExp; label: string; purpose: string }[] = [
  { re: /pump|watering|irrigat/, label: 'PUMP', purpose: 'water pump' },
  { re: /valve|solenoid/, label: 'VALVE', purpose: 'solenoid valve' },
  { re: /\bfan\b|cooling|ventilat/, label: 'FAN', purpose: 'fan' },
  { re: /heater|heating|incubat/, label: 'HEAT', purpose: 'heater' },
  { re: /vibration|haptic|vibro/, label: 'VIB', purpose: 'vibration motor (haptic feedback)' },
  { re: /\block\b|door strike/, label: 'LOCK', purpose: 'electric lock' },
]

// ---------------------------------------------------------------- archetypes and generic IO

/** A functional block with no catalog module, built from generic connectors and discretes. */
type Feat =
  /** 3-pin output header: SIG, V (optional), GND */
  | { k: 'pwm'; label: string; purpose: string; n?: number; powered?: boolean }
  /** 3-pin device header: V, GND, SIG (GPIO or ADC) */
  | { k: 'sig'; label: string; purpose: string; n?: number; adc?: boolean; v5?: boolean }
  /** 2-pin contact input: SIG, GND (endstop, reed switch, footswitch) */
  | { k: 'sw'; label: string; purpose: string; n?: number }
  /** on-board push button to GND */
  | { k: 'btn'; label: string; purpose: string; n?: number }
  /** low-side MOSFET switched output on a 2-pin terminal */
  | { k: 'load'; label: string; purpose: string; n?: number }
  /** NTC thermistor input: 2-pin header + pull-up into an ADC pin */
  | { k: 'therm'; label: string; purpose: string; n?: number }
  /** multi-signal port: V, GND, then sigs (SCK/MOSI/MISO/SDA/SCL join the shared buses) */
  | { k: 'port'; label: string; purpose: string; sigs: string[]; v5?: boolean }
  /** supply-voltage divider into an ADC pin */
  | { k: 'vsense' }

interface Expansion {
  names: string[]
  /** extra keywords fed to the MODULES / ANALOG / LOADS tables */
  kw: string
  feats: Feat[]
  servos: number
  steppers: number
  noMotors: boolean
  /** high-voltage supply entering the board: battery pack or DC input */
  hv?: 'VBAT' | 'VIN'
  battery: boolean
}

interface Archetype {
  name: string
  re: RegExp
  not?: RegExp
  apply: (q: string, x: Expansion) => void
}

const RC_PORT: Feat = { k: 'port', label: 'RC', sigs: ['TX', 'RX'], v5: true, purpose: 'RC receiver port (ELRS / CRSF / SBUS UART: 5V GND TX RX)' }

/** Product words → the functional blocks such a product implies. */
const ARCHETYPES: Archetype[] = [
  {
    name: 'multirotor flight controller',
    re: /drone|copter|\bfpv\b|multi-?rotor|\buav\b|flight controller/,
    apply(q, x) {
      const n = /octo/.test(q) ? 8 : /hexa|\bhex\b/.test(q) ? 6 : /tri-?copter/.test(q) ? 3 : countOf(q, 'motors?|escs?|rotors?|props?', 4, 8)
      x.kw += ' imu barometr buzzer led strip '
      x.feats.push({ k: 'pwm', label: 'ESC', n, purpose: 'ESC throttle output (PWM / DShot: SIG NC GND)' }, RC_PORT, { k: 'vsense' })
      if (/fpv|vtx|video/.test(q)) x.feats.push({ k: 'port', label: 'VTX', sigs: ['TX'], v5: true, purpose: 'FPV video transmitter port (5V GND SmartAudio)' })
      x.hv = 'VBAT'
      x.noMotors = true
    },
  },
  {
    name: 'robot arm',
    re: /robot(?:ic)? ?arm|\barm\b|manipulator|gripper|\bclaw\b/,
    not: /cortex|stm32|processor|\barm (mcu|chip|core)/,
    apply(q, x) {
      x.servos = Math.max(x.servos, countOf(q, 'axis|axes|dof|servos?|joints?', 5, 8))
      x.noMotors = true
    },
  },
  {
    name: 'legged robot',
    re: /hexapod|quadruped|robot dog|spider|biped|humanoid|animatronic|walking robot/,
    apply(q, x) {
      x.servos = Math.max(x.servos, countOf(q, 'servos?|legs?|joints?|dof', 8, 8))
      x.kw += ' imu '
      x.noMotors = true
    },
  },
  {
    name: 'pan-tilt / gimbal',
    re: /gimbal|pan.?tilt|camera stabili|turret/,
    apply(_q, x) {
      x.servos = Math.max(x.servos, 2)
      x.kw += ' imu '
    },
  },
  {
    name: 'motion controller',
    re: /3d ?print|\bcnc\b|plotter|laser (cutter|engraver)|engraver|\bmill\b|milling|\blathe\b|pick.and.place/,
    apply(q, x) {
      const printer = /3d ?print/.test(q)
      const plotter = /plotter/.test(q)
      const axes = printer ? 4 : plotter ? 2 : 3
      x.steppers = Math.max(x.steppers, axes)
      x.feats.push({ k: 'sw', label: 'ENDSTOP', n: Math.min(axes, 3), purpose: 'axis endstop switch input' })
      if (printer) {
        x.feats.push(
          { k: 'load', label: 'HOTEND', purpose: 'hotend heater' },
          { k: 'load', label: 'BED', purpose: 'heated bed' },
          { k: 'therm', label: 'THERM', n: 2, purpose: 'NTC thermistor input (hotend / bed)' },
          { k: 'load', label: 'FAN', purpose: 'part-cooling fan' },
        )
      } else if (plotter) x.servos = Math.max(x.servos, 1)
      else x.feats.push({ k: 'load', label: /laser/.test(q) ? 'LASER' : 'SPINDLE', purpose: /laser/.test(q) ? 'laser module enable' : 'spindle enable' })
      x.hv = 'VIN'
      x.noMotors = true
    },
  },
  {
    name: 'telescope / positioning mount',
    re: /telescope|equatorial|star tracker|alt-?az|antenna rotator|camera slider|turntable|solar tracker|sun tracker|heliostat/,
    apply(q, x) {
      const n = /slider|turntable/.test(q) ? 1 : 2
      x.steppers = Math.max(x.steppers, n)
      x.feats.push({ k: 'sw', label: 'HOME', n, purpose: 'axis home / limit switch input' })
      if (/solar|sun|heliostat/.test(q)) x.feats.push({ k: 'sig', label: 'LDR', n: 2, adc: true, purpose: 'light sensor for sun tracking' })
      else x.kw += ' joystick '
      x.hv = 'VIN'
      x.noMotors = true
    },
  },
  {
    name: 'boat / submarine',
    re: /\bboat|\bship\b|yacht|\bsub\b|submarine|\brov\b|underwater|hovercraft/,
    apply(q, x) {
      const sub = /\bsub\b|submarine|\brov\b|underwater/.test(q)
      x.feats.push({ k: 'pwm', label: 'ESC', n: countOf(q, 'thrusters?|motors?|escs?|props?', sub ? 2 : 1, 6), purpose: 'thruster ESC output (PWM: SIG NC GND)' }, RC_PORT, { k: 'vsense' })
      x.servos = Math.max(x.servos, sub ? 2 : 1)
      x.kw += sub ? ' imu leak ' : ' imu '
      if (sub) x.feats.push({ k: 'sig', label: 'DEPTH', adc: true, purpose: 'depth / pressure transducer input' })
      x.hv = 'VBAT'
      x.noMotors = true
    },
  },
  {
    name: 'fixed-wing aircraft',
    re: /\bplane\b|airplane|aeroplane|aircraft|glider|flying wing|\bjet\b/,
    apply(_q, x) {
      x.feats.push({ k: 'pwm', label: 'ESC', n: 1, purpose: 'motor ESC output (PWM: SIG NC GND)' }, RC_PORT, { k: 'vsense' })
      x.servos = Math.max(x.servos, 3)
      x.kw += ' imu barometr '
      x.hv = 'VBAT'
      x.noMotors = true
    },
  },
  {
    name: 'rocket flight computer',
    re: /rocket|flight computer/,
    apply(_q, x) {
      x.kw += ' imu barometr buzzer sd card '
      x.feats.push({ k: 'load', label: 'PYRO', n: 2, purpose: 'pyro / igniter channel' })
      x.battery = true
      x.noMotors = true
    },
  },
  {
    name: 'personal electric vehicle',
    re: /skateboard|longboard|e-?bike|scooter|go-?kart|hoverboard|onewheel|unicycle|wheelchair|golf cart/,
    apply(q, x) {
      const balance = /hoverboard|onewheel|unicycle/.test(q)
      x.feats.push(
        { k: 'pwm', label: 'ESC', n: /hoverboard|wheelchair|go-?kart/.test(q) ? 2 : 1, purpose: 'motor ESC / VESC throttle output (PWM: SIG NC GND)' },
        { k: 'sig', label: 'THROTTLE', adc: true, purpose: 'throttle input (hall / potentiometer)' },
        { k: 'sw', label: 'BRAKE', purpose: 'brake lever switch input' },
        { k: 'vsense' },
      )
      if (balance || /skateboard|longboard/.test(q)) x.kw += ' imu '
      x.hv = 'VBAT'
      x.noMotors = true
    },
  },
  {
    name: 'wheeled vehicle',
    re: /\bcar\b|rover|vehicle|\btank\b|buggy|truck|line follow|sumo/,
    not: /fish tank|water tank|car (alarm|tracker|charger)/,
    apply(q, x) {
      x.kw += ' imu '
      if (/\brc\b|radio.?control/.test(q)) x.feats.push(RC_PORT)
      if (/line follow/.test(q)) x.feats.push({ k: 'sig', label: 'LINE', n: 3, adc: true, purpose: 'IR line sensor' })
    },
  },
  {
    name: 'thermostat',
    re: /thermostat|hvac/,
    apply(_q, x) {
      x.kw += ' temperature relay oled '
      x.feats.push({ k: 'btn', label: 'BTN', n: 2, purpose: 'set-point button' })
    },
  },
  {
    name: 'doorbell',
    re: /door ?bell/,
    apply(_q, x) {
      x.kw += ' buzzer '
      x.feats.push({ k: 'btn', label: 'BELL', purpose: 'doorbell push button' })
    },
  },
  {
    name: 'smart lock',
    re: /\block\b|door strike|deadbolt|access control/,
    apply(_q, x) {
      x.kw += ' lock buzzer '
      x.feats.push({ k: 'btn', label: 'EXIT', purpose: 'exit / manual unlock button' }, { k: 'sw', label: 'DOOR', purpose: 'door reed switch input' })
    },
  },
  {
    name: 'lighting controller',
    re: /\blamp\b|lighting|light ?show|mood ?light|night ?light|led (lamp|light|controller|cube|sign)|christmas|\bbulb\b|dimmer|\bsmart light/,
    apply(_q, x) {
      x.kw += ' led strip '
      x.feats.push({ k: 'load', label: 'LAMP', purpose: 'LED lamp / white strip (PWM dimmed)' }, { k: 'btn', label: 'MODE', purpose: 'mode button' })
    },
  },
  {
    name: 'smart switch',
    re: /smart (switch|plug|outlet|socket|home)|home automation|power strip|garage door|gate opener|\bswitch\b(?!es| on| off)/,
    apply(q, x) {
      x.kw += ' relay '
      x.feats.push({ k: 'btn', label: 'BTN', purpose: 'manual override button' })
      if (/smart home|home automation/.test(q)) x.kw += ' temperature pir '
      if (/garage|gate/.test(q)) x.feats.push({ k: 'sw', label: 'DOOR', purpose: 'door position reed switch input' })
    },
  },
  {
    name: 'blinds / curtain drive',
    re: /blinds?\b|curtain|window opener|shade\b/,
    apply(_q, x) {
      x.steppers = Math.max(x.steppers, 1)
      x.feats.push({ k: 'btn', label: 'BTN', n: 2, purpose: 'up / down button' }, { k: 'sw', label: 'LIMIT', purpose: 'end-of-travel switch input' })
      x.hv = 'VIN'
    },
  },
  {
    name: 'tracker',
    re: /tracker|tracking device|asset tag|\btag\b/,
    not: /star tracker|solar tracker|sun tracker|fitness tracker|activity tracker|sleep tracker|habit tracker/,
    apply(q, x) {
      x.kw += ' gps '
      if (/pet|dog|cat|bike|luggage/.test(q)) x.kw += ' imu buzzer '
      x.battery = true
    },
  },
  {
    name: 'data logger',
    re: /logger|data ?log|black ?box|recorder/,
    apply(_q, x) {
      x.kw += ' sd card '
      x.feats.push({ k: 'btn', label: 'REC', purpose: 'start / stop logging button' })
    },
  },
  {
    name: 'game controller',
    re: /game ?(pad|controller|console)|gamepad|arcade|handheld game|joypad/,
    apply(q, x) {
      x.kw += /console|handheld|arcade/.test(q) ? ' joystick oled buzzer ' : ' joystick '
      x.feats.push({ k: 'btn', label: 'BTN', n: 4, purpose: 'action button' })
    },
  },
  {
    name: 'macro pad',
    re: /macro ?pad|stream ?deck|shortcut (pad|keys)|midi controller|control surface/,
    apply(q, x) {
      x.kw += ' encoder '
      x.feats.push({ k: 'btn', label: 'KEY', n: countOf(q, 'keys?|buttons?', 6, 8), purpose: 'macro key' })
    },
  },
  {
    name: 'audio player',
    re: /audio player|mp3|music player|\bspeaker|boombox|jukebox|sound ?board|internet radio|\bradio\b|walkie|intercom|voice assistant|podcast/,
    apply(q, x) {
      x.kw += ' speaker sd card encoder '
      if (/walkie|intercom|voice/.test(q)) x.kw += ' microphone '
    },
  },
  {
    name: 'synthesizer',
    re: /synth|drum machine|sequencer|theremin|\bsampler\b/,
    apply(_q, x) {
      x.kw += ' speaker encoder '
      x.feats.push({ k: 'sig', label: 'POT', n: 3, adc: true, purpose: 'control potentiometer' }, { k: 'btn', label: 'TRIG', n: 2, purpose: 'trigger button' })
    },
  },
  {
    name: 'audio effects unit',
    re: /pedal|stomp ?box|effects? (box|unit|processor)|\bfx\b|guitar|bass amp/,
    apply(_q, x) {
      x.feats.push(
        { k: 'sig', label: 'AUDIO_IN', adc: true, purpose: 'instrument input (buffered, biased to mid-rail) jack' },
        { k: 'sig', label: 'AUDIO_OUT', purpose: 'audio output (DAC / PWM, filter off-board) jack' },
        { k: 'sig', label: 'POT', n: 3, adc: true, purpose: 'effect parameter potentiometer' },
        { k: 'sw', label: 'FOOTSW', purpose: 'bypass footswitch input' },
      )
    },
  },
  {
    name: 'clock / timer',
    re: /clock|timer|stopwatch|countdown|pomodoro|metronome|scoreboard/,
    apply(_q, x) {
      x.kw += ' oled buzzer '
      x.feats.push({ k: 'btn', label: 'BTN', n: 2, purpose: 'set / start button' })
    },
  },
  {
    name: 'wearable',
    re: /smart ?watch|\bwatch\b|fitness|pedometer|step counter|activity tracker|sleep tracker|health band|smart ?ring/,
    apply(_q, x) {
      x.kw += ' imu heart oled vibration '
      x.feats.push({ k: 'btn', label: 'BTN', purpose: 'side button' })
      x.battery = true
    },
  },
  {
    name: 'camera',
    re: /camera|\bvision\b|\bcam\b|webcam|time-?lapse/,
    not: /drone|copter|\bfpv\b|camera (slider|stabili)/,
    apply(q, x) {
      x.feats.push({ k: 'port', label: 'CAM', sigs: ['SCK', 'MOSI', 'MISO', 'CS', 'SDA', 'SCL'], purpose: 'camera module port (ArduCAM style: 3V3 GND SCK MOSI MISO CS SDA SCL)' })
      x.feats.push({ k: 'btn', label: 'SHUTTER', purpose: 'shutter button' })
      if (/trail|wildlife|security|motion/.test(q)) x.kw += ' pir '
    },
  },
  {
    name: 'scale',
    re: /\bscales?\b|weigh|load ?cell|hx711/,
    apply(_q, x) {
      x.kw += ' oled '
      x.feats.push({ k: 'port', label: 'HX711', sigs: ['DT', 'SCK_HX'], purpose: 'load-cell ADC port (HX711: 3V3 GND DT SCK)' }, { k: 'btn', label: 'TARE', purpose: 'tare button' })
    },
  },
  {
    name: 'medical monitor',
    re: /medical|patient|vital|health monitor|oximeter|stethoscope|blood pressure|fever|clinical/,
    apply(_q, x) {
      x.kw += ' heart oled buzzer temperature '
      x.battery = true
    },
  },
  {
    name: 'grow controller',
    re: /greenhouse|hydroponic|aquaponic|\bgarden|\bfarm|agricultur|grow (box|tent|room|light)|terrarium|vivarium/,
    apply(q, x) {
      x.kw += ' humidity pump relay fan '
      if (/hydroponic|aquaponic/.test(q)) x.feats.push({ k: 'sig', label: 'PH', adc: true, purpose: 'pH probe amplifier input' }, { k: 'sig', label: 'TDS', adc: true, purpose: 'TDS / EC probe input' })
      else x.kw += ' soil '
      if (/hydroponic|aquaponic/.test(q)) x.kw += ' water level '
    },
  },
  {
    name: 'aquarium controller',
    re: /aquarium|fish ?tank|\bpond\b|\breef\b/,
    apply(_q, x) {
      x.kw += ' ds18b20 pump relay water level '
      x.feats.push({ k: 'load', label: 'LIGHT', purpose: 'tank light' })
    },
  },
  {
    name: 'energy monitor',
    re: /solar|battery monitor|power meter|energy|\bbms\b|charge controller|watt ?meter|multimeter|bench supply|power supply|power bank/,
    not: /solar tracker/,
    apply(_q, x) {
      x.kw += ' ina219 oled '
      x.feats.push({ k: 'sig', label: 'VSENSE', n: 2, adc: true, purpose: 'voltage sense input (external divider)' })
    },
  },
  {
    name: 'alarm / security',
    re: /alarm|security|burglar|intruder|siren|anti-?theft/,
    not: /alarm clock|smoke|fire|gas/,
    apply(_q, x) {
      x.kw += ' pir buzzer keypad '
      x.feats.push({ k: 'sw', label: 'DOOR', purpose: 'door / window reed switch input' })
    },
  },
  {
    name: 'heating appliance',
    re: /coffee|espresso|kettle|\btea\b|brew|sous.?vide|\boven\b|toaster|cooker|kiln|reflow|smoker|fryer|hot ?plate|soldering|incubator|dehydrator|grill|\bbbq\b/,
    apply(q, x) {
      x.kw += ' relay oled buzzer '
      x.feats.push({ k: 'therm', label: 'THERM', purpose: 'NTC thermistor input (heater temperature)' }, { k: 'btn', label: 'BTN', n: 2, purpose: 'start / select button' })
      if (/coffee|espresso|tea|brew/.test(q)) x.kw += ' pump water level '
    },
  },
  {
    name: 'dispenser',
    re: /feeder|dispenser|vending|treat|pill ?box|dosing|bartender|cocktail|drink mixer/,
    apply(q, x) {
      if (/dosing|bartender|cocktail|drink/.test(q)) x.feats.push({ k: 'load', label: 'PUMP', n: countOf(q, 'pumps?|drinks?|bottles?|channels?', 3, 4), purpose: 'peristaltic dosing pump' })
      else x.servos = Math.max(x.servos, 1)
      x.kw += ' buzzer '
      x.feats.push({ k: 'btn', label: 'FEED', purpose: 'manual dispense button' }, { k: 'sig', label: 'LEVEL', adc: true, purpose: 'hopper level sensor (IR / analog)' })
    },
  },
  {
    name: 'radiation / pulse counter',
    re: /geiger|radiation|dosimeter|particle counter|scintillat/,
    apply(_q, x) {
      x.kw += ' buzzer oled '
      x.feats.push({ k: 'sig', label: 'PULSE', v5: true, purpose: 'Geiger tube driver pulse input (5V GND PULSE)' }, { k: 'btn', label: 'MODE', purpose: 'mode button' })
    },
  },
  {
    name: 'bike computer',
    re: /bike computer|cycl(e|ing) computer|speedometer|odometer|tachometer|cadence|\bbike\b|bicycle/,
    not: /e-?bike|bike tracker|bike (lock|alarm)/,
    apply(_q, x) {
      x.kw += ' gps oled '
      x.feats.push({ k: 'sw', label: 'WHEEL', purpose: 'wheel reed / hall sensor input' }, { k: 'btn', label: 'BTN', n: 2, purpose: 'page button' })
      x.battery = true
    },
  },
  {
    name: 'badge / handheld',
    re: /badge|name ?tag|\btoy\b|tamagotchi|virtual pet|\bdice\b|calculator|pager|handheld/,
    apply(q, x) {
      x.kw += /calculator/.test(q) ? ' oled keypad ' : ' oled buzzer '
      if (!/calculator/.test(q)) x.feats.push({ k: 'btn', label: 'BTN', n: 3, purpose: 'user button' })
      x.battery = true
    },
  },
  {
    name: 'IR remote',
    re: /ir (blaster|remote)|universal remote|tv remote|\binfrared remote/,
    apply(_q, x) {
      x.feats.push({ k: 'sig', label: 'IR_TX', purpose: 'IR LED driver output' }, { k: 'sig', label: 'IR_RX', purpose: 'IR receiver (TSOP38238)' }, { k: 'btn', label: 'BTN', n: 4, purpose: 'remote key' })
      x.battery = true
    },
  },
  {
    name: 'test instrument',
    re: /oscilloscope|logic analy|signal generator|function generator|frequency counter|\btester\b/,
    apply(_q, x) {
      x.kw += ' oled encoder '
      x.feats.push({ k: 'sig', label: 'CH', n: 2, adc: true, purpose: 'measurement channel input' })
    },
  },
]

/** Peripherals named in the request that have no catalog module: a purpose-built port each. */
const PORTS: { re: RegExp; feat: Feat }[] = [
  { re: /fingerprint/, feat: { k: 'port', label: 'FP', sigs: ['TX', 'RX'], purpose: 'fingerprint reader port (R307 / AS608 UART: 3V3 GND TX RX)' } },
  { re: /rfid|\bnfc\b|rc522|card reader/, feat: { k: 'port', label: 'RFID', sigs: ['SCK', 'MOSI', 'MISO', 'CS'], purpose: 'RFID / NFC reader port (RC522 SPI: 3V3 GND SCK MOSI MISO CS)' } },
  { re: /\blora\b|lorawan|sx127/, feat: { k: 'port', label: 'LORA', sigs: ['SCK', 'MOSI', 'MISO', 'CS'], purpose: 'LoRa radio port (SX127x SPI: 3V3 GND SCK MOSI MISO CS)' } },
  { re: /thermocouple|max31855|max6675/, feat: { k: 'port', label: 'TC', sigs: ['SCK', 'MISO', 'CS'], purpose: 'thermocouple amplifier port (MAX31855 SPI: 3V3 GND SCK MISO CS)' } },
  { re: /barcode|qr (code )?(scanner|reader)|thermal printer|receipt printer|\bmidi\b|rs-?485|modbus|rs-?232|serial port|\buart\b/, feat: { k: 'port', label: 'SERIAL', sigs: ['TX', 'RX'], v5: true, purpose: 'serial device port (UART: 5V GND TX RX)' } },
  { re: /\brtc\b|real.?time clock|ds3231|qwiic|stemma|i2c (port|header|expansion)|grove/, feat: { k: 'port', label: 'I2C', sigs: ['SDA', 'SCL'], purpose: 'I2C expansion port (3V3 GND SDA SCL)' } },
  { re: /thermistor|\bntc\b/, feat: { k: 'therm', label: 'NTC', purpose: 'NTC thermistor input' } },
  { re: /\bir (receiver|sensor)|infrared (receiver|sensor)/, feat: { k: 'sig', label: 'IR_RX', purpose: 'IR receiver (TSOP38238)' } },
  { re: /hall (effect|sensor)|reed (switch|sensor)|magnet(ic)? (sensor|switch)|door sensor|window sensor|limit switch|end ?stop/, feat: { k: 'sw', label: 'CONTACT', purpose: 'contact / reed / hall switch input' } },
  { re: /flow (sensor|meter)|anemometer|wind speed|rain gauge|\brpm\b|tacho/, feat: { k: 'sig', label: 'PULSE', v5: true, purpose: 'pulse-output sensor input (flow / wind / RPM)' } },
  { re: /\bph\b|\btds\b|turbidity|conductivity/, feat: { k: 'sig', label: 'PROBE', adc: true, purpose: 'water-quality probe amplifier input' } },
  { re: /electromagnet|\blaser\b(?! (cutter|engraver|distance))|\bled (flood|spot)|\bhorn\b|\bsiren\b/, feat: { k: 'load', label: 'OUT', purpose: 'switched output' } },
  { re: /\bbuttons?\b|push ?buttons?/, feat: { k: 'btn', label: 'USER', purpose: 'user button' } },
]

/** Words that never name an off-board device on their own. */
const STOP_RE =
  /^(a|an|the|some|any|my|our|its|it|this|that|these|those|of|for|to|on|in|at|by|is|are|be|can|will|should|which|who|me|i|we|you|make|build|design|create|want|need|please|simple|small|tiny|big|large|cheap|basic|cool|nice|smart|custom|diy|new|good|board|pcb|circuit|device|thing|things|project|system|controller|module|support|capability|capabilities|connectivity|control|controlled|powered|based|enabled|wifi|wi-fi|bluetooth|ble|wireless|remote|remotely|app|phone|smartphone|iphone|android|internet|cloud|mqtt|web|usb|usb-c|esp32|esp|arduino|power|etc|stuff|feature|features|few|couple|several|many|lots|both|also|too|maybe|optional|optionally|all|other|more|one|two|three|four|five|six|seven|eight|nine|ten|twelve|dual|twin|triple|quad|single|x|pcs|it's|im|i'm)$/
const VERB_RE = /^(sends?|reads?|shows?|displays?|logs?|records?|uploads?|connects?|runs?|works?|turns?|controls?|measures?|monitors?|detects?|plays?|uses?|notif\w+|alerts?|opens?|closes?|blinks?|lights?|does|do|has|have|lets?|allows?|makes?|gets?|keeps?|tells?|talks?)$/
const KNOWN_MISC = /servo|stepper|\bmotor|wheel|led strip|neopixel|ws2812|addressable|rgb strip|light strip|batter|lipo|li-?ion|18650|\busb|wi-?fi|bluetooth|\bble\b|\bleds?\b|status light|charger|charging|regulator/

function isKnown(phrase: string): boolean {
  const p = ` ${phrase} `
  return (
    KNOWN_MISC.test(p) ||
    MODULES.some((m) => m.re.test(p)) ||
    ANALOG.some((a) => a.re.test(p)) ||
    LOADS.some((l) => l.re.test(p)) ||
    PORTS.some((x) => x.re.test(p)) ||
    ARCHETYPES.some((a) => a.re.test(p))
  )
}

/** Clean a raw phrase into { words, n } or null when nothing device-like is left. */
function nounPhrase(seg: string): { words: string[]; n: number } | null {
  const toks = seg.trim().split(/\s+/).filter(Boolean)
  if (!toks.length || VERB_RE.test(toks[0])) return null
  let n = 1
  const words: string[] = []
  for (const t of toks) {
    if (/^\d{1,2}x?$/.test(t)) n = parseInt(t, 10) || 1
    else if (WORDNUM[t] && !words.length) n = WORDNUM[t]
    if (STOP_RE.test(t) || /^\d/.test(t)) continue
    if (!/^[a-z][a-z0-9-]{1,19}$/.test(t) || !/[aeiouy]/.test(t)) return null
    words.push(t)
  }
  if (!words.length || words.length > 4 || !words.some((w) => w.length >= 3)) return null
  const kept = words.slice(-3)
  const last = kept[kept.length - 1]
  if (/[^s]s$/.test(last) && last.length > 3) kept[kept.length - 1] = last.replace(/(ch|sh|x)es$/, '$1').replace(/ies$/, 'y').replace(/s$/, '')
  return { words: kept, n: Math.max(1, Math.min(n, 4)) }
}

const CLAUSE_CUT = /\b(?:for|to|that|which|so|when|while|on|in|at|from|via|over|by|is|are|can|should|will|if|then)\b/

/** Devices the request names that no table knows: one generic 3-pin connector each. */
function leftovers(raw: string): Feat[] {
  const out: Feat[] = []
  const seen = new Set<string>()
  const push = (seg: string, kind: 'sig' | 'adc' | 'load') => {
    const np = nounPhrase(seg.split(CLAUSE_CUT)[0])
    if (!np) return
    const phrase = np.words.join(' ')
    if (isKnown(phrase) || isKnown(seg)) return
    const label = netName(np.words.join('_')).slice(0, 16)
    if (!label || seen.has(label)) return
    seen.add(label)
    const sensor = kind === 'adc' || /sensor|probe|detector|meter|gauge|transducer|sense$/.test(phrase)
    if (kind === 'load') out.push({ k: 'load', label, n: np.n, purpose: phrase })
    else out.push({ k: 'sig', label, n: np.n, adc: sensor, purpose: `${phrase} connector` })
  }
  // verb-implied IO
  const obj = '((?:[a-z0-9\'-]+\\s+){0,3}?[a-z0-9\'-]+)(?=\\s*(?:[,.;]|$|\\b(?:and|with|using|then|to|via|over|on|in|from|plus|for|when|if|by)\\b))'
  for (const m of raw.matchAll(new RegExp(`\\b(?:measur\\w+|sens(?:e|es|ing)|monitor(?:s|ing)?|detect(?:s|ing)?)\\s+${obj}`, 'g'))) push(m[1], 'adc')
  for (const m of raw.matchAll(new RegExp(`\\b(?:controls?|controlling|driv(?:e|es|ing)|switch(?:es|ing)?|turn(?:s|ing)? on|activat\\w+|trigger(?:s|ing)?)\\s+${obj}`, 'g'))) push(m[1], 'load')
  // "... with X, Y and Z"
  const w = /\b(?:with|using|uses|use|including|includes|plus|featuring|containing|that has|which has|has|have|needs?)\b/.exec(raw)
  if (w) {
    for (const seg of raw.slice(w.index + w[0].length).split(/\b(?:with|using|including|includes|plus|featuring|containing|and|as well as|also)\b|[,;+&/]/)) {
      if (seg.trim()) push(seg, 'sig')
    }
  }
  return out
}

function expand(raw: string): Expansion {
  const x: Expansion = { names: [], kw: '', feats: [], servos: 0, steppers: 0, noMotors: false, battery: false }
  for (const a of ARCHETYPES) {
    if (!a.re.test(raw) || (a.not && a.not.test(raw))) continue
    try {
      a.apply(raw, x)
      x.names.push(a.name)
    } catch {
      /* a broken archetype must not take the board down */
    }
    if (x.names.length >= 3) break
  }
  return x
}

/** Connectors placed on the board edge before the rest move inboard (keeps the outline compact). */
const EDGE_MAX = 9

class Planner {
  items: DigestItem[]
  byId: Map<string, DigestItem>
  intents: Intent[] = []
  used = new Set<string>()
  counters = new Map<string, number>()
  warnings: string[] = []
  edgeCycle = 0
  edgeCount = 0
  /** MCU pins still free (estimate of the pools buildNets allocates from) */
  gpio = IO_POOL.length
  adc = ADC_POOL.length
  spi = false
  i2c = false
  labels = new Set<string>()
  dropped: string[] = []
  devices: string[] = []
  inRail = '+5V'
  loadRail = '+5V'

  constructor(items: DigestItem[]) {
    this.items = items
    this.byId = new Map(items.map((i) => [i.id, i]))
  }

  find(cands: (string | RegExp)[], filter?: (i: DigestItem) => boolean): DigestItem | undefined {
    const ok = (i: DigestItem) => !filter || filter(i)
    for (const c of cands) {
      if (typeof c === 'string') {
        const it = this.byId.get(c)
        if (it && ok(it)) return it
      } else {
        const it = this.items.find((i) => ok(i) && (c.test(i.id) || c.test(i.name)))
        if (it) return it
      }
    }
    return undefined
  }

  ref(prefix: string) {
    const n = (this.counters.get(prefix) ?? 0) + 1
    this.counters.set(prefix, n)
    return `${prefix}${n}`
  }

  nextEdge(): 'back' | 'right' | 'left' {
    const e = (['back', 'right', 'back', 'left'] as const)[this.edgeCycle++ % 4]
    return e
  }

  add(prefix: string, item: DigestItem | undefined, i: Omit<Intent, 'ref' | 'catalogId'>): string | undefined {
    if (!item) return undefined
    const ref = this.ref(prefix)
    // the board edge only has room for so many connectors: later ones sit inside the outline
    if (i.role === 'connector' && i.edge && i.edge !== 'front' && ++this.edgeCount > EDGE_MAX) i = { ...i, role: 'other', edge: undefined }
    this.intents.push({ ...i, ref, catalogId: item.id })
    return ref
  }

  /** Reserve n general-purpose MCU pins; false (and a note) when the pool is exhausted. */
  spend(n: number, what: string): boolean {
    if (n > this.gpio) {
      if (!this.dropped.includes(what)) this.dropped.push(what)
      return false
    }
    this.gpio -= n
    return true
  }

  /** Reserve n ADC pins: four are input-only, the last two also sit in the GPIO pool. */
  spendAdc(n: number, what: string): boolean {
    const shared = Math.max(0, n - Math.max(0, this.adc - 2))
    if (n > this.adc || shared > this.gpio) {
      if (!this.dropped.includes(what)) this.dropped.push(what)
      return false
    }
    this.adc -= n
    this.gpio -= shared
    return true
  }

  moduleCost(item: DigestItem, dev: Device): number {
    const f = item.interfaces
    const bus = f.includes('spi') && !f.includes('i2c')
    if (dev.cost !== undefined) return dev.cost
    // I2C devices share the bus; their interrupt pin is wired only when pins are left over
    if (f.includes('i2c')) return 0
    if (bus) return Math.max(1, item.pads - 5) + (this.spi ? 0 : 3)
    if (f.includes('uart')) return 2
    return Math.max(1, item.pads - 2)
  }

  // common parts
  cap100n = () => this.find(['c-0603-100n', 'mlcc-100n-0805', 'c-0805-100n', /100n/], (i) => i.pads === 2)
  cap10u = () => this.find(['c-0805-10u', 'mlcc-10u-0805', 'c-0603-10u', /\b10u|10 ?µf/i], (i) => i.pads === 2 && !/ecap/.test(i.id)) ?? this.cap100n()
  cap1u = () => this.find(['c-0603-1u', 'c-0805-1u'], (i) => i.pads === 2) ?? this.cap100n()
  bulk = () => this.find(['ecap-220u-25', 'ecap-220u-25v', 'ecap-470u-16', 'ecap-100u-16', /ecap/]) ?? this.cap10u()
  res = (v: '10k' | '1k' | '4.7k' | '5.1k' | '330' | '100k' | '22k') => {
    const table: Record<string, (string | RegExp)[]> = {
      '10k': ['r-0603-10k', 'res-10k-0603', 'r-0805-10k', /10k/i],
      '1k': ['r-0603-1k', 'res-1k-0603', 'r-0805-1k', /(^|-)1k/i],
      '4.7k': ['r-0603-4.7k', 'res-4k7-0603', /4\.?7k|4k7/i],
      '5.1k': ['res-5k1-0603', /5\.1k|5k1/i, 'r-0603-4.7k', 'res-4k7-0603'],
      '330': ['r-0603-330', 'r-0603-220', 'r-0603-470', /330|220|470/, 'r-0603-1k', 'res-1k-0603'],
      '100k': ['r-0603-100k', 'r-0805-100k', /100k/i],
      '22k': ['r-0603-22k', 'r-0805-22k', /22k/i],
    }
    return this.find(table[v], (i) => i.pads === 2) ?? this.find(['res-10k-0603', 'r-0603-10k'])
  }
  header = (n: number) =>
    this.find([`jst-ph-${n}`, `jst-xh-${n}`, `header-1x${n}`, `terminal-${n}p-5.08`], (i) => i.pads === n) ??
    this.find([/header|jst|terminal|screw/i], (i) => i.pads === n)
  screw = (n: 2 | 3) => this.find([`screw-508-${n}`, `terminal-${n}p-5.08`], (i) => i.pads === n) ?? this.header(n)
  diode = () => this.find(['ss34', '1n5819', '1n4148w', /schottky|diode/i], (i) => i.pads === 2)
  fet = () => this.find(['ao3400', 'irlz44n', '2n7002', /mosfet/i], (i) => i.pads >= 3)

  decouple(near: string, rail: string, big = false) {
    this.add('C', this.cap100n(), { role: 'decoupling', dev: 'fixed', near, purpose: `100 nF decoupling for ${near} (${rail})`, nets: { 1: rail, 2: 'GND' } })
    if (big) this.add('C', this.cap10u(), { role: 'decoupling', dev: 'fixed', near, purpose: `10 µF bulk for ${near} (${rail})`, nets: { 1: rail, 2: 'GND' } })
  }

  /** Low-side MOSFET + flyback diode + 2-pin terminal. */
  load(label: string, purpose: string): boolean {
    const fet = this.fet()
    if (!fet || this.labels.has(label) || !this.spend(1, purpose)) return false
    this.labels.add(label)
    const sw = `${label}_SW`
    const gate = `@GPIO:${label}_EN`
    const qref = this.add('Q', fet, {
      role: 'ic',
      dev: 'fixed',
      purpose: `low-side MOSFET switch for the ${purpose}`,
      nets: fet.id === 'irlz44n' ? { 1: gate, 2: sw, 3: 'GND' } : { 1: gate, 2: 'GND', 3: sw },
    })
    if (!qref) return false
    this.add('D', this.diode(), { role: 'passive', dev: 'fixed', near: qref, purpose: `flyback diode across the ${purpose}`, nets: { 1: sw, 2: this.loadRail } })
    this.add('J', this.screw(2), { role: 'connector', dev: 'fixed', edge: this.nextEdge(), purpose: `${purpose} terminal (+ / switched −)`, nets: { 1: this.loadRail, 2: sw } })
    return true
  }

  /** Emit one generic functional block; returns how many instances were fitted. */
  feat(f: Feat): number {
    if (f.k === 'vsense') {
      const src = this.loadRail !== this.inRail ? this.loadRail : this.inRail === 'VSYS' ? 'VBAT' : null
      if (!src || this.labels.has('VSENSE_DIV') || !this.spendAdc(1, 'supply voltage sense')) return 0
      this.labels.add('VSENSE_DIV')
      const tok = '@ADC:VBAT_SENSE'
      const top = this.add('R', this.res('100k'), { role: 'passive', dev: 'fixed', purpose: `${src} sense divider, top (100k)`, nets: { 1: src, 2: tok } })
      this.add('R', this.res(src === 'VBAT' && this.loadRail === this.inRail ? '100k' : '22k'), { role: 'passive', dev: 'fixed', near: top, purpose: `${src} sense divider, bottom`, nets: { 1: tok, 2: 'GND' } })
      this.add('C', this.cap100n(), { role: 'passive', dev: 'fixed', near: top, purpose: `${src} sense filter cap`, nets: { 1: tok, 2: 'GND' } })
      this.devices.push('supply voltage sense')
      return 1
    }
    const n = Math.max(1, Math.min(('n' in f ? f.n : 1) ?? 1, 8))
    let done = 0
    for (let k = 1; k <= n; k++) {
      const label = n > 1 ? `${f.label}${k}` : f.label
      const purpose = n > 1 ? `${f.purpose} ${k}` : f.purpose
      if (this.labels.has(label)) continue
      let ok = false
      if (f.k === 'load') ok = this.load(label, purpose)
      else if (f.k === 'pwm') {
        const h = this.header(3)
        ok = !!h && this.spend(1, f.purpose) && !!this.add('J', h, { role: 'connector', dev: 'fixed', edge: this.nextEdge(), purpose, nets: { 1: `@GPIO:${label}_PWM`, 2: f.powered ? this.inRail : null, 3: 'GND' } })
      } else if (f.k === 'sig') {
        const h = this.header(3)
        // sensors prefer an ADC pin and fall back to plain GPIO when those are gone
        const adc = !!f.adc && this.adc > 0 && this.spendAdc(1, f.purpose)
        ok = !!h && (adc || this.spend(1, f.purpose)) && !!this.add('J', h, { role: 'connector', dev: 'fixed', edge: this.nextEdge(), purpose: `${purpose} (${f.v5 ? '5V' : '3V3'} GND SIG)`, nets: { 1: f.v5 ? this.inRail : '+3V3', 2: 'GND', 3: `${adc ? '@ADC' : '@GPIO'}:${label}` } })
      } else if (f.k === 'sw') {
        const h = this.header(2)
        ok = !!h && this.spend(1, f.purpose) && !!this.add('J', h, { role: 'connector', dev: 'fixed', edge: this.nextEdge(), purpose: `${purpose} (SIG GND)`, nets: { 1: `@GPIO:${label}`, 2: 'GND' } })
      } else if (f.k === 'btn') {
        const t = this.find(['tact-6mm', 'tact-6x6', /tact/i], (i) => i.pads === 4)
        ok = !!t && this.spend(1, f.purpose) && !!this.add('SW', t, { role: 'switch', dev: 'fixed', purpose: `${purpose} (to GND, internal pull-up)`, nets: { 1: `@GPIO:${label}`, 2: 'GND' } })
      } else if (f.k === 'therm') {
        const h = this.header(2)
        ok = !!h && this.spendAdc(1, f.purpose)
        if (ok) {
          const tok = `@ADC:${label}`
          const j = this.add('J', h!, { role: 'connector', dev: 'fixed', edge: this.nextEdge(), purpose: `${purpose} (SIG GND)`, nets: { 1: tok, 2: 'GND' } })
          this.add('R', this.res('10k'), { role: 'passive', dev: 'fixed', near: j, purpose: `${label} thermistor pull-up`, nets: { 1: '+3V3', 2: tok } })
        }
      } else if (f.k === 'port') {
        const h = this.header(2 + f.sigs.length)
        const spiPort = f.sigs.includes('SCK')
        const own = f.sigs.filter((s) => !/^(SCK|MOSI|MISO|SDA|SCL)$/.test(s)).length
        ok = !!h && this.spend(own + (spiPort && !this.spi ? 3 : 0), f.purpose)
        if (ok) {
          const nets: Record<number, Tok> = { 1: f.v5 ? this.inRail : '+3V3', 2: 'GND' }
          f.sigs.forEach((s, i) => {
            nets[i + 3] = /^(SCK|MOSI|MISO)$/.test(s) ? `SPI_${s}` : s === 'SDA' || s === 'SCL' ? s : `@GPIO:${label}_${s}`
          })
          if (spiPort) this.spi = true
          if (f.sigs.includes('SDA')) this.i2c = true
          this.add('J', h!, { role: 'connector', dev: 'fixed', edge: this.nextEdge(), purpose: f.purpose, nets })
        }
      }
      if (!ok) break
      this.labels.add(label)
      done++
    }
    if (done) this.devices.push(`${done > 1 ? `${done}× ` : ''}${f.purpose.replace(/ \(.*$/, '')}`)
    return done
  }

  run(request: string) {
    const raw = ` ${request.toLowerCase().slice(0, 2000).replace(/[^a-z0-9 .,;:+&/'-]+/g, ' ').replace(/\s+/g, ' ').trim()} `
    const x = expand(raw)
    const q = `${raw}${x.kw} `
    const devices = this.devices

    // ---- power architecture
    const buck = this.find(['mp1584', /buck/i], (i) => i.pads >= 4)
    const hv = buck && this.screw(2) ? x.hv : undefined
    const battery = !hv && (x.battery || /batter|wristband|wearable|portable|lipo|li-?ion|18650|cordless|handheld|watch|wireless remote|solar/.test(q))
    const split = battery || !!hv
    const usbRail = split ? 'VBUS' : '+5V'
    const inRail = split ? 'VSYS' : '+5V'
    this.inRail = inRail
    this.loadRail = hv ?? inRail

    // ---- MCU
    const mcuItem =
      this.find(['esp32-wroom-32e', /esp32.?wroom/i]) ??
      this.find(['esp32-s3-wroom-1', 'esp32-c3-mini-1']) ??
      this.items.find((i) => /mcu|module/i.test(i.category) && i.pads >= 20) ??
      this.items.find((i) => /board/i.test(i.category))
    const mcu = this.add('U', mcuItem, { role: 'mcu', dev: 'mcu', inRail, purpose: 'ESP32 controller: Wi-Fi + BLE, runs the firmware' })
    if (mcu) this.decouple(mcu, '+3V3', true)

    // ---- power entry: USB-C
    const usb = this.add('J', this.find(['usbc-16p', 'usb-c-16p', /usb.?c/i]), {
      role: 'connector',
      dev: 'usb',
      edge: 'front',
      rail: usbRail,
      purpose: 'USB-C 5 V power input',
    })
    if (usb) {
      const rr = this.res('5.1k')
      this.add('R', rr, { role: 'passive', dev: 'fixed', near: usb, purpose: 'USB-C CC1 pull-down (sink)', nets: { 1: 'CC1', 2: 'GND' } })
      this.add('R', rr, { role: 'passive', dev: 'fixed', near: usb, purpose: 'USB-C CC2 pull-down (sink)', nets: { 1: 'CC2', 2: 'GND' } })
    }

    // ---- battery pack / DC input with a buck converter, diode OR-ed with USB
    if (hv) {
      const what = hv === 'VBAT' ? 'battery pack input terminal (2S–4S LiPo, + / −)' : 'DC power input terminal (12–24 V, + / −)'
      const t = this.add('J', this.screw(2), { role: 'connector', dev: 'fixed', edge: 'left', purpose: what, nets: { 1: hv, 2: 'GND' } })
      this.add('C', this.bulk(), { role: 'decoupling', dev: 'fixed', near: t, purpose: `${hv} input bulk cap`, nets: { 1: hv, 2: 'GND' } })
      this.add('U', buck, { role: 'power', dev: 'fixed', purpose: `buck converter module (${hv} → 5 V)`, nets: { 1: hv, 2: 'GND', 3: 'BUCK_5V', 4: 'GND' } })
      const d = this.diode()
      const d1 = this.add('D', d, { role: 'power', dev: 'fixed', purpose: 'Schottky OR-ing: USB to system rail', nets: { 1: usbRail, 2: inRail } })
      this.add('D', d, { role: 'power', dev: 'fixed', near: d1, purpose: 'Schottky OR-ing: buck 5 V to system rail', nets: { 1: 'BUCK_5V', 2: inRail } })
      devices.push(hv === 'VBAT' ? 'battery input + 5 V buck' : 'DC input + 5 V buck')
    }

    // ---- battery with charger and diode OR-ing
    if (battery) {
      const charger = this.find(['tp4056'])
      const batJ = this.add('J', this.find(['lipo-jst-ph-2', 'jst-ph-2', /jst/i], (i) => i.pads === 2) ?? this.screw(2), {
        role: 'connector',
        dev: 'fixed',
        edge: 'left',
        purpose: 'Li-ion / LiPo battery connector',
        nets: { 1: 'VBAT', 2: charger ? 'BAT_N' : 'GND' },
      })
      let batOut = 'VBAT'
      if (charger && batJ) {
        this.add('U', charger, {
          role: 'power',
          dev: 'fixed',
          edge: 'left',
          purpose: 'TP4056 Li-ion charger with protection (charges from USB)',
          nets: { 1: usbRail, 2: 'GND', 3: 'VBAT', 4: 'BAT_N', 5: 'VBAT_OUT', 6: 'GND' },
        })
        // only a 6-pad module breaks out the protected OUT+ pad
        if (charger.pads >= 6) batOut = 'VBAT_OUT'
      }
      const d = this.diode()
      const d1 = this.add('D', d, { role: 'power', dev: 'fixed', purpose: 'Schottky OR-ing: USB to system rail', nets: { 1: usbRail, 2: inRail } })
      this.add('D', d, { role: 'power', dev: 'fixed', near: d1, purpose: 'Schottky OR-ing: battery to system rail', nets: { 1: batOut, 2: inRail } })
    }

    // ---- 3V3 regulator
    const reg = this.add('U', this.find(['ams1117-33', 'ams1117-3.3', /ams1117|ldo|regulator/i], (i) => /power/i.test(i.category) || /1117/.test(i.id)), {
      role: 'power',
      dev: 'reg',
      inRail,
      purpose: `3.3 V LDO regulator (${inRail} → +3V3)`,
    })
    if (reg) {
      this.add('C', this.cap10u(), { role: 'decoupling', dev: 'fixed', near: reg, purpose: `regulator input cap (${inRail})`, nets: { 1: inRail, 2: 'GND' } })
      this.add('C', this.cap10u(), { role: 'decoupling', dev: 'fixed', near: reg, purpose: 'regulator output cap (+3V3)', nets: { 1: '+3V3', 2: 'GND' } })
    }

    // ---- MCU support: reset, boot, UART, status LED
    if (mcu) {
      this.add('R', this.res('10k'), { role: 'passive', dev: 'fixed', near: mcu, purpose: 'EN pull-up', nets: { 1: '+3V3', 2: 'EN' } })
      this.add('C', this.cap1u(), { role: 'passive', dev: 'fixed', near: mcu, purpose: 'EN reset delay cap', nets: { 1: 'EN', 2: 'GND' } })
      const tact = this.find(['tact-6mm', 'tact-6x6', /tact/i], (i) => i.pads === 4)
      this.add('SW', tact, { role: 'switch', dev: 'fixed', purpose: 'RESET button (EN to GND)', nets: { 1: 'EN', 2: 'GND' } })
      this.add('SW', tact, { role: 'switch', dev: 'fixed', purpose: 'BOOT button (IO0 to GND)', nets: { 1: 'BOOT', 2: 'GND' } })
      this.add('J', this.header(4), { role: 'connector', dev: 'fixed', edge: this.nextEdge(), purpose: 'UART programming header (GND TX RX 3V3)', nets: { 1: 'GND', 2: 'U0TX', 3: 'U0RX', 4: '+3V3' } })
      const led = this.add('D', this.find(['led-0603-green', 'led-0603', 'led-0603-blue', /led/i], (i) => i.pads === 2 && /indicator|led/i.test(i.category)), {
        role: 'indicator',
        dev: 'fixed',
        purpose: 'status LED',
        nets: { 1: 'LED_STATUS', 2: 'GND' },
      })
      if (led) {
        this.add('R', this.res('1k'), { role: 'passive', dev: 'fixed', near: led, purpose: 'status LED current limit', nets: { 1: '@GPIO:STATUS_LED', 2: 'LED_STATUS' } })
        this.gpio -= 1
      }
    }

    // ---- actuator counts, reserved up front so sensors cannot starve the product's core outputs
    const said = (noun: string) => countOf(raw, noun, 0, 8)
    let servoN = /servo/.test(q) || x.servos ? said('servos?') || x.servos || (/servos/.test(q) ? 2 : 1) : 0
    const stepDrv = this.find(['a4988', 'drv8825', 'tmc2209'])
    let stepN = stepDrv && (x.steppers || /stepper/.test(q)) ? Math.min(said('steppers?') || x.steppers || (/steppers/.test(q) ? 2 : 1), 4) : 0
    const motorDrv = this.find(['tb6612fng', /tb6612/i, 'drv8833'])
    const wantsMotors = !x.noMotors && !!motorDrv && !WRIST_BRIEF.test(q) && /\bmotor|wheel|rover|robot|\bcar\b|4wd|2wd|\bdrive\b|tank|mecanum|propel|vehicle|buggy|truck/.test(q) && !/\bstepper motor|servo motor|fish tank|water tank/.test(q)
    let motorN = wantsMotors ? (/4wd|four.?wheel|4 ?motors|four motors|mecanum|quad/.test(q) ? 4 : Math.min(countOf(q, 'motors?', 2), 4)) : 0
    const actCost = () => servoN + (stepN ? 2 * stepN + 1 : 0) + 3 * motorN
    while (actCost() > this.gpio - 1 && (servoN > 1 || stepN > 1 || motorN > 2)) {
      if (servoN > 1 && servoN >= stepN) servoN--
      else if (stepN > 1) stepN--
      else motorN -= 2
    }
    if (actCost() > this.gpio) servoN = stepN = motorN = 0
    this.gpio -= actCost()
    const wantsStrip = /led strip|neopixel|ws2812|addressable|rgb strip|light strip|pixel leds?/.test(q) && this.spend(1, 'LED strip')

    // ---- the product's own blocks (archetype expansion)
    for (const f of x.feats) this.feat(f)

    // ---- catalog modules (sensors, displays, comms, ...)
    const taken = new Set<string>()
    // modules the request names come before the ones the archetype merely implies
    const wanted = MODULES.filter((m) => m.re.test(q))
    for (const { dev } of [...wanted.filter((m) => m.re.test(raw)), ...wanted.filter((m) => !m.re.test(raw))]) {
      const item = this.find(dev.ids.filter((id) => typeof id !== 'string' || !taken.has(id)))
      if (!item || taken.has(item.id)) continue
      const spiDev = item.interfaces.includes('spi') && !item.interfaces.includes('i2c')
      if (!this.spend(this.moduleCost(item, dev), item.name)) continue
      taken.add(item.id)
      const r = this.add('J', item, {
        role: 'connector',
        dev: 'device',
        edge: this.nextEdge(),
        rail: dev.rail === '5V' ? inRail : '+3V3',
        label: dev.label,
        adc: dev.adc,
        pinFns: dev.pinFns,
        purpose: `${dev.purpose} — ${item.name}`,
      })
      if (r) devices.push(item.name)
      if (spiDev) this.spi = true
      if (item.interfaces.includes('i2c')) this.i2c = true
      if (dev.adc) this.adc = Math.max(0, this.adc - 2)
    }

    // ---- servos
    if (servoN) {
      const item = this.find(['sg90']) ?? this.header(3)
      for (let k = 1; k <= servoN; k++) {
        const r = this.add('J', item, {
          role: 'connector',
          dev: item?.id === 'sg90' ? 'device' : 'fixed',
          edge: this.nextEdge(),
          rail: inRail,
          label: `SERVO${k}`,
          purpose: `servo ${k} connector (PWM, 5 V)`,
          nets: item?.id === 'sg90' ? undefined : { 1: `@GPIO:SERVO${k}_PWM`, 2: inRail, 3: 'GND' },
        })
        if (r && k === 1) devices.push(`${servoN} servo(s)`)
      }
      this.add('C', this.bulk(), { role: 'decoupling', dev: 'fixed', purpose: `servo supply bulk cap (${inRail})`, nets: { 1: inRail, 2: 'GND' } })
    }

    // ---- steppers
    if (stepN && stepDrv) {
      for (let k = 1; k <= stepN; k++) {
        const r = this.add('U', stepDrv, { role: 'ic', dev: 'stepdrv', label: `STEP${k}`, rail: this.loadRail, purpose: `stepper driver ${k} (${stepDrv.name})` })
        if (!r) continue
        this.add('C', this.bulk(), { role: 'decoupling', dev: 'fixed', near: r, purpose: `stepper ${k} motor supply bulk`, nets: { 1: this.loadRail, 2: 'GND' } })
        // the coil pads only exist on the full-size footprint; otherwise the motor plugs into the driver module itself
        if (stepDrv.pads >= 12)
          this.add('J', this.header(4) ?? this.screw(2), {
            role: 'connector',
            dev: 'fixed',
            edge: this.nextEdge(),
            purpose: `stepper motor ${k} coils (1A 1B 2A 2B)`,
            nets: { 1: `STEP${k}_1A`, 2: `STEP${k}_1B`, 3: `STEP${k}_2A`, 4: `STEP${k}_2B` },
          })
      }
      devices.push(`${stepN} stepper driver(s)`)
    }

    // ---- DC motors: TB6612FNG dual H-bridges + screw terminals
    if (motorN && motorDrv) {
      const n = motorN
      const motors: string[] = []
      for (let k = 1; k <= n; k++) motors.push(`M${k}`)
      for (let d = 0; d < Math.ceil(n / 2); d++) {
        const a = motors[2 * d]
        const b = motors[2 * d + 1] ?? `M${n + 1}`
        const drv = this.add('U', motorDrv, {
          role: 'ic',
          dev: 'tb6612',
          motors: [a, b],
          rail: inRail,
          purpose: `dual H-bridge for motors ${a}${motors[2 * d + 1] ? `/${b}` : ''}`,
        })
        if (!drv) continue
        this.decouple(drv, '+3V3')
        this.add('C', this.bulk(), { role: 'decoupling', dev: 'fixed', near: drv, purpose: `motor supply bulk cap (${inRail})`, nets: { 1: inRail, 2: 'GND' } })
      }
      const sides: ('left' | 'right')[] = ['left', 'right']
      for (let k = 0; k < n; k++) {
        this.add('J', this.screw(2), { role: 'connector', dev: 'fixed', edge: sides[k % 2], purpose: `motor ${motors[k]} terminal`, nets: { 1: `${motors[k]}+`, 2: `${motors[k]}-` } })
      }
      devices.push(`${n} DC motors`)
    }

    // ---- addressable LED strip
    if (wantsStrip) {
      const j = this.add('J', this.screw(3), { role: 'connector', dev: 'fixed', edge: this.nextEdge(), purpose: 'WS2812B LED strip connector (5V DIN GND)', nets: { 1: inRail, 2: 'STRIP_DIN', 3: 'GND' } })
      if (j) {
        this.add('R', this.res('330'), { role: 'passive', dev: 'fixed', near: j, purpose: 'LED strip data series resistor', nets: { 1: '@GPIO:STRIP_DATA', 2: 'STRIP_DIN' } })
        this.add('C', this.bulk(), { role: 'decoupling', dev: 'fixed', near: j, purpose: 'LED strip supply bulk cap', nets: { 1: inRail, 2: 'GND' } })
        devices.push('LED strip')
      }
    }

    // ---- switched loads
    for (const l of LOADS) {
      if (!l.re.test(q)) continue
      const n = countOf(raw, `${l.label.toLowerCase()}s?`, 1, 4)
      let done = 0
      for (let k = 1; k <= n; k++) if (this.load(n > 1 ? `${l.label}${k}` : l.label, n > 1 ? `${l.purpose} ${k}` : l.purpose)) done++
      if (done) devices.push(`${done > 1 ? `${done}× ` : ''}${l.purpose}`)
    }

    // ---- off-board analog sensors
    for (const a of ANALOG) {
      if (!a.re.test(q) || this.adc <= 0) continue
      const plural = new RegExp(`${a.noun}\\w*\\s+(?:\\w+\\s+)?(sensors|probes|channels|inputs|electrodes)|sensors`).test(q)
      let n = Math.min(countOf(q, a.noun, plural ? a.plural : 1), this.adc)
      while (n > 0 && !this.spendAdc(n, `${a.label.toLowerCase()} input`)) n--
      if (!n) continue
      const conn = this.header(3)
      for (let k = 1; k <= n; k++) {
        this.add('J', conn, {
          role: 'connector',
          dev: 'fixed',
          edge: this.nextEdge(),
          purpose: `${a.purpose}${n > 1 ? ` ${k}` : ''} (VCC GND SIG)`,
          nets: { 1: '+3V3', 2: 'GND', 3: `@ADC:${a.label}${n > 1 ? k : ''}` },
        })
      }
      devices.push(`${n}× ${a.label.toLowerCase()} input`)
    }

    // ---- named peripherals without a catalog module
    for (const p of PORTS) if (p.re.test(raw)) this.feat(p.feat.k === 'btn' ? { ...p.feat, n: countOf(raw, 'buttons?|push ?buttons?', /buttons/.test(raw) ? 2 : 1, 6) } : p.feat)

    // ---- catch-all: anything else the request names gets its own generic connector (lowest priority)
    let generic = 0
    for (const f of leftovers(raw)) {
      if (generic >= 8) {
        this.dropped.push(f.k === 'vsense' ? 'extra' : f.purpose)
        continue
      }
      generic += this.feat(f)
    }

    // ---- I2C pull-ups
    if (this.i2c && mcu) {
      const r = this.res('4.7k')
      this.add('R', r, { role: 'passive', dev: 'fixed', near: mcu, purpose: 'I2C SDA pull-up', nets: { 1: '+3V3', 2: 'SDA' } })
      this.add('R', r, { role: 'passive', dev: 'fixed', near: mcu, purpose: 'I2C SCL pull-up', nets: { 1: '+3V3', 2: 'SCL' } })
    }

    // ---- nothing specific recognised: GPIO breakout so the board is still useful
    if (!devices.length) {
      const h = this.header(8) ?? this.header(6)
      if (h) {
        const nets: Record<number, Tok> = { 1: '+3V3', 2: 'GND' }
        for (let k = 3; k <= h.pads; k++) nets[k] = `@GPIO:GPIO_${k - 2}`
        this.add('J', h, { role: 'connector', dev: 'fixed', edge: 'back', purpose: 'GPIO breakout header (3V3 GND + GPIO)', nets })
      }
    }

    return { devices, battery, inRail, hv, archetypes: x.names, dropped: this.dropped }
  }
}

function boardName(request: string): string {
  const head = request.split(/\b(?:with|for|that|using|which|featuring)\b|[,.;:]/i)[0]
  const words = head
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^(a|an|the|make|build|design|create|me|i|want|need|please|simple|small)$/i.test(w))
    .slice(0, 4)
    .map((w) => w.slice(0, 24))
  if (!words.length) return 'ESP32 Dev Board'
  const title = words.map((w) => (w.length <= 3 && /^[a-z0-9]+$/i.test(w) && !/^(and|of|to)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ')
  return /board|controller|station|module|hub/i.test(title) ? title : `${title} Board`
}

// ---------------------------------------------------------------- netlist

function pinNamesFor(p: BlockPart, intent: Intent | undefined): string[] {
  if (intent?.pinFns) return intent.pinFns
  if (p.names && p.names.length >= p.pins) return p.names.map(norm)
  const n = p.pins
  const nm = p.name.toUpperCase()
  const pad = (a: string[]) => Array.from({ length: n }, (_, i) => a[i] ?? 'NC')
  switch (p.kind) {
    case 'module':
      return pad(ESP32_PINS)
    case 'ssop':
      return pad(TB6612_PINS)
    case 'soic':
      return /CH34/.test(nm) ? pad(CH340_PINS) : pad([])
    case 'usbc':
      return pad(USBC_PINS)
    case 'sot223':
      return /1117|LDO|REG|78|LM|AP2|XC6|MCP17/.test(nm) ? pad(['GND', 'VOUT', 'VIN', 'VOUT']) : pad(['G', 'S', 'D', 'D'])
    case 'led':
      return pad(['A', 'K'])
    case 'ecap':
      return pad(['+', '-'])
    default:
      return Array.from({ length: n }, (_, i) => String(i + 1))
  }
}

const GND_RE = /^(GND\d*|P?GND\d*|AGND|DGND|VSS|0V|-|IN-|OUT-|SLEEVE|SHIELD|SHELL)$/
const SUPPLY_RE = /^(VCC|VDD|VIN|VDDIO|VIO|3V3|3\.3V?|\+3V3|5V|\+5V|VBAT|PWR|V\+|\+)$/
const IGNORE_RE = /^(NC|XDA|XCL|AD0|ADDR|CSB|ALRT|GAIN|L\/R|SW2|VO|RW|T_CS|ANT|SBU\d|D[NP]\d|UD[+-]|NC\d*|IP[+-]|VIN[+-]|COM|NO|PPS|STATE|RING|FAULT|DIAG|MS\d|M\d|SLP|PROGRAM)$/

function deviceToken(name: string, it: Intent | undefined, ref: string, spiDev: boolean): Tok {
  const n = norm(name)
  if (!n || /^\d+$/.test(n)) return null
  if (GND_RE.test(n)) return 'GND'
  if (SUPPLY_RE.test(n)) return it?.rail ?? '+3V3'
  if (/^(BLK|LED|BL|A)$/.test(n) && spiDev) return it?.rail ?? '+3V3'
  if (n === 'SDA') return spiDev ? 'SPI_MOSI' : 'SDA'
  if (n === 'SCL') return spiDev ? 'SPI_SCK' : 'SCL'
  if (/^(SCK|SCLK|CLK)$/.test(n)) return 'SPI_SCK'
  if (/^(MOSI|MO|SI|SDI|DI)$/.test(n) || (n === 'DIN' && spiDev)) return 'SPI_MOSI'
  if (/^(MISO|MI|SO|DO)$/.test(n) || (n === 'SDO' && spiDev)) return 'SPI_MISO'
  if (n === 'SDO') return 'GND'
  if (IGNORE_RE.test(n)) return null
  if (!it) return null // unknown part: only power / bus pins are certain
  const label = it.label ?? ref
  const analog = it.adc || /^(A\d|AOUT|AO|SIG|VRX|VRY|S\d|OUT)$/.test(n)
  return `${analog && it.adc !== false && (it.adc || /^(A\d|AOUT|AO|VRX|VRY)$/.test(n)) ? '@ADC' : '@GPIO'}:${netName(`${label}_${n}`)}`
}

function mcuToken(n: string, it: Intent | undefined, flags: { i2c: boolean; spi: boolean }): Tok {
  if (GND_RE.test(n)) return 'GND'
  if (/^(3V3|3\.3V?|\+3V3|VDD)$/.test(n)) return '+3V3'
  if (/^(5V|VIN|VBUS|VSYS|RAW|USB)$/.test(n)) return it?.inRail ?? '+5V'
  if (n === 'EN' || n === 'RST' || n === 'RUN') return 'EN'
  if (/^(TXD0|TX|TXD|U0TXD|GPIO43)$/.test(n)) return 'U0TX'
  if (/^(RXD0|RX|RXD|U0RXD|GPIO44)$/.test(n)) return 'U0RX'
  if (/^(IO0|GPIO0|BOOT0?)$/.test(n)) return 'BOOT'
  if (flags.i2c && /^(IO21|SDA)$/.test(n)) return 'SDA'
  if (flags.i2c && /^(IO22|SCL)$/.test(n)) return 'SCL'
  if (flags.spi && /^(IO18|SCK)$/.test(n)) return 'SPI_SCK'
  if (flags.spi && /^(IO23|MOSI|MO)$/.test(n)) return 'SPI_MOSI'
  if (flags.spi && /^(IO19|MISO|MI)$/.test(n)) return 'SPI_MISO'
  return null
}

function tb6612Token(n: string, it: Intent): Tok {
  const [a, b] = it.motors ?? ['MA', 'MB']
  if (GND_RE.test(n) || /^PGND\d$/.test(n)) return 'GND'
  if (/^VM\d?$/.test(n)) return it.rail ?? '+5V'
  if (n === 'VCC' || n === 'STBY') return '+3V3'
  if (n === 'AO1') return `${a}+`
  if (n === 'AO2') return `${a}-`
  if (n === 'BO1') return `${b}+`
  if (n === 'BO2') return `${b}-`
  const m = /^(A|B)IN(\d)$/.exec(n)
  if (m) return `@GPIO:${m[1] === 'A' ? a : b}_IN${m[2]}`
  if (n === 'PWMA') return `@GPIO:${a}_PWM`
  if (n === 'PWMB') return `@GPIO:${b}_PWM`
  return null
}

function stepToken(n: string, it: Intent): Tok {
  const l = it.label ?? 'STEP'
  if (GND_RE.test(n)) return 'GND'
  if (/^(VMOT|VM)$/.test(n)) return it.rail ?? '+5V'
  if (/^(VDD|VIO)$/.test(n)) return '+3V3'
  if (/^[12][AB]$/.test(n)) return `${l}_${n}`
  if (n === 'STEP' || n === 'DIR') return `@GPIO:${l}_${n}`
  // one shared enable line for all drivers
  if (n === 'EN') return '@GPIO:STEP_EN'
  return null
}

export function buildNets(parts: BlockPart[], intents: Map<string, Intent>): { name: string; pins: string[] }[] {
  // pass 1: tokens
  const toks: { pin: string; tok: Tok; mcu: boolean }[] = []
  const mcuPart = parts.find((p) => intents.get(p.ref)?.dev === 'mcu') ?? parts.find((p) => p.kind === 'module')
  const flags = { i2c: false, spi: false }
  const names = new Map(parts.map((p) => [p.ref, pinNamesFor(p, intents.get(p.ref))]))

  for (const p of parts) {
    if (p === mcuPart) continue
    const it = intents.get(p.ref)
    const nm = names.get(p.ref)!
    const spiDev = nm.some((x) => /^(CS|DC|CSN|NSS|SCSN|MOSI|DIN)$/.test(norm(x))) && !nm.some((x) => norm(x) === 'SDA' && !nm.some((y) => /^(DC|CS)$/.test(norm(y))))
    for (let i = 0; i < p.pins; i++) {
      let tok: Tok = null
      if (it?.nets) tok = it.nets[i + 1] ?? null
      else if (it?.dev === 'reg' || (!it && p.kind === 'sot223' && nm[0] === 'GND')) {
        const n = nm[i]
        tok = n === 'GND' ? 'GND' : /^VOUT/.test(n) ? '+3V3' : n === 'VIN' ? (it?.inRail ?? '+5V') : null
      } else if (it?.dev === 'usb' || (!it && p.kind === 'usbc')) {
        const n = nm[i]
        tok = n === 'VBUS' ? (it?.rail ?? '+5V') : GND_RE.test(n) ? 'GND' : /^CC[12]$/.test(n) ? n : null
      } else if (it?.dev === 'tb6612') tok = tb6612Token(nm[i], it)
      else if (it?.dev === 'stepdrv') tok = stepToken(norm(nm[i]), it)
      else tok = deviceToken(nm[i], it, p.ref, spiDev)
      if (!tok) continue
      if (tok === 'SDA' || tok === 'SCL') flags.i2c = true
      if (tok.startsWith('SPI_')) flags.spi = true
      toks.push({ pin: `${p.ref}.${i + 1}`, tok, mcu: false })
    }
  }

  // MCU fixed pins + GPIO pool
  const pool: string[] = []
  const adcPool: string[] = []
  const mcuPinOf = new Map<string, string>()
  if (mcuPart) {
    const it = intents.get(mcuPart.ref)
    const nm = names.get(mcuPart.ref)!.map(norm)
    nm.forEach((n, i) => {
      const pin = `${mcuPart.ref}.${i + 1}`
      const tok = mcuToken(n, it, flags)
      if (tok) toks.push({ pin, tok, mcu: true })
      else if (!mcuPinOf.has(n)) mcuPinOf.set(n, pin)
    })
    const esp = nm.includes('IO21')
    const ioOrder = esp ? IO_POOL : nm.filter((n) => /^(IO|GPIO|GP|D|P[A-D])\d+$/.test(n))
    const adcOrder = esp ? ADC_POOL : nm.filter((n) => /^(A|ADC)\d+$|^GP2[678]$/.test(n))
    for (const n of adcOrder) if (mcuPinOf.has(n)) adcPool.push(n)
    for (const n of ioOrder) if (mcuPinOf.has(n) && !adcPool.slice(0, 4).includes(n)) pool.push(n)
  }

  // pass 2: assign
  const nets = new Map<string, string[]>()
  const owner = new Set<string>()
  const add = (net: string, pin: string) => {
    if (owner.has(pin)) return
    owner.add(pin)
    const name = netName(net)
    const list = nets.get(name) ?? []
    list.push(pin)
    nets.set(name, list)
  }
  const usedMcu = new Set<string>()
  const allocated = new Set<string>()
  const take = (from: string[]) => {
    const n = from.find((x) => !usedMcu.has(x))
    if (n) usedMcu.add(n)
    return n
  }
  // optional interrupt / status lines are allocated last, so they never starve a real signal
  const optional = (t: { tok: Tok }) => (/^@GPIO:.*_(INT\d?|IRQ|DRDY)$/.test(t.tok ?? '') ? 1 : 0)
  for (const t of [...toks].sort((a, b) => optional(a) - optional(b))) {
    const m = /^@(GPIO|ADC):(.+)$/.exec(t.tok!)
    if (!m) {
      add(t.tok!, t.pin)
      continue
    }
    const net = m[2]
    if (!allocated.has(net)) {
      const n = m[1] === 'ADC' ? (take(adcPool) ?? take(pool)) : take(pool)
      if (!n) continue // out of GPIO: leave the pin unconnected
      allocated.add(net)
      add(net, mcuPinOf.get(n)!)
    }
    add(net, t.pin)
  }
  return [...nets].filter(([, pins]) => pins.length >= 2).map(([name, pins]) => ({ name, pins }))
}

// ---------------------------------------------------------------- entry

interface PlanOut {
  planner: Planner
  info: ReturnType<Planner['run']>
}

/** Plan the request; any internal failure degrades to the bare base board, then to a lone MCU. */
function safePlan(request: string, digest: DigestItem[]): PlanOut {
  for (const req of [request, '']) {
    try {
      const planner = new Planner(digest)
      const info = planner.run(req)
      if (planner.intents.length) return { planner, info }
    } catch {
      /* fall through to the base board */
    }
  }
  const planner = new Planner(digest)
  const first = digest.find((i) => /esp32.?wroom/i.test(i.id)) ?? digest[0]
  if (first) planner.intents.push({ ref: 'U1', catalogId: first.id, purpose: 'controller', role: 'mcu', dev: 'mcu' })
  return { planner, info: { devices: [], battery: false, inRail: '+5V', hv: undefined, archetypes: [], dropped: [] } }
}

/** A deterministic LlmCall that plans and wires boards without any model. One instance per generation. Never throws. */
export function offlineLlm(): LlmCall {
  const intents = new Map<string, Intent>()
  return async (o) => {
    const props = isRec(o?.schema) && isRec(o.schema.properties) ? o.schema.properties : {}
    const prompt = typeof o?.prompt === 'string' ? o.prompt : ''
    if ('replacements' in props) {
      // offline plans only use catalog ids; drop anything else
      const refs = [...prompt.matchAll(/^([A-Z]{1,3}\d{1,3}):/gm)].map((m) => m[1])
      return { replacements: refs.map((ref) => ({ ref, catalogId: 'DROP' })) }
    }
    if ('nets' in props || /schematic engine/i.test(String(o?.system ?? ''))) {
      let parts: BlockPart[] = []
      try {
        parts = parseBlock(prompt)
        return { nets: buildNets(parts, intents) }
      } catch {
        try {
          // wire by pin names only
          return { nets: buildNets(parts, new Map()) }
        } catch {
          return { nets: [] }
        }
      }
    }
    // plan
    let request = ''
    let digest: DigestItem[] = []
    try {
      request = /^Request: (.*)$/m.exec(prompt)?.[1] ?? prompt.slice(0, 2000)
      digest = parseDigest(prompt)
    } catch {
      /* keep the defaults */
    }
    const { planner, info } = safePlan(request, digest)
    const { devices, battery, inRail, hv, archetypes, dropped } = info
    intents.clear()
    for (const it of planner.intents) intents.set(it.ref, it)
    let name = 'ESP32 Dev Board'
    try {
      name = boardName(request)
    } catch {
      /* keep the default */
    }
    const power = hv
      ? `${hv === 'VBAT' ? 'battery pack' : 'DC input'} through a 5 V buck, diode OR-ed with USB-C,`
      : battery
        ? 'battery with USB charging and diode OR-ing'
        : 'USB-C 5 V'
    return {
      name,
      summary:
        `Offline planner: ESP32-WROOM-32E ${archetypes.length ? `${archetypes.join(' + ')} board` : 'controller'}` +
        `${devices.length ? ` with ${devices.slice(0, 14).join(', ')}` : ' with a GPIO breakout'}; ${power} feeding an AMS1117 3.3 V LDO.` +
        (dropped.length ? ` Not fitted (out of MCU pins): ${dropped.slice(0, 6).join(', ')}.` : ''),
      supply: hv ? `${hv === 'VBAT' ? '2S-4S LiPo' : '12-24V DC'} / USB-C 5V -> ${inRail} -> 3.3V` : battery ? `USB-C 5V / Li-ion -> ${inRail} -> 3.3V` : 'USB-C 5V -> 3.3V',
      parts: planner.intents.map((i) => ({ ref: i.ref, catalogId: i.catalogId, purpose: i.purpose, role: i.role, near: i.near ?? '', edge: i.edge ?? 'none' })),
    }
  }
}
