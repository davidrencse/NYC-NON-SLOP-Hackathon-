import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { loadEnv, runnerImport, type Plugin } from 'vite'
import { callGemini, MODELS, resolveApiKey, type GeminiUsage } from './gemini.ts'
import { readJson, sendJson } from './http.ts'
import { chassisHandler } from './chassis.ts'
import { resolveResearchHandoff } from './research-handoff.ts'
import type { ResearchContext } from '../src/ai/researchHandoff.ts'

/**
 * Vite dev + preview middleware for AI board generation.
 *
 *   POST /api/generate  {prompt: string, constraints?: {...}}
 *   → 200 application/x-ndjson, one event per line:
 *     {type:'stage', stage:'plan'|'select'|'place'|'route'|'check', message, ms}
 *     {type:'board', board, warnings, catalogVersion, timings}
 *     {type:'done', ms}
 *   or {type:'error', message, stage?} (in-stream), or a 4xx/5xx JSON body before streaming starts.
 *
 * The pipeline lives in src/ai/pipeline.ts and is loaded through Vite's SSR
 * module loader so it shares the app's TS + `@` alias; the Gemini key is only
 * read here and injected as a call function.
 */

// Shape of src/ai/pipeline.ts as seen from here (kept structural so the node
// tsconfig doesn't have to type-check the app sources).
type Stage = 'plan' | 'select' | 'place' | 'route' | 'check'
type GenEvent = { type: string; stage?: Stage; [k: string]: unknown }
type Llm = (o: { model: 'argon' | 'carbon'; system: string; prompt: string; schema: Record<string, unknown> }) => Promise<unknown>
interface PipelineModule {
  runPipeline(
    req: { prompt: string; constraints?: Record<string, unknown>; research?: ResearchContext },
    deps: { llm: Llm; emit: (e: GenEvent) => void; signal?: AbortSignal },
  ): Promise<{ board: unknown; warnings: string[]; catalogVersion: string; timings: Record<string, number> }>
  /** deterministic key-free planner (src/ai/offline.ts); one instance per generation */
  offlineLlm(): Llm
}

const PIPELINE = '/src/ai/pipeline.ts'
const MAX_CONCURRENT = 3

