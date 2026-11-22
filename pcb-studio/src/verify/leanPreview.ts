// shortcut: local presentation rehearsal only, remove before production.
export function leanPreviewEnabled(dev: boolean, search: string): boolean {
  return dev && new URLSearchParams(search).get('leanPreview') === '1'
}

export type LeanMockState = { scope: string; phase: 'ready' | 'repairing' | 'fixed' | 'verifying'; fixed: number }
export function leanMockState(scope: string): LeanMockState {
  return { scope, phase: 'ready', fixed: 0 }
}

export function stepLeanMock(state: LeanMockState, scope: string, action: 'repair' | 'verify' | 'tick', count: number): LeanMockState {
  if (state.scope !== scope) return leanMockState(scope)
  if (action === 'repair') return { ...state, phase: 'repairing', fixed: 0 }
  if (action === 'verify') return { ...state, phase: 'verifying' }
  if (state.phase === 'verifying') return { ...state, phase: 'fixed', fixed: count }
  if (state.phase !== 'repairing') return state
  const fixed = Math.min(state.fixed + 1, count)
  return { ...state, fixed, phase: fixed === count ? 'fixed' : 'repairing' }
}
