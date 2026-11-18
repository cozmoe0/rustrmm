import { Suspense, lazy } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { CodeEditorProps } from './code-editor-impl'

export type { CodeEditorProps, EditorLanguage } from './code-editor-impl'

// CodeMirror and its language packs load in their own chunk the first time an editor renders.
const CodeEditorImpl = lazy(() => import('./code-editor-impl'))

function EditorFallback({ height, className }: { height?: string; className?: string }) {
  return (
    <div
      className={cn('flex gap-3 bg-surface-1 p-3', className)}
      style={{ height: height ?? '480px' }}
      aria-busy="true"
      aria-label="Loading editor"
    >
      <div className="grid w-8 grid-cols-1 content-start gap-2.5 pt-1">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-2.5 w-5" />
        ))}
      </div>
      <div className="grid flex-1 grid-cols-1 content-start gap-2.5 pt-1">
        {[72, 54, 88, 40, 66, 30, 80, 48].map((width, index) => (
          <Skeleton key={index} className="h-2.5" style={{ width: `${width}%` }} />
        ))}
      </div>
    </div>
  )
}

export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense fallback={<EditorFallback height={props.height} className={props.className} />}>
      <CodeEditorImpl {...props} />
    </Suspense>
  )
}
