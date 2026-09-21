import type { UpgradeContext } from './nudge'
import type { UpgradeAdvisory } from '../../next-devtools/shared/upgrade-advisory'
import shellQuote from 'next/dist/compiled/shell-quote'
import { assessUpgrade } from './nudge'
import * as Log from '../../build/output/log'

export function createUpgradeAdvisory(
  directory: string,
  config: UpgradeContext,
  installedVersion: string
) {
  let snapshot: UpgradeAdvisory | null = null
  const policy = config.experimental.agenticAutoUpgrade
  const enabled =
    policy === 'security' || policy === 'latest' || policy === 'future'
  const assessment = enabled
    ? assessUpgrade(
        directory,
        config,
        installedVersion,
        null,
        process.env.__NEXT_AGENTIC_AUTO_UPGRADE === policy
      )
        .then((advisory) => {
          if (advisory?.kind === 'security' && advisory.reference !== null) {
            snapshot = {
              installedVersion,
              prompt: advisory.unavailableReason
                ? `Your version of Next.js is affected by a known security vulnerability.\n\n${advisory.unavailableReason}\n\nReference: ${advisory.reference}\n\nApp directory: ${JSON.stringify(directory)}`
                : `Run \`next upgrade ${shellQuote.quote([directory])} --ai=${advisory.policy}\` and follow its instructions.`,
            }
          }
          return advisory
        })
        .catch(() => {
          Log.warn(
            'Could not check Next.js security advisories. Continuing without an upgrade assessment.'
          )
          return null
        })
    : Promise.resolve(null)

  return { assessment, getSnapshot: () => snapshot }
}
