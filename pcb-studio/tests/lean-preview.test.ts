import assert from 'node:assert/strict'
import { test } from 'node:test'
import { leanPreviewEnabled, leanMockState, stepLeanMock } from '../src/verify/leanPreview.ts'

test('preview requires dev AND explicit query opt-in; production always ignores it', () => {
  for (const dev of [false, true]) {
    for (const search of ['', '?leanPreview=0', '?leanPreview=true', '?leanPreview=1']) {
      assert.equal(leanPreviewEnabled(dev, search), dev && search === '?leanPreview=1')
    }
  }
})

test('bounded repair and repeat verify keep presentation state separate from real state', () => {
  const real = Object.freeze({ status: 'failed', theorems: Object.freeze([{ name: 'example', ok: false }]) })
  let mock = stepLeanMock(leanMockState('rev1:preview'), 'rev1:preview', 'repair', 2)
  mock = stepLeanMock(mock, mock.scope, 'tick', 2)
  assert.equal(mock.fixed, 1)
  mock = stepLeanMock(mock, mock.scope, 'tick', 2)
  assert.equal(mock.phase, 'fixed')
  for (let i = 0; i < 2; i++) {
    mock = stepLeanMock(mock, mock.scope, 'verify', 2)
    assert.equal(mock.phase, 'verifying')
    mock = stepLeanMock(mock, mock.scope, 'tick', 2)
    assert.equal(mock.fixed, 2)
  }
  assert.deepEqual(real, { status: 'failed', theorems: [{ name: 'example', ok: false }] })
})

test('revision or mode exit discards old presentation work', () => {
  const pending = stepLeanMock(leanMockState('rev1:preview'), 'rev1:preview', 'repair', 2)
  for (const scope of ['rev2:preview', 'rev1:real']) {
    assert.deepEqual(stepLeanMock(pending, scope, 'tick', 2), leanMockState(scope))
  }
})
