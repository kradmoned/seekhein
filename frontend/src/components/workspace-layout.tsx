import { Link, Outlet, useMatch, useLocation } from 'react-router'
import { ThemeToggle } from '@/components/theme-toggle'
import { AppSidebar } from '@/components/app-sidebar'
import { WorkspaceIcon } from '@/components/workspace-icon'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'

export function WorkspaceLayout() {
  const courseLab = useMatch('/courses/:courseId/labs/:id')
  const standaloneLab = useMatch('/labs/:id')
  const { pathname } = useLocation()
  const isLab = Boolean(courseLab || standaloneLab)
  const context = pathname.includes('/report') ? 'Reports' : pathname.startsWith('/submissions/') ? 'Submitted code' : isLab ? 'Python lab' : pathname === '/courses/new' ? 'Create course' : 'Courses'
  return <SidebarProvider className="md:h-dvh md:overflow-hidden">
    <a href="#main-content" className="skip-link">Skip to main content</a>
    <AppSidebar />
    <SidebarInset className="min-w-0 bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4">
        <SidebarTrigger />
        <span className="h-5 w-px bg-border" aria-hidden="true" />
        {isLab ? <Link to={courseLab ? `/courses/${courseLab.params.courseId}` : '/courses'} className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"><WorkspaceIcon name="back" />{courseLab ? 'Back to course' : 'All courses'}</Link> : <span className="text-sm font-medium">{context}</span>}
        {isLab && <span className="hidden text-sm text-muted-foreground sm:inline">/ {context}</span>}
        <div className="ml-auto"><ThemeToggle /></div>
      </header>
      <main id="main-content" tabIndex={-1} className="min-h-0 min-w-0 flex-1 outline-none md:overflow-auto"><Outlet /></main>
    </SidebarInset>
  </SidebarProvider>
}
