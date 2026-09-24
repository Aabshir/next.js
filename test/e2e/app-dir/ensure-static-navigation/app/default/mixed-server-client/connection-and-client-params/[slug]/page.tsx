'use client'
import { Suspense, use } from 'react'

type Params = { slug: string }

export default function Page({ params }: { params: Promise<Params> }) {
  return (
    <main>
      <Suspense fallback={<p>Loading...</p>}>
        <Slug params={params} />
      </Suspense>
    </main>
  )
}

function Slug({ params }: { params: Promise<Params> }) {
  const { slug } = use(params)
  return <p>{`Slug: ${slug}`}</p>
}
