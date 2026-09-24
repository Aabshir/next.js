import { existsSync, watch, writeFileSync } from 'fs'
import { join } from 'path'
import { after, connection } from 'next/server'
import { Suspense } from 'react'

export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[]>>
}) {
  // Cache Components builds need a boundary around runtime request data.
  return (
    <Suspense fallback={null}>
      <RequestContent searchParams={searchParams} />
    </Suspense>
  )
}

async function RequestContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[]>>
}) {
  await connection()

  const params = await searchParams
  if (params.hold === '1') {
    // Keep Next's real shutdown cleanup pending until the test releases it.
    after(
      () =>
        new Promise<void>((resolve) => {
          const release = join(process.cwd(), `upgrade-release-${process.pid}`)
          const watcher = watch(process.cwd(), () => {
            if (existsSync(release)) {
              watcher.close()
              resolve()
            }
          })
          writeFileSync(join(process.cwd(), `upgrade-ready-${process.pid}`), '')
        })
    )
  }
  if (params.flood === '1') {
    // Fill the outer terminal's buffer during replay to exercise backpressure.
    console.log(
      `UPGRADE_FLOOD_BEGIN${'x'.repeat(1024 * 1024)}UPGRADE_FLOOD_END`
    )
  }
  console.log('UPGRADE_REQUEST_LOG')
  return (
    <p
      data-server-pid={process.pid}
      data-dev-pid={process.ppid}
      data-env-value={process.env.UPGRADE_ENV_RELOAD_VALUE}
    >
      hello world {process.env.UPGRADE_ENV_RELOAD_VALUE}
    </p>
  )
}
