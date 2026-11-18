import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-1.5 py-0.5 text-micro font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary/14 text-primary ring-1 ring-primary/25 ring-inset",
        secondary: "bg-surface-3 text-secondary-foreground ring-1 ring-border ring-inset",
        outline: "border-border-strong text-muted-foreground",
        success: "bg-success/12 text-success ring-1 ring-success/25 ring-inset",
        live: "bg-live/12 text-live ring-1 ring-live/25 ring-inset",
        warning: "bg-warning/14 text-warning ring-1 ring-warning/30 ring-inset",
        critical: "bg-critical/12 text-critical ring-1 ring-critical/30 ring-inset",
        destructive: "bg-critical/12 text-critical ring-1 ring-critical/30 ring-inset",
        info: "bg-info/12 text-info ring-1 ring-info/25 ring-inset",
        ghost: "text-muted-foreground hover:bg-surface-3",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "secondary",
    },
  }
)

function Badge({
  className,
  variant = "secondary",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