export function forgeAi(): Plugin {
  let env: Record<string, string | undefined> = process.env
  let root = process.cwd()
  let inFlight = 0

  const makeHandler = (load: () => Promise<PipelineModule>, log: (m: string) => void) =>
    async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        return sendJson(res, 405, { type: 'error', message: 'Use POST' })
      }
      let body: Record<string, unknown>
      try {
        body = (await readJson(req)) as Record<string, unknown>
      } catch (e) {
        return sendJson(res, 400, { type: 'error', message: (e as Error).message })
      }
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
      if (!prompt || prompt.length > 2000) return sendJson(res, 400, { type: 'error', message: 'prompt must be a non-empty string up to 2000 characters' })
      const constraints = body.constraints && typeof body.constraints === 'object' ? (body.constraints as Record<string, unknown>) : undefined
      // A key the user entered in the app wins over the server's own. It is used for this
      // request only and is never logged or stored.
      const sent = req.headers['x-gemini-key']
      const userKey = typeof sent === 'string' && /^[\w-]{20,200}$/.test(sent) ? sent : ''
      const apiKey = userKey || resolveApiKey(env)
      if (inFlight >= MAX_CONCURRENT) return sendJson(res, 429, { type: 'error', message: 'Too many generations in progress, try again shortly' })

      inFlight++
      const ac = new AbortController()
      res.on('close', () => {
        if (!res.writableEnded) ac.abort()
      })
      res.statusCode = 200
      res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
      res.setHeader('cache-control', 'no-cache, no-transform')
      res.setHeader('x-accel-buffering', 'no')
      res.flushHeaders?.()
      let lastStage: Stage | undefined
      const send = (e: GenEvent) => {
        if (e.stage) lastStage = e.stage
        if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(e)}\n`)
      }
      const started = Date.now()
      const usage: GeminiUsage[] = []
      try {
        const research = body.research === undefined ? undefined : await resolveResearchHandoff(
          body.research, env.FORGE_RESEARCH_URL ?? 'http://127.0.0.1:8000', ac.signal,
        )
        if (research && (prompt !== research.snapshot.brief.slice(0, 2000).trim() || constraints)) {
          throw new Error('Research handoff inputs changed. Start new research for the revised requirements.')
        }
        const generation = { prompt: research?.snapshot.brief ?? prompt, constraints, research }
        if (research) send({ type: 'stage', stage: 'plan', message: `Loaded saved research (${research.snapshot.kind}); PCB checks remain separate`, ms: Date.now() - started })
        const mod = await load()
        const offline = () => {
          send({ type: 'stage', stage: 'plan', message: 'Using the offline planner (deterministic, no AI model)', ms: Date.now() - started })
          return mod.runPipeline(generation, { signal: ac.signal, emit: send, llm: mod.offlineLlm() })
        }
        let result: Awaited<ReturnType<PipelineModule['runPipeline']>>
        let mode = 'gemini'
        if (!apiKey) {
          mode = 'offline (no GEMINI_API_KEY)'
          result = await offline()
          result.warnings = ['Generated by the offline planner. Enter a Gemini API key to have Gemini design the board.', ...result.warnings]
        } else {
          try {
            result = await mod.runPipeline(
              generation,
              {
                signal: ac.signal,
                emit: send,
                llm: (o) => callGemini(apiKey, { ...o, model: MODELS[o.model], signal: ac.signal }, (u) => usage.push(u)),
              },
            )
          } catch (e) {
            if (ac.signal.aborted) throw e
            // Research gates and exact-part failures must never trigger a substitute design.
            if (research) throw e
            const why = (e as Error).message || 'unknown error'
            log(`Gemini generation failed at ${lastStage ?? 'start'} (${why}); falling back to the offline planner`)
            mode = 'offline (Gemini failed)'
            result = await offline()
            result.warnings = [`Gemini generation failed (${why}); this board was built by the offline planner instead.`, ...result.warnings]
          }
        }
        send({ type: 'board', ...result, timings: { ...result.timings, llm: usage.reduce((a, u) => a + u.ms, 0) } })
        send({ type: 'done', ms: Date.now() - started })
        log(`generated board via ${mode} in ${Date.now() - started} ms (${usage.map((u) => `${u.model} ${u.ms}ms`).join(', ')})`)
      } catch (e) {
        const message = ac.signal.aborted ? 'aborted' : (e as Error).message || 'generation failed'
        send({ type: 'error', message, stage: lastStage })
        if (!ac.signal.aborted) log(`generation failed at ${lastStage ?? 'start'}: ${message}`)
      } finally {
        inFlight--
        res.end()
      }
    }

  return {
    name: 'forge-ai',
    configResolved(config) {
      root = config.root
      const parentEnv = loadEnv(config.mode, resolve(config.root, '..'), ['GEMINI_'])
      const localEnv = loadEnv(config.mode, config.envDir || config.root, ['GEMINI_'])
      env = { ...parentEnv, ...localEnv, ...process.env }
    },
    configureServer(server) {
      const log = (m: string) => server.config.logger.info(`[forge-ai] ${m}`, { timestamp: true })
      server.middlewares.use('/api/generate', makeHandler(() => server.ssrLoadModule(PIPELINE) as Promise<PipelineModule>, log))
      server.middlewares.use('/api/chassis', chassisHandler(() => env, log))
    },
    configurePreviewServer(server) {
      const log = (m: string) => server.config.logger.info(`[forge-ai] ${m}`, { timestamp: true })
      let mod: Promise<PipelineModule> | null = null
      const load = () =>
        (mod ??= runnerImport<PipelineModule>(join(root, 'server/pipeline-entry.ts'), {
          configFile: false,
          root,
          logLevel: 'error',
          resolve: { alias: { '@': join(root, 'src') } },
        }).then((r) => r.module))
      server.middlewares.use('/api/generate', makeHandler(load, log))
      server.middlewares.use('/api/chassis', chassisHandler(() => env, log))
    },
  }
}
