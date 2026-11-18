#!/usr/bin/env node
/**
 * Phone-size layout check. Serves the production build (run `npm run build`
 * first), opens it in emulated phones and fails if, on any dashboard tab or
 * settings section:
 *   - the page scrolls sideways,
 *   - something is pushed off the side of the screen (outside a deliberate
 *     horizontal scroller),
 *   - two cards overlap,
 *   - the Settings link is not fully on-screen, or
 *   - the iOS install tip covers app content.
 *
 * Usage: npm run test:mobile            (starts its own preview server)
 *        npm run test:mobile -- <url>   (checks an already-running app)
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chromium, devices } from 'playwright'

const PHONES = ['iPhone SE', 'iPhone 14', 'Pixel 7']
const DASHBOARD_TABS = ['Live', 'History', 'Spot', 'Backtest', 'Stats']
const PORT = 4173

/** Runs in the page: returns a list of layout problems (empty = fine) */
function audit() {
  const vw = window.innerWidth
  const problems = []
  const label = (e) => `${e.tagName.toLowerCase()} "${(e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`
  const rectOf = (e) => e.getBoundingClientRect()
  const visible = (e) => { const r = rectOf(e); return r.width > 0 && r.height > 0 }
  // Inside something that scrolls sideways on purpose (tab strips, wide tables)
  const insideScroller = (e) => {
    for (let a = e.parentElement; a; a = a.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(a).overflowX) && a.scrollWidth > a.clientWidth) return true
    }
    return false
  }

  if (document.documentElement.scrollWidth > vw + 1) {
    problems.push(`page scrolls sideways (${document.documentElement.scrollWidth}px wide on a ${vw}px screen)`)
  }

  const offscreen = [...document.querySelectorAll('button, a, input, select, textarea, [role="button"]')]
    .filter((e) => visible(e) && !insideScroller(e) && !e.closest('[aria-hidden="true"]'))
    .filter((e) => rectOf(e).right > vw + 1 || rectOf(e).left < -1)
  for (const e of offscreen.slice(0, 5)) problems.push(`off-screen control: ${label(e)}`)

  const cards = [...document.querySelectorAll('.card-base')].filter(visible)
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      if (cards[i].contains(cards[j]) || cards[j].contains(cards[i])) continue
      const a = rectOf(cards[i]), b = rectOf(cards[j])
      if (a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 2 && b.top < a.bottom - 2) {
        problems.push(`overlapping cards: ${label(cards[i])} and ${label(cards[j])}`)
      }
    }
  }

  const gear = document.querySelector('a[aria-label="Settings"]')
  if (gear && visible(gear) && (rectOf(gear).right > vw || rectOf(gear).left < 0)) {
    problems.push('Settings link is not fully on-screen')
  }

  const hint = document.querySelector('[data-testid="ios-install-hint"]')
  const app = document.querySelector('.app-viewport')
  if (hint && app && rectOf(app).bottom > rectOf(hint).top + 1) {
    problems.push('install tip covers app content')
  }
  return problems.slice(0, 12)
}

async function waitForServer(url, ms = 30_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`Preview server did not start at ${url}`)
}

async function main() {
  let url = process.argv[2]
  let server = null
  if (!url) {
    if (!existsSync('dist/index.html')) throw new Error('No build found. Run `npm run build` first.')
    url = `http://127.0.0.1:${PORT}`
    server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
    await waitForServer(url)
  }

  const failures = []
  let checked = 0
  const browser = await chromium.launch()
  try {
    for (const phone of PHONES) {
      const context = await browser.newContext({ ...devices[phone] })
      const page = await context.newPage()
      page.setDefaultTimeout(10_000)
      const check = async (where) => {
        await page.waitForTimeout(600) // let lazy panels and transitions settle
        checked++
        for (const problem of await page.evaluate(audit)) failures.push(`${phone} · ${where}: ${problem}`)
      }

      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.locator('a[aria-label="Settings"]').waitFor()
      for (const tab of DASHBOARD_TABS) {
        await page.getByRole('button', { name: tab, exact: true }).click()
        await check(`${tab} tab`)
      }

      // The gear must be tappable, and lead to Settings
      await page.locator('a[aria-label="Settings"]').tap()
      await page.waitForURL('**/settings')
      const sections = page.locator('[role="tablist"] [role="tab"]')
      await sections.first().waitFor()
      const count = await sections.count()
      for (let i = 0; i < count; i++) {
        const name = (await sections.nth(i).innerText()).trim()
        await sections.nth(i).click()
        await check(`Settings → ${name}`)
      }
      await context.close()
    }
  } finally {
    await browser.close()
    server?.kill()
  }

  if (failures.length > 0) {
    console.error(`Mobile layout check FAILED (${failures.length} problem(s)):\n` + failures.map((f) => `  - ${f}`).join('\n'))
    process.exit(1)
  }
  console.log(`Mobile layout check passed: ${checked} screens across ${PHONES.length} phones.`)
}

main().catch((error) => { console.error(error); process.exit(1) })
