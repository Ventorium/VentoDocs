#!/usr/bin/env node

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const outputDir = process.argv[2] || 'public'
const outputFile = path.join(outputDir, '_info')

// Ensure output directory exists
fs.mkdirSync(outputDir, { recursive: true })

// Get git short hash
let hash = '-'
try {
  hash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
} catch {
  hash = '-'
}

// Get current time (ISO 8601 format)
const bt = new Date().toISOString()

// Get current tag if HEAD is exactly at a tag
let tag = '-'
try {
  tag = execSync('git describe --exact-match --tags HEAD', {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
} catch {
  tag = '-'
}

// Get package version
let pv = '-'
try {
  const packageJsonPath = path.join(__dirname, '../package.json')
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
  pv = packageJson.version || '-'
} catch {
  pv = '-'
}

// Write to output file
const content = `hash: ${hash}
bt: ${bt}
tag: ${tag}
pv: ${pv}
`

fs.writeFileSync(outputFile, content)

console.log(`Build info written to ${outputFile}`)
console.log(content)
