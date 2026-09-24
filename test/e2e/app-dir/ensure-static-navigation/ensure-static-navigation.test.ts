import { isNextDev, isNextStart, nextTestSetup, Playwright } from 'e2e-utils'
import { getPrerenderOutput } from '../cache-components-errors/utils'
import {
  openRedbox,
  waitForNoRedbox,
  waitForRedbox,
} from '../../../lib/next-test-utils'
import {
  createRedboxSnapshot,
  ErrorSnapshot,
  RedboxSnapshot,
} from '../../../lib/add-redbox-matchers'

const ERROR_PATTERNS = {
  uncachedData: {
    dev: /Next\.js encountered uncached data on a route that must be fully static/,
    build:
      /Next\.js encountered uncached or runtime data on a route that must be fully static/,
  },
  /**
   * If a route has only client holes but is missing a suspense, the error message
   * is not specific to `ensureStatic = "navigation"`.
   */
  uncachedDataClientOnly: {
    dev: /Next\.js encountered uncached data during prerendering/,
    build: /Next\.js encountered uncached or runtime data during prerendering/,
  },
  runtimeData: {
    dev: /Next\.js encountered runtime data on a route that must be fully static/,
    build:
      /Next\.js encountered uncached or runtime data on a route that must be fully static/,
  },
  withoutLocation: {
    dev: /Next\.js encountered data that is not available during a static prerender, but is unable to provide a location/,
    build:
      /Next\.js encountered data that is not available during a static prerender, but is unable to provide a location/,
  },
}

function isStaticRouteValidationError(mode: 'dev' | 'build', text: string) {
  return Object.values(ERROR_PATTERNS).some((pattern) =>
    pattern[mode].test(text)
  )
}

function matchAnyStaticRouteValidationErrorSnapshot() {
  return expect.toSatisfy<ErrorSnapshot>((error) => {
    const { description } = error
    if (!description) return false
    return isStaticRouteValidationError('dev', description)
  })
}

function matchErrorSnapshot(pattern: RegExp) {
  return expect.objectContaining<Partial<ErrorSnapshot>>({
    description: expect.stringMatching(pattern),
  })
}

function expectErrorSnapshotToMatchPattern(
  insights: RedboxSnapshot,
  pattern: RegExp
) {
  const errorSnapshotMatcher = matchErrorSnapshot(pattern)
  if (!Array.isArray(insights)) {
    expect(insights).toEqual(errorSnapshotMatcher)
  } else {
    expect(insights).toEqual(expect.arrayContaining(errorSnapshotMatcher))
  }
}

