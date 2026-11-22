// runnerImport closes its module runner after evaluating the entry point.
// Resolve the lazy catalog before that happens, so later generations retain
// the same exact-part catalog used in development instead of a fallback list.
import { loadCatalog } from '../src/ai/catalog'

await loadCatalog()
export { runPipeline, offlineLlm } from '../src/ai/pipeline'
