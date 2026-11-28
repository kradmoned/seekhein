import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from "react"
import { supabase } from "@/lib/supabase"
import { api } from "@/lib/api"
import type { Profile } from "@/lib/types"

type AuthState = {
  profile: Profile | null
  loading: boolean
  needsLogin: boolean
  error: string
  reloadProfile: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const identity = useRef<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [initialized, setInitialized] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [needsLogin, setNeedsLogin] = useState(false)
  const [error, setError] = useState("")
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        const nextId = session?.user.id ?? null
        if (identity.current !== nextId) setProfile(null)
        identity.current = nextId
        setUserId(nextId)
        setInitialized(true)

        if (event === "SIGNED_IN") {
          setNeedsLogin(false)
        }
      },
    )

    function requireLogin() {
      setNeedsLogin(true)
      setProfile(null)
    }

    window.addEventListener("session-required", requireLogin)

    return () => {
      subscription.unsubscribe()
      window.removeEventListener("session-required", requireLogin)
    }
  }, [])

  useEffect(() => {
    if (!initialized) return

    const controller = new AbortController()
    setProfile(null)
    setError("")

    if (!userId || needsLogin) {
      setLoading(false)
      return
    }

    setLoading(true)

    api<Profile>("/api/me", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted && value.id === userId) setProfile(value)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setError(error instanceof Error ? error.message : "Unable to load profile.")
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [initialized, userId, needsLogin, version])

  return (
    <AuthContext.Provider
      value={{
        profile: profile?.id === userId ? profile : null,
        loading,
        needsLogin: needsLogin || (initialized && !userId),
        error,
        reloadProfile: () => setVersion((current) => current + 1),
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error("useAuth must be inside AuthProvider.")
  return auth
}