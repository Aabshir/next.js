import { type ReactNode, Suspense } from 'react'
import { connection } from 'next/server'

export const unstable_ensureStatic = 'navigation'

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <div>
        <Suspense fallback={<p>Loading...</p>}>
          <Inner />
        </Suspense>
      </div>
      <hr />
      {children}
    </>
  )
}

async function Inner() {
  await connection()
  return <p>Dynamic data</p>
}
