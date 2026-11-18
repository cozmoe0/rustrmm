import { Skeleton } from '@/components/ui/skeleton'

/** Shown while a route's code or data loads for longer than a moment. */
export function PagePending() {
  return (
    <div className="mx-auto grid w-full max-w-[1440px] gap-5 px-4 py-6 sm:px-6" aria-busy="true" aria-label="Loading">
      <div className="grid gap-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-6 w-64" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  )
}
