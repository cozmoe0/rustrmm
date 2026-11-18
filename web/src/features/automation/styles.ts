/**
 * Segmented controls (ToggleGroup) sit on cards and inside dialogs whose surface matches the default
 * pressed fill, so the active segment gets a stronger, explicit treatment here.
 */
export const SEGMENTED =
  '[&_[aria-pressed=true]]:bg-surface-4 [&_[aria-pressed=true]]:text-foreground [&_[aria-pressed=true]]:shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]'
