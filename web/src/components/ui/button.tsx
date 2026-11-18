import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const buttonVariants = cva(
  "group/button relative inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-(--ease-snappy) outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/25 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_1px_2px_rgb(0_0_0/0.22)] hover:bg-[color-mix(in_oklch,var(--primary),white_9%)] dark:hover:bg-[color-mix(in_oklch,var(--primary),white_12%)]",
        outline:
          "border-border-strong bg-surface-1 text-foreground shadow-[0_1px_1px_rgb(0_0_0/0.04)] hover:bg-surface-3 aria-expanded:bg-surface-3 dark:bg-white/[0.02] dark:hover:bg-white/[0.06]",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-surface-4 aria-expanded:bg-surface-4",
        ghost:
          "text-muted-foreground hover:bg-surface-3 hover:text-foreground aria-expanded:bg-surface-3 aria-expanded:text-foreground",
        destructive:
          "bg-destructive text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] hover:bg-[color-mix(in_oklch,var(--destructive),black_8%)] dark:text-[oklch(0.18_0.03_20)] dark:hover:bg-[color-mix(in_oklch,var(--destructive),white_10%)]",
        "destructive-soft":
          "bg-destructive/10 text-destructive hover:bg-destructive/18 dark:bg-destructive/15 dark:hover:bg-destructive/25",
        link: "h-auto px-0 text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-(--control-h) gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-md px-2.5 text-dense has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-2 px-4 text-sm has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-(--control-h)",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-7 rounded-md",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
