import { expect, test } from 'vitest'
import { build } from '../runners'
import fs from 'fs-extra'
import path from 'pathe'

test(
  'content script with world MAIN builds correctly',
  async () => {
    const { browser } = await build(__dirname)

    const page = await browser.newPage()
    await page.goto('https://example.com')

    // Wait for the content script to load and create the test container
    await page.waitForSelector('#world-main-test-container', {
      timeout: 10000,
    })

    const testContainer = page.locator('#world-main-test-container')
    await testContainer.waitFor({ timeout: 5000 })

    // Verify the container has the correct text
    const containerText = await testContainer.textContent()
    expect(containerText).toBe('Content Script World: MAIN')

    // Verify that the script set a global variable (proving it runs in MAIN world)
    const globalVar = await page.evaluate(() => {
      return (window as any).testWorldMain
    })
    expect(globalVar).toBe('running in MAIN world')

    console.log('✓ Built content script with world MAIN verified successfully')
  },
  {
    retry: process.env.CI ? 5 : 0,
  },
)

test(
  'content script with world MAIN is a synchronous IIFE (no async loader)',
  async () => {
    const { outDir } = await build(__dirname)

    // Find the content script output file
    const assets = await fs.readdir(path.join(outDir, 'assets'))
    const contentFile = assets.find((f) => f.startsWith('content.ts'))
    expect(contentFile).toBeDefined()

    const code = await fs.readFile(
      path.join(outDir, 'assets', contentFile!),
      'utf8',
    )

    // Must be a self-contained IIFE — no imports, no dynamic import, no await
    expect(code).not.toMatch(/\bimport\s*\(/)
    expect(code).not.toMatch(/\bimport\s*{/)
    expect(code).not.toMatch(/\bawait\b/)
    // Must be wrapped in an IIFE
    expect(code).toMatch(/^\(function\(\)\{/)
  },
  {
    retry: process.env.CI ? 5 : 0,
  },
)
