import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type * as Monaco from 'monaco-editor'

const labId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const courseId = '33333333-3333-4333-8333-333333333333'
const submissionId = '44444444-4444-4444-8444-444444444444'
const execution = { status: 'ok', results: [{ name: 'test_sum', passed: true, error: null }], score: 100, passed: 1, total: 1 }
const policy = { version: '2026-11-27', block_paste: true, block_drop: true, block_large_insert: true, large_insert_threshold: 80, flush_interval_ms: 1000, max_batch_items: 100, max_batch_bytes: 65536 }
const digest = (code: string) => createHash('sha256').update(code).digest('hex')
const accepted = (code: string) => ({ submission_id: submissionId, submitted_at: '2026-11-27T10:00:00.000Z', version: 1, code_sha256: digest(code), execution })
const integrity = { score: 100, penalty: 0, penalties: { paste: 0, large_insert: 0, focus: 0, fast_pass: 0 }, badge: 'green', flags: [], focus_losses: 0, telemetry_status: 'missing' }

async function setup(page: Page, role: 'student' | 'teacher' = 'student') {
  const user = { id: userId, email: `${role}@example.com`, full_name: 'Test Account', role }
  await page.addInitScript(({ user }) => {
    if (!localStorage.getItem('sb-test-auth-token')) localStorage.setItem('sb-test-auth-token', JSON.stringify({ access_token: 'test-token', refresh_token: 'test-refresh', expires_at: Math.floor(Date.now() / 1000) + 36000, expires_in: 36000, token_type: 'bearer', user }))
  }, { user })
  await page.route('https://test.supabase.co/**', route => route.fulfill({ json: { user } }))
  // Use the installed Monaco assets; tests do not depend on its public CDN.
  await page.route('https://cdn.jsdelivr.net/**', async route => {
    const url = new URL(route.request().url())
    const asset = url.pathname.split('/min/')[1]
    if (!asset || asset.includes('..')) return route.abort()
    const body = await readFile(`node_modules/monaco-editor/min/${asset}`)
    await route.fulfill({ body, contentType: asset.endsWith('.css') ? 'text/css' : asset.endsWith('.ttf') ? 'font/ttf' : 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } })
  })
  const events: Array<{ event_id: string; type: string }> = []
  const runs: string[] = []
  let max: number | null = 1
  let saved: ReturnType<typeof accepted> | null = null
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/me') return route.fulfill({ json: user })
    if (path === `/api/labs/${labId}` && request.method() === 'PATCH') { max = request.postDataJSON().max_submissions; return route.fulfill({ json: { id: labId, max_submissions: max, allow_resubmissions: max !== 1 } }) }
    if (path === `/api/labs/${labId}`) return route.fulfill({ json: { id: labId, title: 'Python addition', starter: 'x = 1', instructions: 'Write Python.', max_submissions: max, allow_resubmissions: max !== 1, integrity_policy: policy } })
    if (path.endsWith('/events')) { events.push(...request.postDataJSON()); return route.fulfill({ status: 204 }) }
    if (path.endsWith('/run')) { runs.push(request.postDataJSON().code); return route.fulfill({ json: execution }) }
    if (path.endsWith('/submission')) return route.fulfill({ json: { lab_id: labId, max_submissions: max, allow_resubmissions: max !== 1, accepted_submission_count: saved ? 1 : 0, remaining_submissions: max === null ? null : Math.max(0, max - (saved ? 1 : 0)), can_submit: max === null || !saved || max > 1, accepted_submission: saved } })
    if (path === `/api/courses/${courseId}/students/${userId}/report`) return route.fulfill({ json: { course_id: courseId, student: user, labs: [{ lab_id: labId, title: 'Python addition', max_submissions: 1, allow_resubmissions: false, accepted_submission_count: 1, remaining_submissions: 0, practice_attempt_count: 4, accepted_submission: accepted('x = 1'), integrity_scope: 'current_lab', integrity }] } })
    if (path === `/api/submissions/${submissionId}`) return route.fulfill({ json: { ...accepted('x = 1'), lab_id: labId, student_id: userId, code: 'x = 1' } })
    if (path === '/api/courses') return route.fulfill({ json: [] })
    return route.fulfill({ status: 404, json: { error: 'Unmocked route' } })
  })
  return { events, runs, accept: (code: string) => { saved = accepted(code) }, setLimit: (limit: number | null) => { max = limit } }
}
async function openLab(page: Page) {
  await page.goto(`/labs/${labId}`)
  await expect(page.getByRole('button', { name: 'Run code', exact: true })).toBeEnabled()
}
async function editorCode(page: Page) {
  return page.evaluate(() => (window as unknown as { monaco: typeof Monaco }).monaco.editor.getModels()[0].getValue())
}
async function insert(page: Page, value: string) {
  await page.evaluate(value => {
    const model = (window as unknown as { monaco: typeof Monaco }).monaco.editor.getModels()[0]
    model.applyEdits([{ range: { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 1 }, text: value }])
  }, value)
}

test('paste, drop and large inserts are blocked; accepted typing reaches Run with focus telemetry', async ({ page }) => {
  const state = await setup(page)
  await openLab(page)
  const editor = page.locator('.monaco-editor').first()
  await editor.dispatchEvent('paste', { clipboardData: undefined })
  await editor.dispatchEvent('drop')
  await editor.dispatchEvent('keydown', { key: 'v', ctrlKey: true })
  await editor.dispatchEvent('keydown', { key: 'v', metaKey: true })
  await editor.dispatchEvent('keydown', { key: 'Insert', shiftKey: true })
  expect(await editorCode(page)).toBe('x = 1')
  await insert(page, 'a'.repeat(81))
  expect(await editorCode(page)).toBe('x = 1')
  await insert(page, '#'.repeat(80))
  expect(await editorCode(page)).toBe('#'.repeat(80) + 'x = 1')
  await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
  await page.getByRole('button', { name: 'Run code', exact: true }).click()
  await expect.poll(() => state.runs.length).toBe(1)
  expect(state.runs[0]).toBe('#'.repeat(80) + 'x = 1')
  await expect.poll(() => state.events.filter(e => e.type === 'paste_blocked').length).toBe(2)
  expect(state.events.filter(e => e.type === 'large_insert')).toHaveLength(1)
  expect(state.events.filter(e => e.type === 'lab_opened')).toHaveLength(1)
  expect(state.events.some(e => e.type === 'window_blur')).toBe(true)
  expect(state.events.some(e => e.type === 'window_focus')).toBe(true)
})

