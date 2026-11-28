import { Button } from '@/components/ui/button'
import { toggleTheme, useTheme } from '@/lib/theme'

export function ThemeToggle() {
  const theme = useTheme()
  const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`
  return <Button variant="ghost" size="sm" className="shrink-0 rounded-lg" onClick={toggleTheme} aria-label={label} title={label}>
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {theme === 'dark' ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></> : <path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z" />}
    </svg>
    <span className="hidden sm:inline">{theme === 'dark' ? 'Light' : 'Dark'} mode</span>
  </Button>
}
