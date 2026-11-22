// Real Chrome/CDP smoke; no browser dependency or paid inference.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const profile = await mkdtemp(join(tmpdir(), 'forge-voxel-browser-'))
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const children = [], pending = new Map(), errors = []
let socket, sequence = 0
const start = performance.now()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function send(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails))
  return response.result.value
}
async function wait(expression) {
  for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await sleep(200) }
  throw new Error(`Browser wait failed: ${expression}`)
}
try {
  if (process.argv.includes('--launch')) {
    children.push(spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], { cwd: 'pcb-studio', detached: true, stdio: 'ignore' }))
    children.push(spawn('uv', ['run', '--locked', '--python', '3.12', 'python', '-m', 'forge_research.studio'], { detached: true, stdio: 'ignore' }))
  }
  children.push(spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--enable-unsafe-swiftshader', '--remote-debugging-port=9339', `--user-data-dir=${profile}`, 'about:blank'], { detached: true, stdio: 'ignore' }))
  let targets
  for (let i = 0; i < 100; i++) { try { targets = await (await fetch('http://127.0.0.1:9339/json/list')).json(); break } catch { await sleep(200) } }
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data)
    if (data.id) { const job = pending.get(data.id); pending.delete(data.id); data.error ? job.reject(new Error(JSON.stringify(data.error))) : job.resolve(data.result) }
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails)
  })
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  const downloads = join(profile, 'downloads'); await mkdir(downloads)
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  await send('Page.navigate', { url: 'http://127.0.0.1:5173/voxel-demo/' })
  await wait(`!!document.getElementById('compare') && !!document.getElementById('prototype').contentDocument?.querySelector('canvas')`)
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('decision')).display !== 'none'`), true)
  await evaluate(`document.getElementById('motor').value='m2';document.getElementById('motor').dispatchEvent(new Event('change'));document.querySelector('[value="sentimental_value"]').click();document.getElementById('compare').click()`)
  await wait(`document.getElementById('decision-result').textContent.includes('Revision 0') && document.getElementById('renderer-state').textContent.includes('revision 0')`)
  await evaluate(`const option=[...document.querySelectorAll('#decision-result details')].find(d=>d.querySelector('summary').textContent.includes('jga25'));option.open=true;document.querySelector('#decision-result input[type=checkbox]').click();option.querySelector('button').click()`)
  await wait(`document.getElementById('decision-result').textContent.includes('Revision 1') && document.getElementById('renderer-state').textContent.includes('revision 1')`)
  assert.equal(await evaluate(`document.getElementById('decision-result').textContent.includes('jga25-370-12v')`), true)
  await wait(`document.getElementById('prototype').contentDocument.body.textContent.includes('JGA25')`)
  await evaluate(`document.getElementById('decision').scrollIntoView()`)
  const draftImage = await send('Page.captureScreenshot', { format: 'png' }); await writeFile('/tmp/forge-voxel-draft.png', Buffer.from(draftImage.data, 'base64'))
  await evaluate(`document.getElementById('undo').click()`)
  await wait(`document.getElementById('renderer-state').textContent.includes('revision 2')`)
  assert.equal(await evaluate(`!!document.querySelector('a[href="/?mode=engineer"]')`), true)
  await evaluate(`[...document.querySelectorAll('#decision-result button')].find(b=>b.textContent.includes('Download')).click()`)
  let plan
  for (let i = 0; i < 100; i++) { try { plan = JSON.parse(await readFile(join(downloads, 'forge-rover-plan-rev-2.json'), 'utf8')); break } catch { await sleep(100) } }
  assert.equal(plan.revision, 2); assert.equal(plan.selected_draft_part, 'tt-motor-148'); assert.equal(plan.physical_recommendation, null)
  await evaluate(`document.getElementById('decision').scrollIntoView()`)
  const image = await send('Page.captureScreenshot', { format: 'png' }); await writeFile('/tmp/forge-voxel-browser.png', Buffer.from(image.data, 'base64'))
  await send('Page.navigate', { url: 'http://127.0.0.1:5173/?mode=engineer' })
  await wait(`!!document.querySelector('canvas') && document.body.textContent.includes('Research') && document.body.textContent.includes('Export')`)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ browser: 'Chrome headless, real UI and renderer', elapsed_ms: performance.now() - start, revisions: [0, 1, 2], screenshot: '/tmp/forge-voxel-browser.png' }))
} finally {
  socket?.close()
  for (const child of children) { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
  await sleep(300); await rm(profile, { recursive: true, force: true })
}