test('uncertain submission recovers original payload after reload and policy lock', async ({ page }) => {
  const state = await setup(page)
  const requests: Array<{ key: string; code: string }> = []
  await page.route(`**/api/labs/${labId}/submit`, async route => {
    const code = route.request().postDataJSON().code
    requests.push({ key: route.request().headers()['idempotency-key'], code })
    state.accept(code)
    if (requests.length === 1) return route.abort('failed')
    return route.fulfill({ json: { accepted: true, submission_id: submissionId, submitted_at: '2026-11-27T10:00:00.000Z', execution } })
  })
  await openLab(page)
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await expect(page.getByText(/original code, key, and submission mode are saved/)).toBeVisible()
  await insert(page, '# changed\n')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Submitted', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Submission details', exact: true }).click()
  await expect(page.getByText('Your editor differs from the saved submission.')).toBeVisible()
  await page.getByRole('button', { name: 'Recover pending submission' }).click()
  await expect(page.getByRole('button', { name: 'Recover pending submission' })).toHaveCount(0)
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  expect(requests[0].code).toBe('x = 1')
  await expect(page.getByRole('button', { name: 'Run code', exact: true })).toBeEnabled()
})

test('failed attempts keep an earlier accepted version and each new action gets a new key', async ({ page }) => {
  const state = await setup(page); state.setLimit(3); state.accept('x = 1')
  const keys: string[] = []
  await page.route(`**/api/labs/${labId}/submit`, route => {
    keys.push(route.request().headers()['idempotency-key'])
    return route.fulfill({ json: { accepted: false, submission_id: null, submitted_at: null, execution: { ...execution, score: 0, passed: 0, results: [{ name: 'test_sum', passed: false, error: 'Test failed' }] } } })
  })
  await openLab(page)
  await page.getByRole('button', { name: 'Submit another version' }).click()
  await expect(page.getByText(/attempt was not saved/)).toBeVisible()
  await page.getByRole('button', { name: 'Submission details', exact: true }).click()
  await expect(page.getByText(/Saved version 1/)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Submit another version' })).toBeEnabled()
  await insert(page, '# edit\n')
  await page.getByRole('button', { name: 'Submit another version' }).click()
  await expect.poll(() => keys.length).toBe(2)
  expect(keys[0]).not.toBe(keys[1])
})

test('teacher can update policy and inspect exact submitted code with distinct integrity labels', async ({ page }) => {
  const state = await setup(page, 'teacher')
  await page.goto(`/labs/${labId}`)
  await expect(page.getByText('Lab management', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toHaveCount(0)
  await page.getByRole('combobox').selectOption('3')
  await page.getByRole('button', { name: 'Save limit' }).click()
  await expect(page.getByText(/Submission limit saved/)).toBeVisible()
  expect(state.events).toHaveLength(0)
  await page.goto(`/courses/${courseId}/students/${userId}/report`)
  await expect(page.getByText('Current lab integrity score: 100/100 · green')).toBeVisible()
  await expect(page.getByText(/Telemetry incomplete/)).toBeVisible()
  await page.getByRole('link', { name: 'View submitted code', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Read-only submitted Python code' })).toHaveValue('x = 1')
  await expect(page.getByRole('textbox', { name: 'Read-only submitted Python code' })).toHaveAttribute('readonly', '')
  await page.getByRole('link', { name: 'Back to student report' }).click()
  await expect(page).toHaveURL(`/courses/${courseId}/students/${userId}/report`)
})

test('processing responses retry the same saved key and source', async ({ page }) => {
  const state = await setup(page)
  const requests: Array<{ key: string; code: string }> = []
  await page.route(`**/api/labs/${labId}/submit`, route => {
    const code = route.request().postDataJSON().code
    requests.push({ key: route.request().headers()['idempotency-key'], code })
    if (requests.length === 1) return route.fulfill({ status: 409, headers: { 'Retry-After': '2' }, json: { error: 'Processing', code: 'SUBMISSION_PROCESSING' } })
    state.accept(code)
    return route.fulfill({ json: { accepted: true, submission_id: submissionId, submitted_at: '2026-11-27T10:00:00.000Z', execution } })
  })
  await openLab(page)
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await expect(page.getByText(/A submission is processing/)).toBeVisible()
  await insert(page, '# later\n')
  await expect(page.getByRole('button', { name: 'Submitted', exact: true })).toBeDisabled()
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
})

test('storage failure prevents a final request and displays a recovery warning', async ({ page }) => {
  await setup(page)
  let sent = false
  await page.route(`**/api/labs/${labId}/submit`, route => { sent = true; return route.abort() })
  await openLab(page)
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function(key, value) { if (key.startsWith('final-submission:')) throw new DOMException('Quota exceeded', 'QuotaExceededError'); original.call(this, key, value) }
  })
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await page.getByRole('button', { name: 'Review submission' }).click()
  await expect(page.getByText(/Nothing was sent/)).toBeVisible()
  expect(sent).toBe(false)
})

test('telemetry retry preserves event ids and does not duplicate the lab opening', async ({ page }) => {
  await setup(page)
  const batches: Array<Array<{ event_id: string; type: string }>> = []
  await page.route(`**/api/labs/${labId}/events`, route => {
    batches.push(route.request().postDataJSON())
    return batches.length === 1 ? route.fulfill({ status: 500, json: { error: 'Temporary failure' } }) : route.fulfill({ status: 204 })
  })
  await openLab(page)
  await expect(page.getByText(/Activity delivery pending/)).toBeVisible()
  await expect.poll(() => batches.length).toBeGreaterThanOrEqual(2)
  const opening = batches[0].find(e => e.type === 'lab_opened')!
  expect(batches[1].some(e => e.event_id === opening.event_id)).toBe(true)
  expect(batches[1].filter(e => e.type === 'lab_opened')).toHaveLength(1)
})

for (const limit of ['1', '2', '3', 'unlimited']) {
  test(`upload sends exactly one submission policy: ${limit}`, async ({ page }) => {
    await setup(page, 'teacher')
    let body = ''
    let contentType = ''
    await page.route('**/api/labs', route => {
      body = route.request().postData() || ''
      contentType = route.request().headers()['content-type']
      return route.fulfill({ status: 422, json: { errors: ['Upload inspected'] } })
    })
    await page.goto(`/courses/${courseId}/labs/new`)
    await page.getByRole('textbox', { name: 'Lab title' }).fill('Test lab')
    await page.getByRole('combobox').selectOption(limit)
    for (const field of ['instructions', 'starter', 'tests', 'solution']) await page.locator(`#${field}`).setInputFiles({ name: field === 'instructions' ? 'instructions.md' : `${field}.py`, mimeType: 'text/plain', buffer: Buffer.from('print(1)') })
    await page.getByRole('button', { name: 'Upload lab', exact: true }).click()
    await expect(page.getByText('Upload inspected')).toBeVisible()
    expect(contentType).toContain('multipart/form-data; boundary=')
    expect(body.match(/name="max_submissions"/g)).toHaveLength(1)
    expect(body).toContain(`name="max_submissions"\r\n\r\n${limit}\r\n`)
    expect(body).not.toContain('allow_resubmissions')
  })
}


test('submission details are tucked into a keyboard-accessible popover next to Run', async ({ page }) => {
  const state = await setup(page)
  state.setLimit(3)
  state.accept('x = 1')
  await openLab(page)
  await expect(page.getByText('Last saved submission')).toHaveCount(0)
  const run = await page.getByRole('button', { name: 'Run code', exact: true }).boundingBox()
  const submit = await page.getByRole('button', { name: 'Submit another version' }).boundingBox()
  expect(Math.abs(run!.y - submit!.y)).toBeLessThan(2)
  expect(submit!.x).toBeGreaterThan(run!.x)
  const trigger = page.getByRole('button', { name: 'Submission details', exact: true })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const popup = page.getByRole('dialog', { name: 'Submission details', exact: true })
  await expect(popup).toBeVisible()
  await expect(popup.getByText('Saved version 1')).toBeVisible()
  await expect(popup.locator('dl')).toContainText('Saved1Maximum3Remaining2')
  await expect(popup.getByText('Your editor matches the saved submission.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(popup).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('workspace dividers resize with pointer and keyboard without resetting code or telemetry', async ({ page }) => {
  const state = await setup(page)
  await openLab(page)
  await insert(page, '# keep this draft\n')
  const output = page.getByLabel('Execution results', { exact: true })
  const before = await output.boundingBox()
  const divider = page.getByRole('separator', { name: 'Resize code and output' })
  const handle = await divider.boundingBox()
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y - 90, { steps: 8 })
  await page.mouse.up()
  expect((await output.boundingBox())!.height).toBeGreaterThan(before!.height + 50)
  await divider.focus()
  const value = Number(await divider.getAttribute('aria-valuenow'))
  await page.keyboard.press('ArrowUp')
  expect(Number(await divider.getAttribute('aria-valuenow'))).toBeLessThan(value)
  await page.keyboard.press('Enter')
  await expect(divider).toHaveAttribute('aria-valuenow', '72')
  const horizontal = page.getByRole('separator', { name: 'Resize instructions and workspace' })
  await horizontal.focus()
  await page.keyboard.press('ArrowRight')
  await expect(horizontal).toHaveAttribute('aria-valuenow', '40')
  expect(await editorCode(page)).toBe('# keep this draft\nx = 1')
  await page.getByRole('button', { name: 'Run code', exact: true }).click()
  await expect.poll(() => state.runs.length).toBe(1)
  expect(state.runs[0]).toBe('# keep this draft\nx = 1')
  expect(state.events.filter(event => event.type === 'lab_opened')).toHaveLength(1)
  await page.screenshot({ path: 'test-results/workspace-desktop.png', fullPage: true })
})

test('mobile workspace keeps actions, details and vertical resizing usable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page)
  await openLab(page)
  await expect(page.getByRole('separator', { name: 'Resize instructions and workspace' })).toHaveCount(0)
  await expect(page.getByRole('separator', { name: 'Resize code and output' })).toBeVisible()
  await page.getByRole('button', { name: 'Submission details', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Submission details', exact: true })).toBeVisible()
  const box = await page.getByRole('dialog', { name: 'Submission details', exact: true }).boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: 'test-results/workspace-mobile.png', fullPage: true })
})

test('design review across courses, lab, login and both themes', async ({ page, context }) => {
  test.setTimeout(90_000)
  await setup(page)
  const courses = [
    { id: courseId, title: 'Python fundamentals', description: 'Build a strong foundation with variables, functions, and everyday problem solving.', created_at: '2026-11-01T00:00:00Z', lab_count: 8 },
    { id: 'data', title: 'Data structures', description: 'Work with lists, dictionaries, and sets to organize and transform data.', created_at: '2026-11-01T00:00:00Z', lab_count: 6 },
    { id: 'algorithms', title: 'Thinking in algorithms', description: 'Break down problems, compare approaches, and write efficient Python.', created_at: '2026-11-01T00:00:00Z', lab_count: 5 },
  ]
  await page.route('**/api/courses', route => route.fulfill({ json: courses }))
  await page.route(`**/api/courses/${courseId}`, route => route.fulfill({ json: { ...courses[0], teacher_id: 'teacher', labs: [{ id: labId, title: 'Functions and return values' }, { id: 'conditions', title: 'Making decisions with conditions' }, { id: 'loops', title: 'Working with loops' }] } }))
  await page.route(`**/api/labs/${labId}`, route => route.fulfill({ json: { id: labId, title: 'Functions and return values', starter: 'def add(a, b):\n    # Return the sum of two numbers\n    pass\n', instructions: '## Your task\nWrite a function called `add` that takes two numbers and returns their sum.\n\n### Example\n```python\nadd(3, 5)\n# Returns 8\n```\n\n### What to check\n- Your function accepts two arguments\n- It works with negative numbers\n- It returns a value rather than printing it\n\nRun your code to check the tests. When you are ready, submit your final version.', max_submissions: 3, allow_resubmissions: true, integrity_policy: policy } }))
  const phase = process.env.DESIGN_REVIEW_PHASE || 'after'
  for (const theme of ['light', 'dark']) {
    await page.goto('/courses')
    await page.evaluate(theme => { localStorage.setItem('seekhein:theme', theme) }, theme)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'My courses', exact: true })).toBeVisible()
    await expect(page.getByText('Python fundamentals', { exact: true })).toBeVisible()
    await page.screenshot({ path: `test-results/${phase}-courses-${theme}.png`, fullPage: true })
    await page.getByRole('link').filter({ hasText: 'Python fundamentals' }).click()
    await expect(page.getByRole('heading', { name: 'Course labs', exact: true })).toBeVisible()
    await page.screenshot({ path: `test-results/${phase}-course-${theme}.png`, fullPage: true })
    await page.goto(`/labs/${labId}`)
    await expect(page.getByRole('button', { name: 'Run code', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Run code', exact: true }).click()
    await expect(page.getByText('All tests passed', { exact: true })).toBeVisible()
    await page.screenshot({ path: `test-results/${phase}-lab-${theme}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/courses')
  await expect(page.getByText('Python fundamentals', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: `test-results/${phase}-courses-mobile.png`, fullPage: true })
  const login = await context.newPage()
  await login.addInitScript(() => { localStorage.removeItem('sb-test-auth-token') })
  await login.goto('/login')
  await expect(login.getByRole('button', { name: /Login|Sign in/, exact: true })).toBeVisible()
  await login.screenshot({ path: `test-results/${phase}-login.png`, fullPage: true })
  await login.setViewportSize({ width: 390, height: 844 })
  await expect(login.getByRole('button', { name: 'Sign in', exact: true })).toBeInViewport()
  expect(await login.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await login.screenshot({ path: `test-results/${phase}-login-mobile.png`, fullPage: true })
  await login.close()
})


test('light and dark themes keep readable text, visible controls, and the same editor draft', async ({ page }) => {
  const state = await setup(page)
  await openLab(page)
  await insert(page, '# keep my work\n')
  function luminance(hex: string) {
    const rgb = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    const linear = rgb.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
  }
  const pairs = [
    ['foreground', 'background', 4.5], ['foreground', 'card', 4.5],
    ['muted-foreground', 'card', 4.5], ['muted-foreground', 'muted', 4.5],
    ['muted-foreground', 'popover', 4.5], ['muted-foreground', 'sidebar', 4.5],
    ['primary-foreground', 'primary', 4.5], ['primary', 'card', 4.5],
    ['sidebar-accent-foreground', 'sidebar-accent', 4.5],
    ['success', 'success-surface', 4.5], ['warning', 'warning-surface', 4.5],
    ['input', 'card', 3], ['ring', 'card', 3],
  ] as const
  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: `Switch to ${theme} mode` }).click()
    const tokens = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement)
      return Object.fromEntries(['foreground', 'background', 'card', 'muted-foreground', 'muted', 'popover', 'sidebar', 'primary-foreground', 'primary', 'sidebar-accent-foreground', 'sidebar-accent', 'success', 'success-surface', 'warning', 'warning-surface', 'input', 'ring'].map(key => [key, css.getPropertyValue(`--${key}`).trim()]))
    })
    for (const [foreground, background, minimum] of pairs) {
      const values = [luminance(tokens[foreground]), luminance(tokens[background])].sort((a, b) => a - b)
      expect((values[1] + 0.05) / (values[0] + 0.05), `${theme}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(minimum)
    }
    expect(await editorCode(page)).toBe('# keep my work\nx = 1')
    await expect(page.locator('.monaco-editor').first()).toHaveCSS('background-color', theme === 'dark' ? 'rgb(27, 33, 42)' : 'rgb(255, 255, 255)')
    await expect(page.getByText('Draft saved on this device')).toBeVisible()
  }
  await page.getByRole('button', { name: 'Run code', exact: true }).click()
  await expect.poll(() => state.runs.length).toBe(1)
  expect(state.runs[0]).toBe('# keep my work\nx = 1')
  expect(state.events.filter(event => event.type === 'lab_opened')).toHaveLength(1)
})

test('editor warnings use one dismissible toast without moving the workspace', async ({ page }) => {
  await setup(page)
  await openLab(page)
  const editor = page.locator('.monaco-editor').first()
  const before = await editor.boundingBox()
  await editor.click({ position: { x: 150, y: 30 } })
  for (let i = 0; i < 3; i++) await editor.dispatchEvent('paste')
  const toast = page.getByRole('dialog', { name: 'Editor action blocked', exact: true })
  await expect(toast).toHaveCount(1)
  await expect(toast).toBeVisible()
  expect(await editorCode(page)).toBe('x = 1')
  const after = await editor.boundingBox()
  expect(after!.y).toBe(before!.y)
  expect(after!.height).toBe(before!.height)
  expect(await page.evaluate(() => !!document.activeElement?.closest('.monaco-editor'))).toBe(true)
  await toast.hover()
  await page.screenshot({ path: 'test-results/notification-warning-light.png', fullPage: true })
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await expect(toast).toBeVisible()
  await toast.hover()
  await page.screenshot({ path: 'test-results/notification-warning-dark.png', fullPage: true })
  await toast.getByRole('button', { name: 'Dismiss notification' }).click()
  await expect(toast).toHaveCount(0)
  await editor.dispatchEvent('paste')
  await expect(toast).toBeVisible()
  await page.getByRole('link', { name: 'All courses', exact: true }).click()
  await expect(toast).toHaveCount(0)
})

test('notifications pause on hover, expire after leaving, and fit mobile screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page)
  await openLab(page)
  await page.clock.install()
  await page.locator('.monaco-editor').first().dispatchEvent('paste')
  const toast = page.getByRole('dialog', { name: 'Editor action blocked', exact: true })
  await expect(toast).toBeVisible()
  const box = await toast.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  await toast.hover()
  await page.clock.fastForward(9000)
  await expect(toast).toBeVisible()
  await page.mouse.move(0, 0)
  await page.clock.fastForward(9000)
  await expect(toast).toHaveCount(0)
})

test('run errors stay inline with a retry action and clear after a successful retry', async ({ page }) => {
  await setup(page)
  let attempts = 0
  await page.route(`**/api/labs/${labId}/run`, route => {
    attempts++
    return attempts === 1 ? route.fulfill({ status: 503, json: { error: 'The execution service is temporarily unavailable.' } }) : route.fulfill({ json: execution })
  })
  await openLab(page)
  await page.getByRole('button', { name: 'Run code', exact: true }).click()
  const notice = page.getByRole('alert', { name: 'Code could not be run', exact: true })
  await expect(notice).toBeVisible()
  await expect(notice.getByText('The execution service is temporarily unavailable.')).toBeVisible()
  await expect(notice.getByRole('button', { name: 'Dismiss notification' })).toHaveCount(0)
  await page.screenshot({ path: 'test-results/notification-error-inline.png', fullPage: true })
  await notice.getByRole('button', { name: 'Retry run' }).click()
  await expect(notice).toHaveCount(0)
  await expect(page.getByText('All tests passed', { exact: true })).toBeVisible()
})

test('detailed console and tests render escaped streams, tracebacks, syntax errors and clear output', async ({ page }) => {
  await setup(page)
  const full = { ...execution, score: 0, passed: 0, results: [{ name: 'Test 1', passed: false, error: 'Test failed' }], ran: 1, failed: 1, stdout: '<script>window.outputInjected=true</script>\nsetup\0output', stdout_truncated: true, duration_ms: 12, tests: [{ index: 0, name: 'test_add', display_name: 'Adds two numbers', status: 'failed', passed: false, duration_ms: 10, inputs: '1, 2', expected: '3', actual: '0', error_type: 'ValueError', error_message: 'bad number', traceback: [{ line: 3, function: 'add', code: 'raise ValueError("bad number")' }], stdout: 'inside test\n', stdout_truncated: true }] }
  await page.route('**/api/labs/*/run', route => route.fulfill({ json: full }))
  await openLab(page)
  await page.getByRole('button', { name: 'Run code', exact: true }).click()
  const consolePanel = page.getByRole('tabpanel', { name: 'Console', exact: true })
  await expect(consolePanel).toContainText('<script>window.outputInjected=true</script>')
  await expect(consolePanel).toContainText('inside test')
  await expect(consolePanel).toContainText('Line 3, in add')
  await expect(consolePanel.getByText('Output truncated by the runner.')).toHaveCount(2)
  expect(await page.evaluate(() => 'outputInjected' in window)).toBe(false)
  await page.getByRole('tab', { name: 'Tests', exact: true }).click()
  await expect(page.getByRole('tabpanel', { name: 'Tests', exact: true })).toContainText('Expected')
  await expect(page.getByRole('tabpanel', { name: 'Tests', exact: true }).locator('details')).toHaveAttribute('open', '')
  await page.getByRole('button', { name: 'Clear output' }).click()
  await expect(page.getByText('Run your code to see test outcomes.')).toBeVisible()
  await page.route('**/api/labs/*/run', route => route.fulfill({ json: { ...full, status: 'syntax_error', total: 0, ran: 0, failed: 0, results: [], tests: [], stdout: '', stdout_truncated: false, syntax_error: { error_type: 'SyntaxError', line: 7, code_line: 'if broken', error_message: 'expected colon' } } }))
  await page.getByRole('button', { name: 'Run code', exact: true }).click()
  await page.getByRole('tab', { name: 'Console', exact: true }).click()
  await expect(consolePanel).toContainText('Syntax error · line 7')
  await expect(consolePanel).toContainText('if broken\nSyntaxError: expected colon')
})

test('submitted code viewer shows stored detailed output and falls back for old records', async ({ page }) => {
  await setup(page, 'teacher')
  await page.goto(`/submissions/${submissionId}`)
  await expect(page.getByText('Detailed output isn’t available for this submission.')).toBeVisible()
  await expect(page.getByText('test_sum', { exact: true })).toBeVisible()
  await page.route(`**/api/submissions/${submissionId}`, route => route.fulfill({ json: { ...accepted('x = 1'), lab_id: labId, student_id: userId, code: 'x = 1', execution: { ...execution, ran: 1, failed: 0, duration_ms: 2, stdout: 'stored setup output', stdout_truncated: false, tests: [{ index: 0, name: 'sum', display_name: 'Sum example', status: 'passed', passed: true, duration_ms: 1, stdout: 'stored test output' }] } } }))
  await page.reload()
  await expect(page.getByRole('tabpanel', { name: 'Console', exact: true })).toContainText('stored setup output')
  await expect(page.getByRole('tabpanel', { name: 'Console', exact: true })).toContainText('stored test output')
})

test('failed final submission displays full diagnostics without accepting it', async ({ page }) => {
  await setup(page)
  await page.route('**/api/labs/*/submit', route => route.fulfill({ json: { accepted: false, submission_id: null, submitted_at: null, execution: { ...execution, status: 'runtime_error', score: 0, passed: 0, total: 0, results: [], ran: 0, failed: 0, duration_ms: 4, stdout: 'import started', stdout_truncated: false, tests: [] } } }))
  await openLab(page)
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await expect(page.getByRole('tabpanel', { name: 'Console', exact: true })).toContainText('import started')
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled()
})

test('lab works without secure-context crypto APIs on a network HTTP address', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const state = await setup(page)
  await page.addInitScript(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined })
    Object.defineProperty(crypto, 'subtle', { value: undefined })
  })
  await page.route('**/api/labs/*/submit', route => {
    expect(route.request().headers()['idempotency-key']).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    state.accept(route.request().postDataJSON().code)
    return route.fulfill({ json: { accepted: true, submission_id: submissionId, submitted_at: '2026-11-27T10:00:00.000Z', execution } })
  })
  await openLab(page)
  await expect.poll(() => state.events.some(event => event.type === 'lab_opened')).toBe(true)
  await page.getByRole('button', { name: 'Run code', exact: true }).click()
  await expect(page.getByText('All tests passed', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Submitted', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Submission details' }).click()
  await expect(page.getByText('Unable to compare editor content in this browser.')).toBeVisible()
  expect(errors).toEqual([])
})

