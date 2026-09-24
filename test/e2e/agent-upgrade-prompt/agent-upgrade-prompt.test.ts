import { existsSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import resolveFrom from 'resolve-from'
import { isNextDev, nextTestSetup } from 'e2e-utils'
import { findPort, retry } from 'next-test-utils'

describe('agent upgrade prompt', () => {
  const { next } = nextTestSetup({
    files: __dirname,
    skipStart: true,
    skipDeployment: true,
  })

  // TODO: Add the next build case in start mode using this terminal fixture.
  describe('next dev', () => {
    if (!isNextDev) {
      it.skip('runs only in dev mode', () => {})
      return
    }

    // Start the real next dev CLI in a PTY so it sees an interactive terminal.
    // Normal mode runs without an upgrade policy; prompt mode lets us send
    // menu keys and inspect exactly what the user would see.
    async function startDev(
      mode: 'normal' | 'prompt' = 'prompt',
      waitForShutdown: boolean = false
    ) {
      const nextBin = resolveFrom(
        process.env.NEXT_SKIP_ISOLATE ? process.cwd() : next.testDir,
        'next/dist/bin/next'
      )
      const pty = createRequire(nextBin)('node-pty')
      const port = await findPort()
      const env = { ...process.env }

      if (mode === 'normal') {
        delete env.__NEXT_AGENTIC_AUTO_UPGRADE
        delete env.NEXT_PRIVATE_UPGRADE_SUPERVISED
      } else {
        env.__NEXT_AGENTIC_AUTO_UPGRADE = 'future'
      }

      if (waitForShutdown) {
        // Normally next dev SIGKILLs its worker after 100 ms. Disable that
        // timeout so the fixture's pending after() stays alive long enough to
        // observe upgrade startup, then release it explicitly in the test.
        env.__NEXT_DEV_WAIT_FOR_TURBOPACK_SHUTDOWN = '1'
      }

      // This test simulates a human terminal even when CI runs inside an agent.
      delete env.AI_AGENT
      delete env.CODEX_SANDBOX
      delete env.CODEX_CI
      delete env.CODEX_THREAD_ID

      const terminal = pty.spawn(
        process.execPath,
        [nextBin, 'dev', '-p', String(port), '-H', '127.0.0.1'],
        {
          cwd: next.testDir,
          env,
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
        }
      )
      let output = ''
      let exited = false
      terminal.onData((data: string) => {
        output += data
      })
      terminal.onExit(() => {
        exited = true
      })

      return {
        port,
        terminal,
        get output() {
          return output
        },
        get exited() {
          return exited
        },
        async stop(skipPrompt: boolean = true) {
          if (!exited) {
            // Leave the menu through Skip before stopping prompted dev.
            if (mode === 'prompt' && skipPrompt) {
              terminal.write('\x1b[B\r')
            }
            terminal.write('\x03')
            try {
              await retry(async () => {
                expect(exited).toBe(true)
              })
            } finally {
              if (!exited) {
                terminal.kill()
              }
            }
          }
        },
      }
    }

    it('serves requests without showing dev logs over the prompt', async () => {
      await next.patchFile(
        'next.config.js',
        'module.exports = {}\n',
        async () => {
          const normal = await startDev('normal')
          try {
            // Without a policy, the real dev CLI prints its startup log directly.
            await retry(async () => {
              expect(normal.output).toContain('Ready in')
            }, 10_000)
            expect(normal.output).not.toContain('Upgrade now')
            expect(normal.output).not.toContain('\x1b[?1049h')
          } finally {
            await normal.stop()
          }
        }
      )

      // Start the same fixture with the prompt enabled to compare terminal output.
      const dev = await startDev()

      try {
        // The requested upgrade ensures an offer even without a newer release.
        // The real dev server must serve while the terminal menu remains open.
        await retry(async () => {
          expect(dev.output).toContain('Upgrade now')
        }, 10_000)

        // A successful request proves dev continues working beneath the menu.
        const response = await retry(
          () => fetch(`http://127.0.0.1:${dev.port}/`),
          10_000
        )
        expect(response.status).toBe(200)
        expect(await response.text()).toContain('hello world')
        // The same startup log is captured while the upgrade menu is open.
        expect(dev.output).not.toContain('Ready in')
        // app/page.tsx logs this marker, but dev output stays behind the menu.
        expect(dev.output).not.toContain('UPGRADE_REQUEST_LOG')
        // promptUpgrade() writes this when leaving the alternate screen.
        expect(dev.output).not.toContain('\x1b[?1049l')
      } finally {
        await dev.stop()
      }
    })

    it('reloads .env values while dev runs under the prompt', async () => {
      await next.patchFile(
        '.env',
        'UPGRADE_ENV_RELOAD_VALUE=before\n',
        async () => {
          const dev = await startDev()
          try {
            await retry(async () => {
              expect(dev.output).toContain('Upgrade now')
            }, 10_000)

            const page = () => fetch(`http://127.0.0.1:${dev.port}/`)
            await retry(async () => {
              expect(await (await page()).text()).toContain(
                'data-env-value="before"'
              )
            }, 10_000)

            // The supervisor must not pass its loaded .env value as an inherited
            // variable; otherwise the child cannot replace it on file reload.
            await next.patchFile(
              '.env',
              'UPGRADE_ENV_RELOAD_VALUE=after\n',
              async () => {
                await retry(async () => {
                  expect(await (await page()).text()).toContain(
                    'data-env-value="after"'
                  )
                }, 10_000)
              }
            )
          } finally {
            await dev.stop()
          }
        }
      )
    })

    it('stops dev and its worker when the outer CLI receives SIGTERM', async () => {
      const dev = await startDev()
      let serverPid = 0
      let devPid = 0
      try {
        await retry(async () => {
          expect(dev.output).toContain('Upgrade now')
        }, 10_000)

        const response = await retry(
          () => fetch(`http://127.0.0.1:${dev.port}/`),
          10_000
        )
        const body = await response.text()
        serverPid = Number(body.match(/data-server-pid="(\d+)"/)?.[1])
        devPid = Number(body.match(/data-dev-pid="(\d+)"/)?.[1])
        expect(serverPid).toBeGreaterThan(0)
        expect(devPid).toBeGreaterThan(0)

        // Terminate the invoking CLI, not its PTY child, to exercise signal
        // forwarding through the supervisor while the menu is still open.
        process.kill(dev.terminal.pid, 'SIGTERM')
        await retry(async () => {
          expect(dev.exited).toBe(true)
          expect(() => process.kill(devPid, 0)).toThrow()
          expect(() => process.kill(serverPid, 0)).toThrow()
        }, 10_000)
      } finally {
        await dev.stop(false)
        // If the assertion fails, do not leave a dev server behind.
        for (const pid of [devPid, serverPid]) {
          if (pid) {
            try {
              process.kill(pid, 'SIGKILL')
            } catch {}
          }
        }
      }
    })

    it('replays captured dev logs once on Skip, then streams new logs', async () => {
      const dev = await startDev()
      try {
        await retry(async () => {
          expect(dev.output).toContain('Upgrade now')
        }, 10_000)
        // Generate a server log while the menu owns the terminal.
        const firstResponse = await retry(
          () => fetch(`http://127.0.0.1:${dev.port}/`),
          10_000
        )
        expect(firstResponse.status).toBe(200)
        // app/page.tsx logged the marker; Skip has not replayed it yet.
        expect(dev.output).not.toContain('UPGRADE_REQUEST_LOG')

        // Skip must leave the menu before replaying the captured log, once.
        dev.terminal.write('\x1b[B\r')
        await retry(async () => {
          expect(dev.output).toContain('UPGRADE_REQUEST_LOG')
          expect(dev.output).toContain('\x1b[?1049l')
        })
        expect(dev.output.indexOf('\x1b[?1049l')).toBeLessThan(
          dev.output.indexOf('UPGRADE_REQUEST_LOG')
        )
        expect(dev.output.match(/UPGRADE_REQUEST_LOG/g)).toHaveLength(1)

        // Later requests should stream normally rather than replay old output.
        const replayEnd = dev.output.length
        const response = await fetch(`http://127.0.0.1:${dev.port}/`)
        expect(response.status).toBe(200)
        await retry(async () => {
          expect(dev.output.slice(replayEnd)).toContain('UPGRADE_REQUEST_LOG')
        })
        expect(dev.output.match(/UPGRADE_REQUEST_LOG/g)).toHaveLength(2)
      } finally {
        await dev.stop()
      }
    })

    it('starts Upgrade now before shutdown finishes, then stops dev and its worker', async () => {
      // Keep the worker alive until the test releases its pending after().
      const dev = await startDev('prompt', true)
      let releasePath = ''
      let readyPath = ''

      try {
        // Wait until the menu is visible before making the request that will
        // hold the server worker open during shutdown.
        await retry(async () => {
          expect(dev.output).toContain('Upgrade now')
        }, 10_000)

        let serverPid = 0
        let devPid = 0

        // The fixture holds graceful shutdown until we create its release file.
        // Its response exposes the parent and server PIDs for the exit checks.
        const response = await retry(
          () => fetch(`http://127.0.0.1:${dev.port}/?hold=1`),
          10_000
        )
        expect(response.status).toBe(200)

        // The page exposes its own PID and its parent dev PID in HTML attributes.
        // We need both to verify that shutdown eventually stops both processes.
        const body = await response.text()
        serverPid = Number(body.match(/data-server-pid="(\d+)"/)?.[1])
        devPid = Number(body.match(/data-dev-pid="(\d+)"/)?.[1])
        expect(serverPid).toBeGreaterThan(0)
        expect(devPid).toBeGreaterThan(0)

        readyPath = join(next.testDir, `upgrade-ready-${serverPid}`)
        releasePath = join(next.testDir, `upgrade-release-${serverPid}`)

        // The ready file means after() is waiting for the release file.
        await retry(async () => {
          expect(existsSync(readyPath)).toBe(true)
        }, 5_000)

        // Enter selects Upgrade now, which starts the real next upgrade --ai.
        dev.terminal.write('\r')

        // The real upgrade command prints this before looking up its target.
        // Seeing it while the server is alive proves the parent did not wait
        // for graceful shutdown to finish.
        await retry(async () => {
          expect(dev.output).toContain('Preparing upgrade...')
        }, 10_000)

        expect(process.kill(serverPid, 0)).toBe(true)

        // Stop upgrade preparation, release after(), and verify both Next
        // processes eventually exit without launching an agent.
        if (!dev.exited) {
          dev.terminal.write('\x03')
        }
        writeFileSync(releasePath, '')

        await retry(async () => {
          expect(dev.exited).toBe(true)
          expect(() => process.kill(serverPid, 0)).toThrow()
          expect(() => process.kill(devPid, 0)).toThrow()
        }, 15_000)
      } finally {
        // Always unblock shutdown, including when an earlier assertion fails.
        if (releasePath) {
          writeFileSync(releasePath, '')
        }

        // The upgrade menu is gone, so do not send a Skip selection here.
        await dev.stop(false)

        if (readyPath) {
          rmSync(readyPath, { force: true })
          rmSync(releasePath, { force: true })
        }
      }
    })
  })
})
