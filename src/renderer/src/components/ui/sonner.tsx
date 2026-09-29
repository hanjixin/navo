import { Toaster as Sonner } from 'sonner'
import { useTheme } from '@/hooks/use-theme'

export function Toaster() {
  const theme = useTheme()
  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: '!rounded-lg !border !border-border !bg-popover !text-popover-foreground !shadow-float !text-sm !font-sans',
          description: '!text-muted-foreground',
          error: '[&_[data-icon]]:!text-danger',
          success: '[&_[data-icon]]:!text-success',
        },
      }}
    />
  )
}
