import { existsSync, watch, writeFileSync } from 'fs'
import { join } from 'path'
import { after } from 'next/server'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ hold: string | undefined }>
}) {
  if ((await searchParams).hold === '1') {
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
