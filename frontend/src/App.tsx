import { useState } from "react"
import { NotificationProvider } from "@/components/notification-provider"
import { Notice } from "@/components/ui/notice"
import { StudentReportPage, SubmittedCodePage, LabReportPage } from "@/pages/reports-page"
import { LoadingStatus } from "@/components/loading-state"
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router"

import { AuthProvider, useAuth } from "@/components/auth-provider"
import { WorkspaceLayout } from "@/components/workspace-layout"
import { Button } from "@/components/ui/button"
import { supabase } from "@/lib/supabase"
import { LoginPage } from "@/pages/login-page"
import { CoursesPage, CoursePage, CreateCoursePage } from "@/pages/courses-page"
import { LabPage } from "@/pages/lab-page"
import { UploadLabPage } from "@/pages/upload-lab-page"

function RequireAccount() {
  const auth = useAuth()
  const [signOutError, setSignOutError] = useState("")
  const location = useLocation()

  if (auth.loading) return <LoadingStatus className="min-h-svh justify-center p-6">Loading account…</LoadingStatus>

  if (auth.needsLogin) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname }}
      />
    )
  }

  if (auth.error || !auth.profile) {
    return (
      <section className="space-y-4 p-6">
        <Notice tone="error" title="Your account could not be loaded">{auth.error || "Unable to load your profile."}</Notice>
        {signOutError && <Notice tone="error" title="Could not sign out">{signOutError}</Notice>}
        <Button onClick={auth.reloadProfile}>Retry profile</Button>
        <Button
          variant="outline"
          onClick={async () => {
            setSignOutError("")
            try { const { error } = await supabase.auth.signOut(); if (error) setSignOutError(error.message) }
            catch { setSignOutError("Please try signing out again.") }
          }}
        >
          Sign out
        </Button>
      </section>
    )
  }

  return <Outlet key={auth.profile.id} />
}

function TeacherOnly() {
  const { profile } = useAuth()
  return profile?.role === "teacher"
    ? <Outlet />
    : <Navigate to="/courses" replace />
}

function LoginRoute() {
  const auth = useAuth()
  const location = useLocation()
  const requestedPath = location.state?.from
  const destination =
    typeof requestedPath === "string" &&
    requestedPath.startsWith("/") &&
    !requestedPath.startsWith("//") &&
    requestedPath !== "/login"
      ? requestedPath
      : "/courses"

  if (auth.loading) return <LoadingStatus className="min-h-svh justify-center p-6">Loading account…</LoadingStatus>

  if (auth.profile) return <Navigate to={destination} replace />

  // Send authenticated accounts to the profile error/retry screen.
  if (!auth.needsLogin) return <Navigate to="/courses" replace />

  return <LoginPage />
}

export default function App() {
  return (
    <AuthProvider>
      <NotificationProvider>
      <Routes>
        <Route path="/login" element={<LoginRoute />} />

        <Route element={<RequireAccount />}>
          <Route element={<WorkspaceLayout />}>
            <Route index element={<Navigate to="/courses" replace />} />
            <Route path="/dashboard" element={<Navigate to="/courses" replace />} />
            <Route path="/labs" element={<Navigate to="/courses" replace />} />
            <Route path="/courses" element={<CoursesPage />} />
            <Route path="/courses/:courseId" element={<CoursePage />} />
            <Route path="/courses/:courseId/labs/:id" element={<LabPage />} />
            <Route path="/labs/:id" element={<LabPage />} />

            <Route element={<TeacherOnly />}>
              <Route path="/courses/:courseId/students/:studentId/report" element={<StudentReportPage />} />
              <Route path="/submissions/:submissionId" element={<SubmittedCodePage />} />
              <Route path="/labs/:id/report" element={<LabReportPage />} />
              <Route path="/labs/new" element={<Navigate to="/courses" replace />} />
              <Route path="/courses/new" element={<CreateCoursePage />} />
              <Route path="/courses/:courseId/labs/new" element={<UploadLabPage />} />
            </Route>

            <Route path="*" element={<p className="p-6">Page not found.</p>} />
          </Route>
        </Route>
      </Routes>
      </NotificationProvider>
    </AuthProvider>
  )
}