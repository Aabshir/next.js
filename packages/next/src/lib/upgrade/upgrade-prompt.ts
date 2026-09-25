import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from 'fs'
import { constants, tmpdir } from 'os'
import { join } from 'path'
import type { IPty } from 'node-pty'
import { PHASE_DEVELOPMENT_SERVER } from '../../shared/lib/constants'
import { getProjectDir } from '../get-project-dir'
import { getNodeDebugType, getParsedNodeOptions } from '../../server/lib/utils'

/**
 * Keep the human upgrade menu separate from a running `next dev` terminal.
 *
 * 1. Leave non-interactive or unconfigured dev on its ordinary path.
 * 2. Run the same CLI in a PTY so dev still has a real terminal.
 * 3. Capture dev output while the parent shows the menu; dev keeps running.
 * 4. On a non-upgrade choice, replay all output and return to live dev. On
 *    Upgrade now, ask dev to stop and begin upgrading without waiting.
 *
 * The PTY and output lifecycle can also serve `next build`; its CLI wiring and
 * config phase belong to the build follow-up. Keep this dev entry point until
 * that behavior is implemented and tested.
 */
export async function runDevWithUpgradePrompt(
  directory: string
): Promise<boolean> {
  // The PTY child runs this same CLI; this flag keeps it on the ordinary path.
  if (process.env.NEXT_PRIVATE_UPGRADE_SUPERVISED === '1') {
    return false
  }
  // A PTY combines stdout and stderr, so preserve redirected error output.
  // Likewise, relaunching under the same inspector options would collide with
  // the debugger already attached to this process.
  if (!process.stderr.isTTY || getNodeDebugType(getParsedNodeOptions())) {
    return false
  }

  // Check basic eligibility before starting a PTY. The full offer assessment
  // runs later so it cannot delay dev startup; config supplies the policy.
  // Import after the guard so the PTY child skips upgrade module initialization
  // when it re-enters this CLI to run ordinary dev.
  // Config loading reads .env into this process. Keep the original environment
  // so the child can reload .env values when the file changes.
  const childEnv = { ...process.env }
  // Preflight must never replace ordinary dev's config error path. Let nextDev
  // load and report an invalid config in the usual way.
  let preflight: {
    dir: string
    context: ReturnType<(typeof import('./nudge.js'))['getUpgradeContext']>
    nudgeUpgrade: (typeof import('./nudge.js'))['nudgeUpgrade']
    runUpgrade: (typeof import('./nudge.js'))['runUpgrade']
  }
  try {
    const {
      shouldPromptForUpgrade,
      getUpgradeContext,
      nudgeUpgrade,
      runUpgrade,
    } = await import('./nudge.js')
    if (!(await shouldPromptForUpgrade())) {
      return false
    }
    const dir = getProjectDir(process.env.NEXT_PRIVATE_DEV_DIR || directory)
    const loadConfig = (
      require('../../server/config') as typeof import('../../server/config')
    ).default
    // TODO: Reuse this config in dev rather than loading it again in the child.
    const config = await loadConfig(PHASE_DEVELOPMENT_SERVER, dir, {
      silent: true,
    })
    preflight = {
      dir,
      context: getUpgradeContext(config),
      nudgeUpgrade,
      runUpgrade,
    }
  } catch {
    return false
  }
  const { dir, context, nudgeUpgrade, runUpgrade } = preflight
  if (!context.experimental.agenticAutoUpgrade) {
    return false
  }

  // node-pty is optional. If it, output capture, or PTY startup fails, the
  // caller starts ordinary dev and reports why the menu could not be shown.
  let pty: typeof import('node-pty')
  try {
    pty = require('node-pty') as typeof import('node-pty')
  } catch (error) {
    console.warn(
      `Could not show the upgrade prompt (node-pty): ${String(error)}`
    )
    return false
  }

  let captureDir = ''
  let capture: number
  try {
    captureDir = mkdtempSync(join(tmpdir(), 'next-upgrade-output-'))
    capture = openSync(join(captureDir, 'dev.log'), 'w+', 0o600)
  } catch (error) {
    if (captureDir) {
      rmSync(captureDir, { recursive: true, force: true })
    }
    console.warn(
      `Could not show the upgrade prompt (output capture): ${String(error)}`
    )
    return false
  }

  // Relaunch the original command in a real PTY. Its output can be captured
  // without changing what the dev process sees as its terminal.
  let terminal: IPty
  try {
    terminal = pty.spawn(
      process.execPath,
      [...process.execArgv, ...process.argv.slice(1)],
      {
        cwd: process.cwd(),
        env: { ...childEnv, NEXT_PRIVATE_UPGRADE_SUPERVISED: '1' },
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
        name: process.env.TERM || 'xterm-256color',
      }
    )
  } catch (error) {
    closeSync(capture)
    rmSync(captureDir, { recursive: true, force: true })
    console.warn(`Could not show the upgrade prompt (PTY): ${String(error)}`)
    return false
  }

  // Capture output during the menu, queue new chunks during replay to preserve
  // their order, then forward output directly once the menu is gone.
  let capturedBytes = 0
  let outputMode: 'capture' | 'replay' | 'live' = 'capture'
  const pending: Buffer[] = []
  let exitCode: number | null = null
  let exitSignal: number | undefined
  let menuInterrupted = false
  let captureError: unknown = null
  const promptController = new AbortController()
  let terminationSignal: 'SIGTERM' | 'SIGHUP' | null = null
  let waitingForDrain = false
  const onDrain = () => {
    waitingForDrain = false
    if (outputMode === 'live') {
      terminal.resume()
    }
  }
  const onData = terminal.onData((data) => {
    const bytes = Buffer.from(data)
    if (outputMode === 'live') {
      if (!process.stdout.write(bytes) && !waitingForDrain) {
        waitingForDrain = true
        terminal.pause()
        process.stdout.once('drain', onDrain)
      }
    } else if (outputMode === 'replay') {
      pending.push(bytes)
    } else {
      let offset = 0
      try {
        // Spool to disk so a busy dev server cannot exhaust the CLI's memory.
        while (offset < bytes.length) {
          const written = writeSync(
            capture,
            bytes,
            offset,
            bytes.length - offset
          )
          if (written === 0) {
            throw new Error('Dev output capture stopped making progress')
          }
          offset += written
          capturedBytes += written
        }
      } catch (error) {
        captureError = error
        outputMode = 'replay'
        pending.push(bytes.subarray(offset))
        promptController.abort()
      }
    }
  })
  // The dev process may finish before a choice; the menu still owns the parent.
  const childExitCode = (code: number) => {
    if (terminationSignal) {
      return 128 + constants.signals[terminationSignal]
    }
    if (menuInterrupted) {
      return 130
    }
    return exitSignal ? 128 + exitSignal : code
  }
  terminal.onExit(({ exitCode: code, signal }) => {
    exitCode = code
    exitSignal = signal
    if (outputMode === 'live') {
      process.exitCode = childExitCode(code)
    }
  })

  // Keep the child terminal sized like the visible terminal.
  const onResize = () => {
    if (exitCode === null) {
      terminal.resize(process.stdout.columns || 80, process.stdout.rows || 24)
    }
  }
  process.stdout.on('resize', onResize)
  let onContinue: (() => void) | null = null

  // Close the spool after replay; remove listeners on upgrade or parent exit.
  let captureClosed = false
  const closeCapture = () => {
    if (captureClosed) {
      return
    }
    captureClosed = true
    closeSync(capture)
    rmSync(captureDir, { recursive: true, force: true })
  }
  const cleanup = () => {
    process.off('SIGTERM', onTerminate)
    process.off('SIGHUP', onHangup)
    process.stdout.off('resize', onResize)
    process.stdout.off('drain', onDrain)
    if (onContinue) {
      process.off('SIGCONT', onContinue)
    }
    onData.dispose()
    closeCapture()
  }
  // Parent signals must reach the dev CLI, which owns its server worker. Keep
  // the parent alive until that child completes its normal shutdown.
  const terminate = (signal: 'SIGTERM' | 'SIGHUP') => {
    if (terminationSignal) {
      return
    }
    terminationSignal = signal
    promptController.abort()
    if (exitCode === null) {
      terminal.kill(signal)
    }
  }
  const onTerminate = () => terminate('SIGTERM')
  const onHangup = () => terminate('SIGHUP')
  process.on('SIGTERM', onTerminate)
  process.on('SIGHUP', onHangup)
  const onExit = () => cleanup()
  process.once('exit', onExit)

  // The prompt runs in the parent while the PTY child can serve requests.
  let action: Awaited<ReturnType<typeof nudgeUpgrade>> = undefined
  try {
    action = await nudgeUpgrade(dir, context, 'dev', promptController.signal)
  } catch (error) {
    process.stderr.write(`Could not offer the upgrade: ${String(error)}\n`)
  }

  if (captureError) {
    process.stderr.write(
      `Could not capture dev output: ${String(captureError)}\n`
    )
  }

  // Start the upgrade as soon as it is chosen; shutdown is requested but is
  // intentionally not awaited.
  if (
    !terminationSignal &&
    action === 'update' &&
    context.experimental.agenticAutoUpgrade
  ) {
    cleanup()
    process.off('exit', onExit)
    // Ctrl+C asks the foreground dev process and its worker to shut down.
    if (exitCode === null) {
      terminal.write('\x03')
    }
    process.exitCode = await runUpgrade(
      dir,
      context.experimental.agenticAutoUpgrade
    )
    return true
  }

  // After a non-upgrade choice or prompt failure, restore captured output
  // before forwarding new output. Chunks arriving during replay go into pending.
  outputMode = 'replay'
  // Stop PTY reads while replaying so pending output remains bounded and every
  // byte reaches stdout in the same order, even when its reader is slow.
  terminal.pause()
  const writeOutput = async (bytes: Buffer) => {
    if (!process.stdout.write(bytes)) {
      await new Promise<void>((resolve) =>
        process.stdout.once('drain', resolve)
      )
    }
  }
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = 0
  while (position < capturedBytes) {
    const length = readSync(
      capture,
      buffer,
      0,
      Math.min(buffer.length, capturedBytes - position),
      position
    )
    if (length === 0) {
      break
    }
    await writeOutput(buffer.subarray(0, length))
    position += length
  }
  for (const data of pending) {
    await writeOutput(data)
  }
  pending.length = 0
  outputMode = 'live'
  terminal.resume()
  closeCapture()

  // Respect a menu interrupt, or return the child's exit status if dev already
  // finished while the menu was open.
  if (action === 'interrupt') {
    menuInterrupted = true
    if (exitCode === null) {
      terminal.write('\x03')
    }
  }
  if (exitCode !== null) {
    process.exitCode = childExitCode(exitCode)
    return true
  }

  // Once the menu is gone, forward terminal input to the still-running dev CLI.
  const wasRaw = process.stdin.isRaw ?? false
  process.stdin.setRawMode(true)
  process.stdin.resume()
  const onInput = (data: Buffer) => {
    if (process.platform === 'win32') {
      terminal.write(data)
      return
    }
    const suspendAt = data.indexOf(0x1a)
    if (suspendAt === -1) {
      terminal.write(data)
      return
    }
    if (suspendAt > 0) {
      terminal.write(data.subarray(0, suspendAt))
    }
    // The nested PTY suspends its foreground job. Restore the outer terminal
    // before suspending this foreground job so the shell regains control.
    terminal.write('\x1a')
    process.stdin.setRawMode(wasRaw)
    process.stdin.pause()
    process.kill(process.pid, 'SIGTSTP')
    if (suspendAt + 1 < data.length) {
      terminal.write(data.subarray(suspendAt + 1))
    }
  }
  if (process.platform !== 'win32') {
    onContinue = () => {
      // forkpty creates a session led by terminal.pid. Resume the whole PTY
      // foreground group after the shell brings the supervisor back with fg.
      if (exitCode === null) {
        try {
          process.kill(-terminal.pid, 'SIGCONT')
        } catch (error) {
          console.warn(`Could not resume dev after fg: ${String(error)}`)
        }
      }
      process.stdin.setRawMode(true)
      process.stdin.resume()
    }
    process.on('SIGCONT', onContinue)
  }
  process.stdin.on('data', onInput)
  terminal.onExit(({ exitCode: code }) => {
    process.stdin.off('data', onInput)
    process.stdin.setRawMode(wasRaw)
    process.stdin.pause()
    if (onContinue) {
      process.off('SIGCONT', onContinue)
    }
    process.exitCode = childExitCode(code)
  })
  return true
}