// We skip webpack because the stack traces vary across bundlers.
// We skip deploy, because build-time tests rely on CLI output and
// manually prerendering pages, which is not supported in deploy mode.
// @force-gate turbopack && !deploy
describe('ensureStatic = "navigation"', () => {
  const { next } = nextTestSetup({
    files: __dirname,
    skipStart: !isNextDev,
  })

  const debugPrerender = true

  beforeAll(async () => {
    if (isNextStart) {
      const args = ['--experimental-build-mode', 'compile']
      if (debugPrerender) {
        args.push('--debug-prerender')
      }
      const result = await next.build({ args })
      if (result.exitCode !== 0) {
        throw new Error('Failed to build. CLI Output:\n\n' + result.cliOutput)
      }
    }
  })

  const prerenderPattern = async (pattern: string) => {
    const args = [
      '--experimental-build-mode',
      'generate',
      '--debug-build-paths',
      pattern,
    ]
    if (debugPrerender) {
      args.push('--debug-prerender')
    }
    const result = await next.build({ args })
    if (
      result.cliOutput.includes(`Pattern "${pattern}" did not match any files`)
    ) {
      throw new Error(`Pattern "${pattern}" did not match any files`)
    }
    return result
  }

  const prerenderPage = (route: string) => {
    return prerenderPattern(`app${route}/page.tsx`)
  }

  const expectPrerenderSuccess = (
    result: Awaited<ReturnType<typeof prerenderPattern>>
  ) => {
    const output = getPrerenderOutput(result.cliOutput, { isMinified: true })
    expect({ output, exitCode: result.exitCode }).toEqual({
      output: '',
      exitCode: 0,
    })
  }

  const expectDevValidationSuccess = async (browser: Playwright) => {
    // TODO(ensure-static): more reliable wait
    await waitForNoRedbox(browser)
  }

  const getCollapsedRedboxErrors = async (browser: Playwright) => {
    // TODO: wait for validation
    await openRedbox(browser)
    return createRedboxSnapshot(browser, next)
  }

  describe('dynamic data', () => {
    it('does not allow using uncached data despite suspense', async () => {
      const errorPattern = ERROR_PATTERNS.uncachedData
      const route = '/default/uncached-data'

      if (isNextDev) {
        const browser = await next.browser(route)
        const error = await getCollapsedRedboxErrors(browser)
        expectErrorSnapshotToMatchPattern(error, errorPattern.dev)
        expect(error).toMatchInlineSnapshot(`
         {
           "description": "Route "/default/uncached-data": Next.js encountered uncached data on a route that must be fully static.

         \`fetch(...)\` or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>",
           "environmentLabel": "Server",
           "label": "Console Error",
           "source": "app/default/uncached-data/page.tsx (17:9) @ Inner
         > 17 |   await new Promise((resolve) => setTimeout(resolve))
              |         ^",
           "stack": [
             "Inner app/default/uncached-data/page.tsx (17:9)",
             "Page app/default/uncached-data/page.tsx (9:9)",
           ],
         }
        `)
      } else {
        const result = await prerenderPage(route)
        // TODO: why is the code-frame pointing at the enclosing component
        // instead of the actual await? seems like a React debugInfo limitation
        // during prerenders, because the await chain never finished
        const error = getPrerenderOutput(result.cliOutput, { isMinified: true })
        expect(error).toMatch(errorPattern.build)
        expect(error).toMatchInlineSnapshot(`
         "Error: Route "/default/uncached-data": Next.js encountered uncached or runtime data on a route that must be fully static.

         \`fetch(...)\`, \`cookies()\`, \`headers()\`, \`params\`, \`searchParams\`, or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>
             at Inner (app/default/uncached-data/page.tsx:15:16)
             at Page (app/default/uncached-data/page.tsx:9:9)
           13 | }
           14 |
         > 15 | async function Inner() {
              |                ^
           16 |   // Simulate tasky IO
           17 |   await new Promise((resolve) => setTimeout(resolve))
           18 |   return <p>Uncached data</p>
         To debug the issue, start the app in development mode by running \`next dev\`, then open "/default/uncached-data" in your browser to investigate the error.
         Error occurred prerendering page "/default/uncached-data". Read more: https://nextjs.org/docs/messages/prerender-error

         > Export encountered errors on 1 path:
         	/default/uncached-data/page: /default/uncached-data"
        `)
        expect(result.exitCode).toBe(1)
      }
    })

    it('does not allow using `connection()` despite suspense', async () => {
      const route = '/default/connection'
      const errorPattern = ERROR_PATTERNS.uncachedData
      if (isNextDev) {
        const browser = await next.browser(route)
        const error = await getCollapsedRedboxErrors(browser)
        expectErrorSnapshotToMatchPattern(error, errorPattern.dev)
        expect(error).toMatchInlineSnapshot(`
         {
           "description": "Route "/default/connection": Next.js encountered uncached data on a route that must be fully static.

         \`fetch(...)\` or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>",
           "environmentLabel": "Server",
           "label": "Console Error",
           "source": "app/default/connection/page.tsx (17:19) @ Inner
         > 17 |   await connection()
              |                   ^",
           "stack": [
             "Inner app/default/connection/page.tsx (17:19)",
             "Page app/default/connection/page.tsx (10:9)",
           ],
         }
        `)
      } else {
        const result = await prerenderPage(route)
        const error = getPrerenderOutput(result.cliOutput, { isMinified: true })
        expect(error).toMatch(errorPattern.build)
        expect(error).toMatchInlineSnapshot(`
         "Error: Route "/default/connection": Next.js encountered uncached or runtime data on a route that must be fully static.

         \`fetch(...)\`, \`cookies()\`, \`headers()\`, \`params\`, \`searchParams\`, or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>
             at Inner (app/default/connection/page.tsx:17:19)
             at Page (app/default/connection/page.tsx:10:9)
           15 |
           16 | async function Inner() {
         > 17 |   await connection()
              |                   ^
           18 |   return <p>Dynamic data</p>
           19 | }
           20 |
         To debug the issue, start the app in development mode by running \`next dev\`, then open "/default/connection" in your browser to investigate the error.
         Error occurred prerendering page "/default/connection". Read more: https://nextjs.org/docs/messages/prerender-error

         > Export encountered errors on 1 path:
         	/default/connection/page: /default/connection"
        `)
        expect(result.exitCode).toBe(1)
      }
    })

    it('does not allow using `connection()` despite `instant = false`', async () => {
      const errorPattern = ERROR_PATTERNS.uncachedData
      const route = '/default/instant-false/connection-blocking'
      if (isNextDev) {
        const browser = await next.browser(route)
        const error = await getCollapsedRedboxErrors(browser)
        expectErrorSnapshotToMatchPattern(error, errorPattern.dev)
        expect(error).toMatchInlineSnapshot(`
         {
           "description": "Route "/default/instant-false/connection-blocking": Next.js encountered uncached data on a route that must be fully static.

         \`fetch(...)\` or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>",
           "environmentLabel": "Server",
           "label": "Console Error",
           "source": "app/default/instant-false/connection-blocking/page.tsx (20:19) @ Inner
         > 20 |   await connection()
              |                   ^",
           "stack": [
             "Inner app/default/instant-false/connection-blocking/page.tsx (20:19)",
             "Page app/default/instant-false/connection-blocking/page.tsx (14:7)",
           ],
         }
        `)
      } else {
        const result = await prerenderPage(route)
        const error = getPrerenderOutput(result.cliOutput, { isMinified: true })
        expect(error).toMatch(errorPattern.build)
        expect(error).toMatchInlineSnapshot(`
         "Error: Route "/default/instant-false/connection-blocking": Next.js encountered uncached or runtime data on a route that must be fully static.

         \`fetch(...)\`, \`cookies()\`, \`headers()\`, \`params\`, \`searchParams\`, or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>
             at Inner (app/default/instant-false/connection-blocking/page.tsx:20:19)
             at Page (app/default/instant-false/connection-blocking/page.tsx:14:7)
           18 |
           19 | async function Inner() {
         > 20 |   await connection()
              |                   ^
           21 |   return <p>Dynamic data</p>
           22 | }
           23 |
         To debug the issue, start the app in development mode by running \`next dev\`, then open "/default/instant-false/connection-blocking" in your browser to investigate the error.
         Error occurred prerendering page "/default/instant-false/connection-blocking". Read more: https://nextjs.org/docs/messages/prerender-error

         > Export encountered errors on 1 path:
         	/default/instant-false/connection-blocking/page: /default/instant-false/connection-blocking"
        `)
        expect(result.exitCode).toBe(1)
      }
    })

    it('does not allow using `connection()` despite suspense-above-body', async () => {
      const errorPattern = ERROR_PATTERNS.uncachedData
      const route = '/suspense-above-body/connection-blocking'
      if (isNextDev) {
        const browser = await next.browser(route)
        const error = await getCollapsedRedboxErrors(browser)
        expectErrorSnapshotToMatchPattern(error, errorPattern.dev)
        expect(error).toMatchInlineSnapshot(`
         {
           "description": "Route "/suspense-above-body/connection-blocking": Next.js encountered uncached data on a route that must be fully static.

         \`fetch(...)\` or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>",
           "environmentLabel": "Server",
           "label": "Console Error",
           "source": "app/suspense-above-body/connection-blocking/page.tsx (20:19) @ Inner
         > 20 |   await connection()
              |                   ^",
           "stack": [
             "Inner app/suspense-above-body/connection-blocking/page.tsx (20:19)",
             "Page app/suspense-above-body/connection-blocking/page.tsx (14:7)",
           ],
         }
        `)
      } else {
        const result = await prerenderPage(route)
        const error = getPrerenderOutput(result.cliOutput, { isMinified: true })
        expect(error).toMatch(errorPattern.build)
        expect(error).toMatchInlineSnapshot(`
         "Error: Route "/suspense-above-body/connection-blocking": Next.js encountered uncached or runtime data on a route that must be fully static.

         \`fetch(...)\`, \`cookies()\`, \`headers()\`, \`params\`, \`searchParams\`, or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>
             at Inner (app/suspense-above-body/connection-blocking/page.tsx:20:19)
             at Page (app/suspense-above-body/connection-blocking/page.tsx:14:7)
           18 |
           19 | async function Inner() {
         > 20 |   await connection()
              |                   ^
           21 |   return <p>Dynamic data</p>
           22 | }
           23 |
         To debug the issue, start the app in development mode by running \`next dev\`, then open "/suspense-above-body/connection-blocking" in your browser to investigate the error.
         Error occurred prerendering page "/suspense-above-body/connection-blocking". Read more: https://nextjs.org/docs/messages/prerender-error

         > Export encountered errors on 1 path:
         	/suspense-above-body/connection-blocking/page: /suspense-above-body/connection-blocking"
        `)
        expect(result.exitCode).toBe(1)
      }
    })

    it('does not allow passing dynamic data to a client component that accesses it with `use()`', async () => {
      const errorPattern = ERROR_PATTERNS.uncachedData
      const route = '/default/dynamic-data-passed-to-client'
      if (isNextDev) {
        const browser = await next.browser(route)
        const error = await getCollapsedRedboxErrors(browser)
        expectErrorSnapshotToMatchPattern(error, errorPattern.dev)
        expect(error).toMatchInlineSnapshot(`
         {
           "description": "Route "/default/dynamic-data-passed-to-client": Next.js encountered uncached data on a route that must be fully static.

         \`fetch(...)\` or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>",
           "environmentLabel": "Server",
           "label": "Console Error",
           "source": "app/default/dynamic-data-passed-to-client/client.tsx (6:19) @ UseServerData
         > 6 |   const data = use(serverData)
             |                   ^",
           "stack": [
             "UseServerData app/default/dynamic-data-passed-to-client/client.tsx (6:19)",
             "Page app/default/dynamic-data-passed-to-client/page.tsx (11:9)",
           ],
         }
        `)
      } else {
        const result = await prerenderPage(route)
        const error = getPrerenderOutput(result.cliOutput, { isMinified: true })
        expect(error).toMatch(errorPattern.build)
        expect(error).toMatchInlineSnapshot(`
         "Error: Route "/default/dynamic-data-passed-to-client": Next.js encountered uncached or runtime data on a route that must be fully static.

         \`fetch(...)\`, \`cookies()\`, \`headers()\`, \`params\`, \`searchParams\`, or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>
             at UseServerData (app/default/dynamic-data-passed-to-client/client.tsx:6:19)
             at Page (app/default/dynamic-data-passed-to-client/page.tsx:11:9)
           4 |
           5 | export function UseServerData({ serverData }: { serverData: Promise<string> }) {
         > 6 |   const data = use(serverData)
             |                   ^
           7 |   return <p>{\`Server data: \${data}\`}</p>
           8 | }
           9 |
         To debug the issue, start the app in development mode by running \`next dev\`, then open "/default/dynamic-data-passed-to-client" in your browser to investigate the error.
         Error occurred prerendering page "/default/dynamic-data-passed-to-client". Read more: https://nextjs.org/docs/messages/prerender-error

         > Export encountered errors on 1 path:
         	/default/dynamic-data-passed-to-client/page: /default/dynamic-data-passed-to-client"
        `)
        expect(result.exitCode).toBe(1)
      }
    })

    it("does not allow passing dynamic data to a client component, even if it's unused", async () => {
      // If the client doesn't use the promise during the prerender, then
      // it won't be reported as a dynamic hole, so we fall back to a generic
      // error message instead.
      const errorPattern = ERROR_PATTERNS.withoutLocation
      const route = '/default/dynamic-data-passed-to-client-unused'
      if (isNextDev) {
        const browser = await next.browser(route)
        const error = await getCollapsedRedboxErrors(browser)
        expectErrorSnapshotToMatchPattern(error, errorPattern.dev)
        expect(error).toMatchInlineSnapshot(`
         {
           "description": "Route "/default/dynamic-data-passed-to-client-unused": Next.js encountered data that is not available during a static prerender, but is unable to provide a location.",
           "environmentLabel": "Server",
           "label": "Console Error",
           "source": null,
           "stack": [],
         }
        `)
      } else {
        const result = await prerenderPage(route)
        const error = getPrerenderOutput(result.cliOutput, { isMinified: true })
        expect(error).toMatch(errorPattern.build)
        expect(error).toMatchInlineSnapshot(`
         "Error: Route "/default/dynamic-data-passed-to-client-unused": Next.js encountered data that is not available during a static prerender, but is unable to provide a location.
             at ignore-listed frames
         To debug the issue, start the app in development mode by running \`next dev\`, then open "/default/dynamic-data-passed-to-client-unused" in your browser to investigate the error.
         Error occurred prerendering page "/default/dynamic-data-passed-to-client-unused". Read more: https://nextjs.org/docs/messages/prerender-error

         > Export encountered errors on 1 path:
         	/default/dynamic-data-passed-to-client-unused/page: /default/dynamic-data-passed-to-client-unused"
        `)
        expect(result.exitCode).toBe(1)
      }
    })
  })

  describe('fallback params', () => {
    it('does not allow using fallback params despite suspense', async () => {
      // Fallback params cannot be statically prerendered (in a server segment)
      const errorPattern = ERROR_PATTERNS.runtimeData
      const routeInDev = '/default/fallback-params/123'
      const routeInBuild = '/default/fallback-params/[slug]'
      if (isNextDev) {
        const browser = await next.browser(routeInDev)
        const error = await getCollapsedRedboxErrors(browser)
        expectErrorSnapshotToMatchPattern(error, errorPattern.dev)
        expect(error).toMatchInlineSnapshot(`
         {
           "description": "Route "/default/fallback-params/[slug]": Next.js encountered runtime data on a route that must be fully static.

         \`cookies()\`, \`headers()\`, \`params\`, or \`searchParams\` prevent the route from being prerendered.

         Ways to fix this:
           - [static] For \`params\`: specify a static set of params to be prerendered using \`generateStaticParams\`
           - [client] For \`params\` and \`searchParams\`: read on the client with \`useParams()\` or \`useSearchParams()\`
         Learn more: <TODO>",
           "environmentLabel": "Server",
           "label": "Console Error",
           "source": "app/default/fallback-params/[slug]/page.tsx (18:20) @ Inner
         > 18 |   const { slug } = await params
              |                    ^",
           "stack": [
             "Inner app/default/fallback-params/[slug]/page.tsx (18:20)",
             "Page app/default/fallback-params/[slug]/page.tsx (11:9)",
           ],
         }
        `)
      } else {
        const result = await prerenderPage(routeInBuild)
        const error = getPrerenderOutput(result.cliOutput, { isMinified: true })
        expect(error).toMatch(errorPattern.build)
        expect(error).toMatchInlineSnapshot(`
         "Error: Route "/default/fallback-params/[slug]": Next.js encountered uncached or runtime data on a route that must be fully static.

         \`fetch(...)\`, \`cookies()\`, \`headers()\`, \`params\`, \`searchParams\`, or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>
             at Inner (app/default/fallback-params/[slug]/page.tsx:18:20)
             at Page (app/default/fallback-params/[slug]/page.tsx:11:9)
           16 |
           17 | async function Inner({ params }: { params: Promise<Params> }) {
         > 18 |   const { slug } = await params
              |                    ^
           19 |   return <p>Slug: {slug}</p>
           20 | }
           21 |
         To debug the issue, start the app in development mode by running \`next dev\`, then open "/default/fallback-params/[slug]" in your browser to investigate the error.
         Error occurred prerendering page "/default/fallback-params/[slug]". Read more: https://nextjs.org/docs/messages/prerender-error

         > Export encountered errors on 1 path:
         	/default/fallback-params/[slug]/page: /default/fallback-params/[slug]"
        `)
        expect(result.exitCode).toBe(1)
      }
    })

    it('does not allow passing fallback params to a client component despite suspense', async () => {
      // Params passed to a client component cannot be statically prerendered,
      // because the RSC payload is still partial.
      // (it's not the same as a client segment, where the RSC payload is complete)
      const errorPattern = ERROR_PATTERNS.runtimeData
      const routeInDev = '/default/fallback-params-passed-to-client/123'
      const routeInBuild = '/default/fallback-params-passed-to-client/[slug]'
      if (isNextDev) {
        const browser = await next.browser(routeInDev)
        const error = await getCollapsedRedboxErrors(browser)
        expectErrorSnapshotToMatchPattern(error, errorPattern.dev)
        expect(error).toMatchInlineSnapshot(`
         {
           "description": "Route "/default/fallback-params-passed-to-client/[slug]": Next.js encountered runtime data on a route that must be fully static.

         \`cookies()\`, \`headers()\`, \`params\`, or \`searchParams\` prevent the route from being prerendered.

         Ways to fix this:
           - [static] For \`params\`: specify a static set of params to be prerendered using \`generateStaticParams\`
           - [client] For \`params\` and \`searchParams\`: read on the client with \`useParams()\` or \`useSearchParams()\`
         Learn more: <TODO>",
           "environmentLabel": "Server",
           "label": "Console Error",
           "source": "app/default/fallback-params-passed-to-client/[slug]/client.tsx (6:23) @ SlugClient
         > 6 |   const { slug } = use(params)
             |                       ^",
           "stack": [
             "SlugClient app/default/fallback-params-passed-to-client/[slug]/client.tsx (6:23)",
             "Page app/default/fallback-params-passed-to-client/[slug]/page.tsx (12:9)",
           ],
         }
        `)
      } else {
        const result = await prerenderPage(routeInBuild)
        const error = getPrerenderOutput(result.cliOutput, { isMinified: true })
        expect(error).toMatch(errorPattern.build)
        expect(error).toMatchInlineSnapshot(`
         "Error: Route "/default/fallback-params-passed-to-client/[slug]": Next.js encountered uncached or runtime data on a route that must be fully static.

         \`fetch(...)\`, \`cookies()\`, \`headers()\`, \`params\`, \`searchParams\`, or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>
             at SlugClient (app/default/fallback-params-passed-to-client/[slug]/client.tsx:6:23)
             at Page (app/default/fallback-params-passed-to-client/[slug]/page.tsx:12:9)
           4 |
           5 | export function SlugClient({ params }: { params: Promise<{ slug: string }> }) {
         > 6 |   const { slug } = use(params)
             |                       ^
           7 |   return <p>{\`Slug: \${slug}\`}</p>
           8 | }
           9 |
         To debug the issue, start the app in development mode by running \`next dev\`, then open "/default/fallback-params-passed-to-client/[slug]" in your browser to investigate the error.
         Error occurred prerendering page "/default/fallback-params-passed-to-client/[slug]". Read more: https://nextjs.org/docs/messages/prerender-error

         > Export encountered errors on 1 path:
         	/default/fallback-params-passed-to-client/[slug]/page: /default/fallback-params-passed-to-client/[slug]"
        `)
        expect(result.exitCode).toBe(1)
      }
    })

    it('allows using fallback params via `useParams()` in a client segment with suspense', async () => {
      // If fallback params are only accessed in a client segment,
      // then the RSC payload is complete and we'll render the page in the browser.
      // TODO(ensure-static): why is this page marked as partial in the build output
      // if there's no resume render?
      // TODO(ensure-static): make sure HTML requests do not contain the param, i.e.
      // we're not using a resume
      const routeInDev = '/default/fallback-params-client-segment/123'
      const routeInBuild = '/default/fallback-params-client-segment/[slug]'
      if (isNextDev) {
        const browser = await next.browser(routeInDev)
        await expectDevValidationSuccess(browser)
      } else {
        const result = await prerenderPage(routeInBuild)
        expectPrerenderSuccess(result)
      }
    })
  })

  describe('static params', () => {
    // Static params are statically prerenderable, so they're allowed.
    it('allows using static params with suspense', async () => {
      // TODO(ensure-static): test ISR fallback behavior, we should not do those
      const routeInDev = '/default/static-params/123'
      const routeInBuild = '/default/static-params/[slug]'
      if (isNextDev) {
        const browser = await next.browser(routeInDev)
        await expectDevValidationSuccess(browser)
      } else {
        const result = await prerenderPage(routeInBuild)
        expectPrerenderSuccess(result)
      }
    })

    it('allows using static params without suspense', async () => {
      const routeInDev = '/default/static-params-blocking/123'
      const routeInBuild = '/default/static-params-blocking/[slug]'
      if (isNextDev) {
        const browser = await next.browser(routeInDev)
        await expectDevValidationSuccess(browser)
      } else {
        const result = await prerenderPage(routeInBuild)
        expectPrerenderSuccess(result)
      }
    })
  })

  describe('excluded caches', () => {
    it('does not allow using a non-prerenderable cache despite suspense', async () => {
      const errorPattern = ERROR_PATTERNS.runtimeData
      const route = '/default/excluded-caches/non-prerenderable-cache'
      if (isNextDev) {
        const browser = await next.browser(route)
        const error = await getCollapsedRedboxErrors(browser)
        expectErrorSnapshotToMatchPattern(error, errorPattern.dev)
        expect(error).toMatchInlineSnapshot(`
         {
           "description": "Route "/default/excluded-caches/non-prerenderable-cache": Next.js encountered runtime data on a route that must be fully static.

         \`cookies()\`, \`headers()\`, \`params\`, or \`searchParams\` prevent the route from being prerendered.

         Ways to fix this:
           - [static] For \`params\`: specify a static set of params to be prerendered using \`generateStaticParams\`
           - [client] For \`params\` and \`searchParams\`: read on the client with \`useParams()\` or \`useSearchParams()\`
         Learn more: <TODO>",
           "environmentLabel": "Server",
           "label": "Console Error",
           "source": "app/default/excluded-caches/non-prerenderable-cache/page.tsx (17:9) @ Inner
         > 17 |   await nonPrerenderableCache()
              |         ^",
           "stack": [
             "Inner app/default/excluded-caches/non-prerenderable-cache/page.tsx (17:9)",
             "Page app/default/excluded-caches/non-prerenderable-cache/page.tsx (10:9)",
           ],
         }
        `)
      } else {
        const result = await prerenderPage(route)
        const error = getPrerenderOutput(result.cliOutput, { isMinified: true })
        expect(error).toMatch(errorPattern.build)
        expect(error).toMatchInlineSnapshot(`
         "Error: Route "/default/excluded-caches/non-prerenderable-cache": Next.js encountered uncached or runtime data on a route that must be fully static.

         \`fetch(...)\`, \`cookies()\`, \`headers()\`, \`params\`, \`searchParams\`, or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>
             at Inner (app/default/excluded-caches/non-prerenderable-cache/page.tsx:17:9)
             at Page (app/default/excluded-caches/non-prerenderable-cache/page.tsx:10:9)
           15 |
           16 | async function Inner() {
         > 17 |   await nonPrerenderableCache()
              |         ^
           18 |   return <p>Non-prerenderable data</p>
           19 | }
           20 |
         To debug the issue, start the app in development mode by running \`next dev\`, then open "/default/excluded-caches/non-prerenderable-cache" in your browser to investigate the error.
         Error occurred prerendering page "/default/excluded-caches/non-prerenderable-cache". Read more: https://nextjs.org/docs/messages/prerender-error

         > Export encountered errors on 1 path:
         	/default/excluded-caches/non-prerenderable-cache/page: /default/excluded-caches/non-prerenderable-cache"
        `)
        expect(result.exitCode).toBe(1)
      }
    })

    it('allows using a non-shell cache with suspense', async () => {
      const route = '/default/excluded-caches/non-shell-cache'
      if (isNextDev) {
        const browser = await next.browser(route)
        await expectDevValidationSuccess(browser)
      } else {
        const result = await prerenderPage(route)
        expectPrerenderSuccess(result)
      }
    })
  })

  describe('browser bailout', () => {
    it('allows `use(browser())` with suspense', async () => {
      // Browser-only content does not require a resume render,
      // so it's allowed in a fully-static page. It still needs a
      // suspense to not block the root.
      const route = '/default/use-browser'
      if (isNextDev) {
        const browser = await next.browser(route)
        await expectDevValidationSuccess(browser)
      } else {
        const result = await prerenderPage(route)
        expectPrerenderSuccess(result)
      }
    })

    it('[FAILING] allows blocking `use(browser())` with `instant = false`', async () => {
      // Browser-only content does not require a resume render,
      // so it's allowed in a fully-static page.
      // Here, it blocks the root, but that should be allowed due to `instant = false`.
      const route = '/default/instant-false/use-browser-blocking'
      if (isNextDev) {
        const browser = await next.browser(route)

        // The redbox will be closed.
        await openRedbox(browser)
        let errors = await createRedboxSnapshot(browser, next)

        // We should not report any errors related to `ensureStatic`.
        expect(ensureArray(errors)).not.toContain(
          matchAnyStaticRouteValidationErrorSnapshot()
        )

        // FAILING: `instant = false` errors here even though it shouldn't
        errors = removeExpectedError(errors, (err) => {
          return (
            err.label === 'Runtime Error' &&
            err.description.startsWith(
              'The server render could not complete because client rendering was requested outside a Suspense boundary'
            )
          )
        })
        // Instant validation will fail, because the root is blocked in SSR.
        errors = removeExpectedError(errors, (err) => {
          return err.description.startsWith(
            `Route "${route}": Could not validate \`instant\` because an error prevented the target segment from rendering.`
          )
        })

        // There should be no other errors.
        expect(errors).toEqual([])
      } else {
        const result = await prerenderPage(route)

        // FAILING: `instant = false` should allow this
        // expectPrerenderSuccess(result)

        // We should not report any validation errors.
        expect(result.cliOutput).not.toSatisfy((text) =>
          isStaticRouteValidationError('build', text)
        )

        expect(getPrerenderOutput(result.cliOutput, { isMinified: true }))
          .toMatchInlineSnapshot(`
         "Error occurred prerendering page "/default/instant-false/use-browser-blocking". Read more: https://nextjs.org/docs/messages/prerender-error
         Error: The server render could not complete because client rendering was requested outside a Suspense boundary. See this error's cause for additional details.
             at BrowserOnly (app/default/instant-false/use-browser-blocking/client.tsx:7:6)
            5 |
            6 | export function BrowserOnly() {
         >  7 |   use(browser())
              |      ^
            8 |   return <p>Browser-only content</p>
            9 | }
           10 | {
           digest: '<error-digest>'
         }

         > Export encountered errors on 1 path:
         	/default/instant-false/use-browser-blocking/page: /default/instant-false/use-browser-blocking"
        `)
        expect(result.exitCode).toBe(1)
      }
    })

    it('allows blocking `use(browser())` with suspense-above-body', async () => {
      // Browser-only content does not require a resume render,
      // so it's allowed in a fully-static page.
      // Here, it blocks the root, which errors in dev, but we should not
      // show a validation error related to `ensureStatic`.
      const route = '/suspense-above-body/use-browser-blocking'
      if (isNextDev) {
        const browser = await next.browser(route)

        // In SSR, the redbox will be open due to the missing tags error.
        await waitForRedbox(browser)
        let errors = await createRedboxSnapshot(browser, next)

        // We should not report any errors related to `ensureStatic`.
        expect(ensureArray(errors)).not.toContain(
          matchAnyStaticRouteValidationErrorSnapshot()
        )

        // The root layout is blocked, which triggers the "missing tags" error
        // TODO: this seems like a false positive caused by react's "switched to client rendering" HTML?
        errors = removeExpectedError(errors, (err) => {
          return (
            err.label === 'Runtime Error' &&
            err.description.startsWith(
              'Missing <html> and <body> tags in the root layout.'
            )
          )
        })
        // Instant validation will fail, because the root is blocked in SSR.
        errors = removeExpectedError(errors, (err) => {
          return err.description.startsWith(
            `Route "${route}": Could not validate \`instant\` because an error prevented the target segment from rendering.`
          )
        })

        // There should be no other errors.
        expect(errors).toEqual([])
      } else {
        const result = await prerenderPage(route)
        expectPrerenderSuccess(result)
      }
    })
  })

  describe('client IO', () => {
    it('allows `use(io())` with suspense', async () => {
      // Browser-only content does not require a resume render,
      // so it's allowed in a fully-static page. It still needs a
      // suspense to not block the root.
      const route = '/default/use-io'
      if (isNextDev) {
        const browser = await next.browser(route)
        await expectDevValidationSuccess(browser)
      } else {
        const result = await prerenderPage(route)
        expectPrerenderSuccess(result)
      }
    })
    it('does not allow `use(io())` without suspense', async () => {
      // Browser-only content does not require a resume render,
      // so it's allowed in a fully-static page. It still needs a
      // suspense to not block the root.
      const errorPattern = ERROR_PATTERNS.uncachedDataClientOnly
      const route = '/default/blocking-use-io'
      if (isNextDev) {
        const browser = await next.browser(route)
        const error = await getCollapsedRedboxErrors(browser)
        expectErrorSnapshotToMatchPattern(error, errorPattern.dev)
        expect(error).toMatchInlineSnapshot(`
         {
           "description": "Next.js encountered uncached data during prerendering.",
           "environmentLabel": "Server",
           "label": "Blocking Route",
           "source": "app/default/blocking-use-io/client.tsx (6:6) @ ClientIO
         > 6 |   use(io())
             |      ^",
           "stack": [
             "ClientIO app/default/blocking-use-io/client.tsx (6:6)",
             "Page app/default/blocking-use-io/page.tsx (15:7)",
           ],
         }
        `)
      } else {
        const result = await prerenderPage(route)
        const error = getPrerenderOutput(result.cliOutput, {
          isMinified: true,
        })
        expect(error).toMatch(errorPattern.build)
        expect(error).toMatchInlineSnapshot(`
         "Error: Route "/default/blocking-use-io": Next.js encountered uncached or runtime data during prerendering.

         \`fetch(...)\`, \`cookies()\`, \`headers()\`, \`params\`, \`searchParams\`, or \`connection()\` accessed outside of \`<Suspense>\` prevents the route from being prerendered, blocking the page load and leading to a slower user experience.

         Ways to fix this:
           - [stream] Provide a placeholder with \`<Suspense fallback={...}>\` around the data access
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
           - [block] Set \`export const instant = false\` to allow a blocking route

         Learn more: https://nextjs.org/docs/messages/blocking-prerender-dynamic
             at ClientIO (app/default/blocking-use-io/client.tsx:6:6)
             at Page (app/default/blocking-use-io/page.tsx:15:7)
           4 |
           5 | export function ClientIO() {
         > 6 |   use(io())
             |      ^
           7 |   return <p>{\`Client dynamic data\`}</p>
           8 | }
           9 |
         To debug the issue, start the app in development mode by running \`next dev\`, then open "/default/blocking-use-io" in your browser to investigate the error.
         Error occurred prerendering page "/default/blocking-use-io". Read more: https://nextjs.org/docs/messages/prerender-error

         > Export encountered errors on 1 path:
         	/default/blocking-use-io/page: /default/blocking-use-io"
        `)
        expect(result.exitCode).toBe(1)
      }
    })
  })

  describe('mixed server and client holes', () => {
    it('does not allow using `connection()` when the page also has an allowed browser bailout', async () => {
      const errorPattern = ERROR_PATTERNS.uncachedData
      const route = '/default/mixed-server-client/connection-and-browser'
      if (isNextDev) {
        const browser = await next.browser(route)
        const error = await getCollapsedRedboxErrors(browser)
        expectErrorSnapshotToMatchPattern(error, errorPattern.dev)
        expect(error).toMatchInlineSnapshot(`
         {
           "description": "Route "/default/mixed-server-client/connection-and-browser": Next.js encountered uncached data on a route that must be fully static.

         \`fetch(...)\` or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>",
           "environmentLabel": "Server",
           "label": "Console Error",
           "source": "app/default/mixed-server-client/connection-and-browser/page.tsx (21:19) @ Inner
         > 21 |   await connection()
              |                   ^",
           "stack": [
             "Inner app/default/mixed-server-client/connection-and-browser/page.tsx (21:19)",
             "Page app/default/mixed-server-client/connection-and-browser/page.tsx (14:9)",
           ],
         }
        `)
      } else {
        const result = await prerenderPage(route)
        const error = getPrerenderOutput(result.cliOutput, { isMinified: true })
        expect(error).toMatch(errorPattern.build)
        expect(error).toMatchInlineSnapshot(`
         "Error: Route "/default/mixed-server-client/connection-and-browser": Next.js encountered uncached or runtime data on a route that must be fully static.

         \`fetch(...)\`, \`cookies()\`, \`headers()\`, \`params\`, \`searchParams\`, or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>
             at Inner (app/default/mixed-server-client/connection-and-browser/page.tsx:21:19)
             at Page (app/default/mixed-server-client/connection-and-browser/page.tsx:14:9)
           19 |
           20 | async function Inner() {
         > 21 |   await connection()
              |                   ^
           22 |   return <p>Dynamic data</p>
           23 | }
           24 |
         To debug the issue, start the app in development mode by running \`next dev\`, then open "/default/mixed-server-client/connection-and-browser" in your browser to investigate the error.
         Error occurred prerendering page "/default/mixed-server-client/connection-and-browser". Read more: https://nextjs.org/docs/messages/prerender-error

         > Export encountered errors on 1 path:
         	/default/mixed-server-client/connection-and-browser/page: /default/mixed-server-client/connection-and-browser"
        `)
        expect(result.exitCode).toBe(1)
      }
    })

    it('does not allow using `connection()` when the page also has an allowed `useSearchParams()`', async () => {
      const errorPattern = ERROR_PATTERNS.uncachedData
      const route =
        '/default/mixed-server-client/connection-and-use-search-params'
      if (isNextDev) {
        const browser = await next.browser(route)
        const error = await getCollapsedRedboxErrors(browser)
        expectErrorSnapshotToMatchPattern(error, errorPattern.dev)
        expect(error).toMatchInlineSnapshot(`
         {
           "description": "Route "/default/mixed-server-client/connection-and-use-search-params": Next.js encountered uncached data on a route that must be fully static.

         \`fetch(...)\` or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>",
           "environmentLabel": "Server",
           "label": "Console Error",
           "source": "app/default/mixed-server-client/connection-and-use-search-params/page.tsx (21:19) @ Inner
         > 21 |   await connection()
              |                   ^",
           "stack": [
             "Inner app/default/mixed-server-client/connection-and-use-search-params/page.tsx (21:19)",
             "Page app/default/mixed-server-client/connection-and-use-search-params/page.tsx (14:9)",
           ],
         }
        `)
      } else {
        const result = await prerenderPage(route)
        const error = getPrerenderOutput(result.cliOutput, { isMinified: true })
        expect(error).toMatch(errorPattern.build)
        expect(error).toMatchInlineSnapshot(`
         "Error: Route "/default/mixed-server-client/connection-and-use-search-params": Next.js encountered uncached or runtime data on a route that must be fully static.

         \`fetch(...)\`, \`cookies()\`, \`headers()\`, \`params\`, \`searchParams\`, or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>
             at Inner (app/default/mixed-server-client/connection-and-use-search-params/page.tsx:21:19)
             at Page (app/default/mixed-server-client/connection-and-use-search-params/page.tsx:14:9)
           19 |
           20 | async function Inner() {
         > 21 |   await connection()
              |                   ^
           22 |   return <p>Dynamic data</p>
           23 | }
           24 |
         To debug the issue, start the app in development mode by running \`next dev\`, then open "/default/mixed-server-client/connection-and-use-search-params" in your browser to investigate the error.
         Error occurred prerendering page "/default/mixed-server-client/connection-and-use-search-params". Read more: https://nextjs.org/docs/messages/prerender-error

         > Export encountered errors on 1 path:
         	/default/mixed-server-client/connection-and-use-search-params/page: /default/mixed-server-client/connection-and-use-search-params"
        `)
        expect(result.exitCode).toBe(1)
      }
    })

    it('does not allow using `connection()` when the page also has an allowed `use(params)`', async () => {
      // TODO(ensure-static): `use(params)` in the client segment is being
      // misreported as a server hole even though it's allowed, so we get
      // two errors instead of one.
      // This happens because `use(params)` is not filtered out by
      // `isClientHookDynamicError` like `useParams` is.

      const errorPattern = ERROR_PATTERNS.uncachedData
      const routeInDev =
        '/default/mixed-server-client/connection-and-client-params/123'
      const routeInBuild =
        '/default/mixed-server-client/connection-and-client-params/[slug]'
      if (isNextDev) {
        const browser = await next.browser(routeInDev)
        const error = await getCollapsedRedboxErrors(browser)

        // (deliberately not using `expectErrorSnapshotToMatchPattern`, which only
        // checks inclusion)
        expect(error).toEqual([
          matchErrorSnapshot(errorPattern.dev),
          matchErrorSnapshot(errorPattern.dev),
        ])

        expect(error).toMatchInlineSnapshot(`
         [
           {
             "description": "Route "/default/mixed-server-client/connection-and-client-params/[slug]": Next.js encountered uncached data on a route that must be fully static.

         \`fetch(...)\` or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>",
             "environmentLabel": "Server",
             "label": "Console Error",
             "source": "app/default/mixed-server-client/connection-and-client-params/[slug]/page.tsx (17:23) @ Slug
         > 17 |   const { slug } = use(params)
              |                       ^",
             "stack": [
               "Slug app/default/mixed-server-client/connection-and-client-params/[slug]/page.tsx (17:23)",
               "Page app/default/mixed-server-client/connection-and-client-params/[slug]/page.tsx (10:9)",
             ],
           },
           {
             "description": "Route "/default/mixed-server-client/connection-and-client-params/[slug]": Next.js encountered uncached data on a route that must be fully static.

         \`fetch(...)\` or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>",
             "environmentLabel": "Server",
             "label": "Console Error",
             "source": "app/default/mixed-server-client/connection-and-client-params/[slug]/layout.tsx (21:19) @ Inner
         > 21 |   await connection()
              |                   ^",
             "stack": [
               "Inner app/default/mixed-server-client/connection-and-client-params/[slug]/layout.tsx (21:19)",
               "Layout app/default/mixed-server-client/connection-and-client-params/[slug]/layout.tsx (11:11)",
             ],
           },
         ]
        `)
      } else {
        const result = await prerenderPage(routeInBuild)
        const error = getPrerenderOutput(result.cliOutput, { isMinified: true })
        expect(error).toMatch(errorPattern.build)
        expect(error).toMatchInlineSnapshot(`
         "Error: Route "/default/mixed-server-client/connection-and-client-params/[slug]": Next.js encountered uncached or runtime data on a route that must be fully static.

         \`fetch(...)\`, \`cookies()\`, \`headers()\`, \`params\`, \`searchParams\`, or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>
             at Inner (app/default/mixed-server-client/connection-and-client-params/[slug]/layout.tsx:21:19)
             at Layout (app/default/mixed-server-client/connection-and-client-params/[slug]/layout.tsx:11:11)
           19 |
           20 | async function Inner() {
         > 21 |   await connection()
              |                   ^
           22 |   return <p>Dynamic data</p>
           23 | }
           24 |
         To debug the issue, start the app in development mode by running \`next dev\`, then open "/default/mixed-server-client/connection-and-client-params/[slug]" in your browser to investigate the error.
         Error: Route "/default/mixed-server-client/connection-and-client-params/[slug]": Next.js encountered uncached or runtime data on a route that must be fully static.

         \`fetch(...)\`, \`cookies()\`, \`headers()\`, \`params\`, \`searchParams\`, or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>
             at Slug (app/default/mixed-server-client/connection-and-client-params/[slug]/page.tsx:17:23)
             at Page (app/default/mixed-server-client/connection-and-client-params/[slug]/page.tsx:10:9)
           15 |
           16 | function Slug({ params }: { params: Promise<Params> }) {
         > 17 |   const { slug } = use(params)
              |                       ^
           18 |   return <p>{\`Slug: \${slug}\`}</p>
           19 | }
           20 |
         To debug the issue, start the app in development mode by running \`next dev\`, then open "/default/mixed-server-client/connection-and-client-params/[slug]" in your browser to investigate the error.
         Error occurred prerendering page "/default/mixed-server-client/connection-and-client-params/[slug]". Read more: https://nextjs.org/docs/messages/prerender-error

         > Export encountered errors on 1 path:
         	/default/mixed-server-client/connection-and-client-params/[slug]/page: /default/mixed-server-client/connection-and-client-params/[slug]"
        `)
        expect(result.exitCode).toBe(1)
      }
    })

    it('does not allow using `connection()` when the page also has an allowed `use(io())`', async () => {
      // TODO(ensure-static): `use(io())` in the client segment is being
      // misreported as a server hole even though it's allowed, so we get
      // two errors instead of one.
      // This happens because `use(io())` is not filtered out by
      // `isClientHookDynamicError` like `useParams` is.

      const errorPattern = ERROR_PATTERNS.uncachedData
      const route = '/default/mixed-server-client/connection-and-use-io'
      if (isNextDev) {
        const browser = await next.browser(route)
        const error = await getCollapsedRedboxErrors(browser)

        // (deliberately not using `expectErrorSnapshotToMatchPattern`, which only
        // checks inclusion)
        expect(error).toEqual([
          matchErrorSnapshot(errorPattern.dev),
          matchErrorSnapshot(errorPattern.dev),
        ])

        expect(error).toMatchInlineSnapshot(`
         [
           {
             "description": "Route "/default/mixed-server-client/connection-and-use-io": Next.js encountered uncached data on a route that must be fully static.

         \`fetch(...)\` or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>",
             "environmentLabel": "Server",
             "label": "Console Error",
             "source": "app/default/mixed-server-client/connection-and-use-io/client.tsx (6:6) @ ClientIO
         > 6 |   use(io())
             |      ^",
             "stack": [
               "ClientIO app/default/mixed-server-client/connection-and-use-io/client.tsx (6:6)",
               "Page app/default/mixed-server-client/connection-and-use-io/page.tsx (11:9)",
             ],
           },
           {
             "description": "Route "/default/mixed-server-client/connection-and-use-io": Next.js encountered uncached data on a route that must be fully static.

         \`fetch(...)\` or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>",
             "environmentLabel": "Server",
             "label": "Console Error",
             "source": "app/default/mixed-server-client/connection-and-use-io/page.tsx (21:19) @ Inner
         > 21 |   await connection()
              |                   ^",
             "stack": [
               "Inner app/default/mixed-server-client/connection-and-use-io/page.tsx (21:19)",
               "Page app/default/mixed-server-client/connection-and-use-io/page.tsx (14:9)",
             ],
           },
         ]
        `)
      } else {
        const result = await prerenderPage(route)
        const error = getPrerenderOutput(result.cliOutput, { isMinified: true })
        expect(error).toMatch(errorPattern.build)
        expect(error).toMatchInlineSnapshot(`
         "Error: Route "/default/mixed-server-client/connection-and-use-io": Next.js encountered uncached or runtime data on a route that must be fully static.

         \`fetch(...)\`, \`cookies()\`, \`headers()\`, \`params\`, \`searchParams\`, or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>
             at Inner (app/default/mixed-server-client/connection-and-use-io/page.tsx:21:19)
             at Page (app/default/mixed-server-client/connection-and-use-io/page.tsx:14:9)
           19 |
           20 | async function Inner() {
         > 21 |   await connection()
              |                   ^
           22 |   return <p>Dynamic data</p>
           23 | }
           24 |
         To debug the issue, start the app in development mode by running \`next dev\`, then open "/default/mixed-server-client/connection-and-use-io" in your browser to investigate the error.
         Error: Route "/default/mixed-server-client/connection-and-use-io": Next.js encountered uncached or runtime data on a route that must be fully static.

         \`fetch(...)\`, \`cookies()\`, \`headers()\`, \`params\`, \`searchParams\`, or \`connection()\` prevents the route from being prerendered.

         Ways to fix this:
           - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)
         Learn more: <TODO>
             at ClientIO (app/default/mixed-server-client/connection-and-use-io/client.tsx:6:6)
             at Page (app/default/mixed-server-client/connection-and-use-io/page.tsx:11:9)
           4 |
           5 | export function ClientIO() {
         > 6 |   use(io())
             |      ^
           7 |   return <p>{\`Client dynamic data\`}</p>
           8 | }
           9 |
         To debug the issue, start the app in development mode by running \`next dev\`, then open "/default/mixed-server-client/connection-and-use-io" in your browser to investigate the error.
         Error occurred prerendering page "/default/mixed-server-client/connection-and-use-io". Read more: https://nextjs.org/docs/messages/prerender-error

         > Export encountered errors on 1 path:
         	/default/mixed-server-client/connection-and-use-io/page: /default/mixed-server-client/connection-and-use-io"
        `)
        expect(result.exitCode).toBe(1)
      }
    })
  })
})

function ensureArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value]
}

function removeExpectedError(
  errors: RedboxSnapshot,
  shouldRemove: (error: ErrorSnapshot) => boolean
): ErrorSnapshot[] {
  if (!Array.isArray(errors)) {
    throw new Error('Expected to receive multiple errors to filter')
  }
  let found = false
  const result = errors.filter((err) => {
    if (shouldRemove(err)) {
      found = true
      return false
    } else {
      return true
    }
  })
  if (!found) {
    throw new Error(
      `Did not find expected error in errors array: ${JSON.stringify(errors, null, 2)}`
    )
  }
  return result
}