test('internal copy and cut allow long pastes without allowing external or later bulk insertions', async ({ page }) => {
  const state = await setup(page)
  await openLab(page)
  await insert(page, '#'.repeat(70) + '\n')
  await insert(page, '#'.repeat(70) + '\n')
  const original = await editorCode(page)
  async function clipboard(action: 'copy' | 'cut' | 'paste', text = '') {
    return page.evaluate(({ action, text }) => {
      const monaco = (window as unknown as { monaco: typeof Monaco }).monaco
      const editor = monaco.editor.getEditors()[0]
      const model = editor.getModel()!
      const range = model.getFullModelRange()
      if (action !== 'paste') editor.setSelection(range)
      else editor.setPosition({ lineNumber: range.endLineNumber, column: range.endColumn })
      const data = new DataTransfer()
      if (action === 'paste') data.setData('text/plain', text)
      document.querySelector('.monaco-editor')!.dispatchEvent(new ClipboardEvent(action, { bubbles: true, cancelable: true, clipboardData: data }))
      return data.getData('text/plain')
    }, { action, text })
  }
  const copied = await clipboard('copy')
  expect(copied).toBe(original)
  await clipboard('paste', copied)
  expect(await editorCode(page)).toBe(original + original)
  const cut = await clipboard('cut')
  expect(await editorCode(page)).toBe('')
  await clipboard('paste', cut)
  expect(await editorCode(page)).toBe(cut)
  await clipboard('paste', 'external text')
  expect(await editorCode(page)).toBe(cut)
  await insert(page, 'x'.repeat(81))
  expect(await editorCode(page)).toBe(cut)
  await page.getByRole('button', { name: 'Run code', exact: true }).click()
  await expect.poll(() => state.runs.length).toBe(1)
  expect(state.runs[0]).toBe(cut)
  await expect.poll(() => state.events.filter(event => event.type === 'paste_blocked').length).toBe(1)
  expect(state.events.filter(event => event.type === 'large_insert')).toHaveLength(1)
  // Copying elsewhere invalidates the editor's remembered clipboard value.
  await page.locator('body').dispatchEvent('copy')
  await clipboard('paste', cut)
  expect(await editorCode(page)).toBe(cut)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Run code', exact: true })).toBeEnabled()
  await clipboard('paste', cut)
  expect(await editorCode(page)).toBe(cut)
})

