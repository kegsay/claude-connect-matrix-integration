#!/usr/bin/env tsx
/**
 * MCP transport shim. Runs inside the Claude container.
 *
 * Claude Code spawns this as a stdio MCP server. The shim opens a TCP
 * connection to the matrix sidecar, presents an auth token as the first line,
 * and then splices bytes between stdio and the socket in both directions.
 *
 * The shim does not parse MCP frames — it is a transport bridge only.
 *
 * Env:
 *   MATRIX_SIDECAR_HOST   default: matrix-sidecar
 *   MATRIX_SIDECAR_PORT   default: 8765
 *   MATRIX_SIDECAR_TOKEN  required — must match the sidecar's token
 */

import { createConnection, type Socket } from 'net'
import { setTimeout as delay } from 'timers/promises'

const HOST = process.env.MATRIX_SIDECAR_HOST ?? 'matrix-sidecar'
const PORT = Number(process.env.MATRIX_SIDECAR_PORT ?? '8765')
const TOKEN = process.env.MATRIX_SIDECAR_TOKEN ?? ''

if (!TOKEN) {
  process.stderr.write('matrix shim: MATRIX_SIDECAR_TOKEN not set; refusing to start\n')
  process.exit(1)
}
if (!PORT || PORT < 1 || PORT > 65535) {
  process.stderr.write(`matrix shim: MATRIX_SIDECAR_PORT invalid (got ${PORT})\n`)
  process.exit(1)
}

// On `docker compose up` the sidecar and Claude container start in parallel.
// Retry the initial connect so the shim survives the race.
const MAX_ATTEMPTS = 30
const BACKOFF_MS = 500

async function connectWithRetry(): Promise<Socket> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const sock = createConnection({ host: HOST, port: PORT })
        const onError = (err: Error) => { sock.removeAllListeners(); reject(err) }
        sock.once('error', onError)
        sock.once('connect', () => {
          sock.off('error', onError)
          resolve(sock)
        })
      })
    } catch (err) {
      lastErr = err
      if (attempt === MAX_ATTEMPTS) break
      process.stderr.write(
        `matrix shim: connect attempt ${attempt}/${MAX_ATTEMPTS} to ${HOST}:${PORT} failed (${err}); retrying in ${BACKOFF_MS}ms\n`,
      )
      await delay(BACKOFF_MS)
    }
  }
  throw lastErr
}

let sock: Socket
try {
  sock = await connectWithRetry()
} catch (err) {
  process.stderr.write(`matrix shim: gave up connecting to ${HOST}:${PORT}: ${err}\n`)
  process.exit(1)
}

sock.setKeepAlive(true, 30_000)
sock.setNoDelay(true)

// Auth: single line ending in \n, then MCP traffic.
sock.write(TOKEN + '\n')

// Wire stdio ↔ socket in both directions.
//
// Why not just .pipe() in both directions? Because pipe() propagates end()
// events, and we want explicit control over shutdown — when one side dies,
// we want to tear down deliberately, not have an asymmetric half-close that
// leaves the other side hanging.
process.stdin.on('data', chunk => {
  if (!sock.writable) return
  sock.write(chunk)
})

sock.on('data', chunk => {
  if (!process.stdout.writable) return
  process.stdout.write(chunk)
})

let shuttingDown = false
function shutdown(reason: string, code = 0): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write(`matrix shim: ${reason}\n`)
  try { sock.end() } catch {}
  // Give buffered writes a moment to flush, then exit.
  setTimeout(() => process.exit(code), 250).unref()
}

sock.on('close', () => shutdown('sidecar closed connection'))
sock.on('error', err => shutdown(`socket error: ${err}`, 1))
process.stdin.on('end', () => shutdown('stdin closed'))
process.stdin.on('close', () => shutdown('stdin closed'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

process.stderr.write(`matrix shim: connected to ${HOST}:${PORT}\n`)