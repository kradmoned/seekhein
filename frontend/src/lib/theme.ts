import { useSyncExternalStore } from 'react'

type Theme = 'light' | 'dark'
const key = 'seekhein:theme'
const system = window.matchMedia('(prefers-color-scheme: dark)')
let preference: Theme | null = null
try {
  const saved = localStorage.getItem(key)
  if (saved === 'dark' || saved === 'light') preference = saved
} catch { /* Theme still works in memory when storage is unavailable. */ }
let current: Theme = preference ?? (system.matches ? 'dark' : 'light')
const listeners = new Set<() => void>()
function apply() {
  document.documentElement.classList.toggle('dark', current === 'dark')
  document.documentElement.style.colorScheme = current
  listeners.forEach(listener => listener())
}
apply()
system.addEventListener('change', () => {
  if (!preference) { current = system.matches ? 'dark' : 'light'; apply() }
})
window.addEventListener('storage', event => {
  if (event.key !== key && event.key !== null) return
  preference = event.newValue === 'dark' || event.newValue === 'light' ? event.newValue : null
  current = preference ?? (system.matches ? 'dark' : 'light')
  apply()
})
export function toggleTheme() {
  current = current === 'dark' ? 'light' : 'dark'
  preference = current
  try { localStorage.setItem(key, current) } catch { /* Keep the current tab usable. */ }
  apply()
}
export function useTheme() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => current)
}