test('course students drawer supports search, single enrollment, CSV preview and partial retries', async ({ page }) => {
  await setup(page, 'teacher')
  const students = [{ id: userId, email: 'jane@example.com', full_name: 'Jane Student', enrolled_at: '2026-11-01T00:00:00Z' }]
  const requests: string[] = []
  let fail = true
  await page.route(`**/api/courses/${courseId}`, route => route.fulfill({ json: { id: courseId, title: 'Python fundamentals', description: 'Functions, loops, and everyday problem solving.', teacher_id: userId, created_at: '2026-11-01T00:00:00Z', labs: [{ id: labId, title: 'Functions and return values' }] } }))
  await page.route(`**/api/courses/${courseId}/students`, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: students })
    const email = route.request().postDataJSON().email
    requests.push(email)
    if (email === 'retry@example.com' && fail) return route.fulfill({ status: 404, json: { error: 'Student account not found.' } })
    students.push({ id: email, email, full_name: '', enrolled_at: '2026-11-28T00:00:00Z' })
    return route.fulfill({ json: { course_id: courseId, student_id: email, enrolled_at: '2026-11-28T00:00:00Z' } })
  })
  await page.goto(`/courses/${courseId}`)
  await expect(page.getByRole('heading', { name: 'Course labs', exact: true })).toBeVisible()
  await expect(page.getByLabel('Student email', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: 'test-results/course-layout.png', fullPage: true })
  await page.getByRole('button', { name: /^Students/ }).click()
  const drawer = page.getByRole('dialog', { name: 'Course students', exact: true })
  await expect(drawer.getByRole('link', { name: /Jane Student/ })).toBeVisible()
  await drawer.getByRole('searchbox').fill('nobody')
  await expect(drawer.getByText('No students match your search.')).toBeVisible()
  await drawer.getByRole('tab', { name: 'Add students' }).click()
  await drawer.getByLabel('Student email', { exact: true }).fill('single@example.com')
  await drawer.getByRole('button', { name: 'Add student', exact: true }).click()
  await expect(drawer.getByText('single@example.com is enrolled.')).toBeVisible()
  await drawer.getByLabel('Student CSV file').setInputFiles({ name: 'invalid.csv', mimeType: 'text/csv', buffer: Buffer.from('email\nbad\n') })
  await expect(drawer.getByText('Fix the CSV before importing')).toBeVisible()
  expect(requests).toEqual(['single@example.com'])
  await drawer.getByLabel('Student CSV file').setInputFiles({ name: 'class.csv', mimeType: 'text/csv', buffer: Buffer.from('email\nnew@example.com\nretry@example.com\nNEW@example.com\n') })
  await expect(drawer.getByLabel('CSV preview')).toContainText('new@example.com')
  expect(requests).toHaveLength(1)
  await drawer.getByRole('button', { name: 'Enroll 2 students' }).click()
  await expect(drawer.getByText('1 of 2 enrollments confirmed.')).toBeVisible()
  await expect(drawer.getByText('Student account not found.')).toBeVisible()
  fail = false
  await drawer.getByRole('button', { name: 'Retry remaining students' }).click()
  await expect(drawer.getByText('2 of 2 enrollments confirmed.')).toBeVisible()
  expect(requests).toEqual(['single@example.com', 'new@example.com', 'retry@example.com', 'retry@example.com'])
  await page.screenshot({ path: 'test-results/course-students-import.png', fullPage: true })
  await drawer.getByRole('tab', { name: 'Enrolled students' }).click()
  await drawer.getByRole('searchbox').fill('')
  await expect(drawer.getByText('4 enrolled', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Students/ })).toBeFocused()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: /^Students/ }).click()
  await expect(drawer).toBeVisible()
  const box = await drawer.boundingBox()
  expect(Math.round(box!.width)).toBeLessThanOrEqual(390)
  expect(box!.x).toBeGreaterThanOrEqual(0)
  await expect.poll(async () => Math.round((await drawer.boundingBox())!.x)).toBe(0)
  await page.screenshot({ path: 'test-results/course-students-mobile.png', fullPage: true })
  await page.keyboard.press('Escape')
  await page.evaluate(() => localStorage.setItem('seekhein:theme', 'dark'))
  await page.reload()
  await page.getByRole('button', { name: /^Students/ }).click()
  await expect(drawer.getByText('4 enrolled', { exact: true })).toBeVisible()
  await expect.poll(async () => Math.round((await drawer.boundingBox())!.x)).toBe(0)
  await page.screenshot({ path: 'test-results/course-students-dark.png', fullPage: true })
})

