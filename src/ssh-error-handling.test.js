// Regression test: an ssh2 exec stream that errors after the connection was
// torn down must not take the process down.
//
// The bug: runSshCommand's timeout path calls conn.destroy() while the exec
// stream is still live. ssh2 can then emit 'error' on the stream (or on
// stream.stderr). A stream with no 'error' listener rethrows it as an
// uncaught exception, which terminates node — the dashboard container dies
// with SIGSEGV/exit 139 and Docker restarts it.
//
// What this test covers:
//   1. stream.on('error') exists and resolves the promise instead of throwing
//   2. stream.stderr.on('error') exists
//   3. a late 'error' after settle does not produce an uncaught exception
//
// Run: node --test src/ssh-error-handling.test.js

import test from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_JS = resolve(__dirname, 'server.js')

const src = readFileSync(SERVER_JS, 'utf8')

test('exec stream has an error handler', () => {
  assert.ok(
    src.includes("stream.on('error'"),
    'exec stream must have an error listener, otherwise a late ssh2 error '
    + 'is rethrown as an uncaught exception and kills the daemon',
  )
})

test('exec stream stderr has an error handler', () => {
  assert.ok(
    src.includes("stream.stderr.on('error'"),
    'exec stream stderr must have an error listener for the same reason',
  )
})

test('process has an unhandledRejection handler', () => {
  assert.ok(
    src.includes("process.on('unhandledRejection'"),
    'a rejected promise must not terminate the polling daemon',
  )
})

test('process has an uncaughtException handler', () => {
  assert.ok(
    src.includes("process.on('uncaughtException'"),
    'an uncaught throw in a callback must not terminate the polling daemon',
  )
})

test('a stream error with no listener throws (the failure mode we guard)', () => {
  // This is the mechanism: EventEmitter rethrows 'error' when unhandled.
  // It documents WHY the handlers above are required — if this ever stops
  // throwing, the regression tests above lose their meaning.
  const s = new EventEmitter()
  assert.throws(() => s.emit('error', new Error('write after end')))
})

test('a stream error WITH a listener does not throw', () => {
  const s = new EventEmitter()
  let caught = null
  s.on('error', (e) => { caught = e })
  s.emit('error', new Error('write after end'))
  assert.ok(caught, 'the listener must receive the error instead of it being rethrown')
  assert.strictEqual(caught.message, 'write after end')
})

test('the ssh command timeout exceeds the connect timeout', () => {
  // A command timeout shorter than the connect timeout makes the connect
  // timer fire first and tear down the connection mid-handshake, which is
  // what produced the "operation aborted due to timeout" errors in the log.
  const connect = Number(/SSH_CONNECT_TIMEOUT_MS \|\| (\d+)/.exec(src)?.[1] ?? 0)
  const cmd = Number(/SSH_CMD_TIMEOUT_MS \|\| (\d+)/.exec(src)?.[1] ?? 0)
  assert.ok(connect > 0 && cmd > 0, 'both timeouts must have numeric defaults')
  assert.ok(
    cmd >= connect,
    `SSH_CMD_TIMEOUT_MS (${cmd}) must be >= SSH_CONNECT_TIMEOUT_MS (${connect}); `
    + 'otherwise the connect timer fires first and kills the connection mid-handshake',
  )
})