test('teacher lab report accepts top-level policy and shows student history and integrity', async ({ page }) => {
  await setup(page, 'teacher')
  await page.route(`**/api/labs/${labId}/report`, route => route.fulfill({ json: {
    lab_id: labId, title: 'Python addition', max_submissions: 2, allow_resubmissions: true,
    students: [{ student_id: userId, email: 'student@example.com', full_name: 'Jane Student', enrolled: true, first_pass_at: '2026-11-27T10:00:00Z', practice_attempt_count: 1, accepted_submission_count: 1, remaining_submissions: 1, accepted_submission: accepted('x = 1'), integrity_scope: 'current_lab', integrity,
      events: [{ event_id: 'event', session_id: 'session', type: 'lab_opened', payload: {}, client_ts: null, received_at: '2026-11-27T09:00:00Z' }],
      submissions: [{ id: 'practice', status: 'ok', score: 100, passed: 1, total: 1, created_at: '2026-11-27T09:30:00Z', kind: 'practice', version: null, code_sha256: null }, { id: submissionId, status: 'ok', score: 100, passed: 1, total: 1, created_at: '2026-11-27T10:00:00Z', kind: 'final', version: 1, code_sha256: digest('x = 1') }] }],
  } }))
  await page.goto(`/labs/${labId}`)
  await page.getByRole('link', { name: 'Submissions & reports', exact: true }).click()
  await page.getByRole('button', { name: 'Review Jane Student', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Jane Student' })).toBeVisible()
  await expect(page.getByText('Maximum submissions: 2')).toBeAttached()
  await expect(page.getByText('Current lab integrity score: 100/100 · green')).toBeVisible()
  await page.getByRole('tab', { name: 'Submissions', exact: true }).click()
  await expect(page.getByText(/Practice · Test score/)).toBeVisible()
  const historyUrl = page.url()
  await page.getByRole('tabpanel', { name: 'Submissions', exact: true }).getByRole('link', { name: 'View submitted code', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Read-only submitted Python code' })).toHaveValue('x = 1')
  await page.goBack()
  await expect(page).toHaveURL(historyUrl)
  await expect(page.getByRole('tab', { name: 'Submissions', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Activity', exact: true }).click()
  await expect(page.getByText(/lab opened/)).toBeVisible()
  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  await page.getByRole('link', { name: 'View submitted code', exact: true }).first().click()
  await expect(page.getByRole('textbox', { name: 'Read-only submitted Python code' })).toHaveValue('x = 1')
})

test('large lab report uses search, filters and pagination with a compact student drawer', async ({ page }) => {
  await setup(page, 'teacher')
  const students = Array.from({ length: 100 }, (_, index) => ({
    student_id: `student-${index}`, email: `student${index + 1}@example.com`, full_name: `Student ${String(index + 1).padStart(3, '0')}`, enrolled: true, first_pass_at: null,
    practice_attempt_count: 20, accepted_submission_count: index % 2, remaining_submissions: 2 - index % 2, accepted_submission: index % 2 ? accepted('x = 1') : null, integrity_scope: 'current_lab', integrity,
    events: Array.from({ length: 25 }, (_, i) => ({ event_id: `event-${i}`, session_id: 'session', type: 'run', payload: {}, client_ts: null, received_at: `2026-11-27T10:${String(i).padStart(2, '0')}:00Z` })),
    submissions: Array.from({ length: 20 }, (_, i) => ({ id: `practice-${i}`, status: 'ok', score: 100, passed: 1, total: 1, created_at: '2026-11-27T10:00:00Z', kind: 'practice', version: null, code_sha256: null })),
  }))
  await page.route(`**/api/labs/${labId}/report`, route => route.fulfill({ json: { lab_id: labId, title: 'Python addition', max_submissions: 2, allow_resubmissions: true, students } }))
  await page.goto(`/labs/${labId}/report`)
  const list = page.getByRole('region', { name: 'Student report list' })
  await expect(list.getByRole('button', { name: /^Review / })).toHaveCount(10)
  await expect(page.getByText('1–10 of 100 students')).toBeVisible()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(list.getByText('Student 011', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('pending')
  await expect(page.getByText('1–10 of 50 students')).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search students' }).fill('no match')
  await expect(page.getByText('No students match these filters.')).toBeVisible()
  await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('all')
  await page.getByRole('searchbox', { name: 'Search students' }).fill('Student 100')
  await expect(list.getByRole('button', { name: /^Review / })).toHaveCount(1)
  await page.getByRole('button', { name: 'Review Student 100' }).click()
  const drawer = page.getByRole('dialog', { name: 'Student 100', exact: true })
  await expect(drawer.getByText('Saved version 1', { exact: false })).toBeVisible()
  const reportUrl = page.url()
  await drawer.getByRole('link', { name: 'View submitted code', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Read-only submitted Python code' })).toHaveValue('x = 1')
  await page.reload()
  await page.getByRole('link', { name: 'Back to lab report' }).click()
  await expect(page).toHaveURL(reportUrl)
  await expect(drawer).toBeVisible()
  await expect(page.locator('input[type=search]')).toHaveValue('Student 100')
  await drawer.getByRole('tab', { name: 'Activity', exact: true }).click()
  await expect(drawer.getByText('Page 1 of 3')).toBeVisible()
  await expect(drawer.getByRole('listitem')).toHaveCount(10)
  await drawer.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(drawer.getByText('Page 2 of 3')).toBeVisible()
  await drawer.getByRole('tab', { name: 'Submissions', exact: true }).click()
  await expect(drawer.getByText('Page 1 of 2')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Review Student 100' })).toBeFocused()
  await page.getByRole('searchbox', { name: 'Search students' }).fill('')
  await page.screenshot({ path: 'test-results/lab-report-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Review Student 001' }).click()
  const mobile = page.getByRole('dialog', { name: 'Student 001', exact: true })
  await expect.poll(async () => Math.round((await mobile.boundingBox())!.x)).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: 'test-results/lab-report-mobile-drawer.png', fullPage: true })
})

test('teachers open lab management and only run an unrestricted preview with no student events', async ({ page }) => {
  const state = await setup(page, 'teacher')
  const studentRequests: string[] = []
  page.on('request', request => {
    if (/\/api\/labs\/[^/]+\/(events|submission|submit)(?:\?|$)/.test(request.url())) studentRequests.push(request.url())
  })
  await page.goto(`/courses/${courseId}/labs/${labId}`)
  await expect(page.getByText('Lab management', { exact: true })).toBeVisible()
  await expect(page.locator('#main-content').getByRole('link', { name: 'Back to course', exact: true })).toHaveAttribute('href', `/courses/${courseId}`)
  await expect(page.locator('.monaco-editor')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Run code', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Submissions & reports', exact: true })).toHaveAttribute('href', `/labs/${labId}/report`)
  await page.screenshot({ path: 'test-results/teacher-lab-management.png', fullPage: true })
  await page.getByRole('link', { name: 'Preview & test', exact: true }).click()
  await expect(page.getByText('Teacher preview', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Run code', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Lab rules', exact: true })).toHaveCount(0)
  await insert(page, '#'.repeat(100) + '\n')
  await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
  await page.getByRole('button', { name: 'Run code', exact: true }).click()
  await expect(page.getByText('All tests passed', { exact: true })).toBeVisible()
  expect(state.runs).toEqual(['#'.repeat(100) + '\nx = 1'])
  await page.getByRole('link', { name: 'Back to lab management', exact: true }).click()
  await expect(page.getByText('Lab management', { exact: true })).toBeVisible()
  await page.getByText('Starter code', { exact: true }).click()
  await expect(page.getByLabel('Read-only starter code')).toHaveText('x = 1')
  expect(studentRequests).toEqual([])
  expect(state.events).toEqual([])
})

test('submit anyway preserves original mode and code through uncertain delivery and a locked reload', async ({ page }) => {
  await setup(page)
  const failure = { status: 'syntax_error', score: 0, passed: 0, total: 0, results: [] }
  let saved = false
  const requests: Array<{ key: string; code: string; submit_anyway: boolean }> = []
  const final = { ...accepted('x = 1'), submit_anyway: true, submission_status: 'pending_review', execution: failure }
  await page.route('**/api/labs/*/run', route => route.fulfill({ json: failure }))
  await page.route('**/api/labs/*/submission', route => route.fulfill({ json: { lab_id: labId, allow_resubmissions: false, max_submissions: 1, accepted_submission_count: saved ? 1 : 0, remaining_submissions: saved ? 0 : 1, can_submit: !saved, accepted_submission: saved ? final : null } }))
  await page.route('**/api/labs/*/submit', route => {
    const body = route.request().postDataJSON()
    requests.push({ key: route.request().headers()['idempotency-key'], ...body })
    saved = true
    if (requests.length === 1) return route.abort()
    return route.fulfill({ json: { accepted: true, submission_id: submissionId, submitted_at: final.submitted_at, submit_anyway: true, submission_status: 'pending_review', execution: failure } })
  })
  await openLab(page)
  await page.getByRole('button', { name: 'Run code', exact: true }).click()
  await page.getByRole('button', { name: 'Submit anyway…', exact: true }).click()
  await expect(page.getByText(/This is your last slot/)).toBeVisible()
  await page.getByRole('button', { name: 'Submit anyway', exact: true }).click()
  await expect(page.getByText('Submission needs recovery', { exact: true })).toBeVisible()
  await insert(page, '# edited\n')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Submitted', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Submission details', exact: true }).click()
  await expect(page.getByText('Pending teacher review', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Submit anyway', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Recover pending submission', exact: true }).click()
  await expect(page.getByText('Submitted — pending teacher review', { exact: true })).toBeVisible()
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  expect(requests[0].submit_anyway).toBe(true)
  expect(requests[0].code).toBe('x = 1')
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('final-submission:')))).toEqual([])
})

test('teacher reports label saved failing work pending review and show its exact output', async ({ page }) => {
  await setup(page, 'teacher')
  const final = { ...accepted('x = 1'), submit_anyway: true, submission_status: 'pending_review', execution: { ...execution, score: 0, passed: 0, results: [{ name: 'Test 1', passed: false, error: 'Test failed' }] } }
  await page.route(`**/api/courses/${courseId}/students/${userId}/report`, route => route.fulfill({ json: { course_id: courseId, student: { id: userId, email: 'student@example.com', full_name: null }, labs: [{ lab_id: labId, title: 'Python addition', max_submissions: 1, allow_resubmissions: false, accepted_submission_count: 1, remaining_submissions: 0, practice_attempt_count: 0, accepted_submission: final, integrity_scope: 'current_lab', integrity }] } }))
  await page.route(`**/api/submissions/${submissionId}`, route => route.fulfill({ json: { ...final, lab_id: labId, student_id: userId, code: 'x = 1' } }))
  await page.goto(`/courses/${courseId}/students/${userId}/report`)
  await expect(page.getByText('Pending teacher review', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'View submitted code', exact: true }).click()
  await expect(page.getByText('Pending teacher review', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Read-only submitted Python code' })).toHaveValue('x = 1')
  await expect(page.getByText('Test failed', { exact: true })).toBeVisible()
})

test('upload validates file limits, preserves files for diagnostics and service retry, and shows saved warnings', async ({ page }) => {
  await setup(page, 'teacher')
  let calls = 0
  await page.route('**/api/labs', route => {
    calls++
    if (calls === 1) return route.fulfill({ status: 422, json: { code: 'LAB_VALIDATION_FAILED', error: 'Reference syntax error', validation: { valid: false, summary: 'Fix the tests file', status: 'syntax_error', duration_ms: 1, total_tests: 0, ran_tests: 0, passed_tests: 0, failed_tests: 0, tests: [], warnings: [], syntax_error: { source: 'tests', error_type: 'SyntaxError', line: 3, code_line: '<script>window.injected=true</script>', error_message: 'invalid syntax' } } } })
    if (calls === 2) return route.fulfill({ status: 503, json: { code: 'LAB_VALIDATION_SERVICE_ERROR', error: 'Validation runner unavailable' } })
    if (calls === 3) return route.abort()
    return route.fulfill({ status: 201, json: { id: labId, validated_at: '2026-11-28T10:00:00Z', validation: { valid: true, status: 'ok', total_tests: 2, passed_tests: 2, warnings: ['One test is missing a label.'] } } })
  })
  await page.goto(`/courses/${courseId}/labs/new`)
  await page.getByLabel('Lab title', { exact: true }).fill('Validated lab')
  for (const field of ['instructions', 'starter', 'tests', 'solution']) await page.locator(`#${field}`).setInputFiles({ name: `${field}.py`, mimeType: 'text/plain', buffer: Buffer.from('print(1)') })
  await page.locator('#solution').setInputFiles({ name: 'solution.py', mimeType: 'text/plain', buffer: Buffer.from('x'.repeat(65537)) })
  await page.getByRole('button', { name: 'Upload lab', exact: true }).click()
  await expect(page.getByText('solution exceeds the 64 KiB upload limit.')).toBeVisible()
  expect(calls).toBe(0)
  await page.locator('#solution').setInputFiles({ name: 'solution.py', mimeType: 'text/plain', buffer: Buffer.from('print(1)') })
  await page.getByRole('button', { name: 'Retry upload', exact: true }).click()
  await expect(page.getByText('tests.py · line 3')).toBeVisible()
  await expect(page.getByLabel('Reference validation diagnostics')).toContainText('<script>window.injected=true</script>')
  expect(await page.evaluate(() => 'injected' in window)).toBe(false)
  expect(await page.locator('#solution').evaluate((element: HTMLInputElement) => element.files?.[0].name)).toBe('solution.py')
  await page.getByRole('button', { name: 'Retry upload', exact: true }).click()
  await expect(page.getByText('Validation runner unavailable')).toBeVisible()
  await page.getByRole('button', { name: 'Retry upload', exact: true }).click()
  await expect(page.getByText('Upload outcome is uncertain')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry upload', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'I checked — allow retry', exact: true }).click()
  await page.getByRole('button', { name: 'Retry upload', exact: true }).click()
  await expect(page.getByText('Lab validated and saved', { exact: true })).toBeVisible()
  await expect(page.getByText('One test is missing a label.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open saved lab', exact: true })).toHaveAttribute('href', `/courses/${courseId}/labs/${labId}`)
})

test('switching ordinary submission to submit anyway uses a new key for the same source', async ({ page }) => {
  await setup(page)
  const requests: Array<{ key: string; code: string; submit_anyway: boolean }> = []
  const failed = { ...execution, score: 0, passed: 0, results: [{ name: 'Test 1', passed: false, error: 'Test failed' }] }
  await page.route('**/api/labs/*/submit', route => {
    const body = route.request().postDataJSON()
    requests.push({ ...body, key: route.request().headers()['idempotency-key'] })
    return route.fulfill({ json: { accepted: body.submit_anyway, submission_id: body.submit_anyway ? submissionId : null, submitted_at: body.submit_anyway ? '2026-11-28T10:00:00Z' : null, submit_anyway: body.submit_anyway, submission_status: body.submit_anyway ? 'pending_review' : null, execution: failed } })
  })
  await openLab(page)
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await expect(page.getByText('Check your test results', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Submit anyway…', exact: true }).click()
  await page.getByRole('button', { name: 'Submit anyway', exact: true }).click()
  await expect(page.getByText('Submitted — pending teacher review', { exact: true })).toBeVisible()
  expect(requests).toHaveLength(2)
  expect(requests[0].key).not.toBe(requests[1].key)
  expect(requests.map(request => request.submit_anyway)).toEqual([false, true])
  expect(requests[0].code).toBe(requests[1].code)
})
