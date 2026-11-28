import { ThemeToggle } from '@/components/theme-toggle'
import { LoginForm } from '@/components/login-form'
import { WorkspaceIcon } from '@/components/workspace-icon'

export function LoginPage() {
  return <main className="flex min-h-svh flex-col">
    <header className="flex h-20 items-center justify-between px-6 sm:px-10"><span className="flex items-center gap-3 text-xl font-semibold"><span className="font-mono text-primary" aria-hidden="true">s_</span>Seekhein</span><ThemeToggle /></header>
    <div className="mx-auto grid w-full max-w-5xl flex-1 items-center gap-12 px-6 py-12 md:grid-cols-2 md:gap-20">
      <section className="hidden space-y-6 md:block"><p className="font-mono text-sm text-primary">{'{ learn by doing }'}</p><h2 className="max-w-md text-4xl font-medium leading-tight sm:text-5xl">A little practice.<br />A better programmer.</h2><p className="max-w-md text-base leading-7 text-muted-foreground">Open your course, work through a Python lab, and see how your code performs. One problem at a time.</p>
        <ol className="space-y-4 border-t pt-6 text-sm">{[{ icon: 'book' as const, text: 'Read the task and examples' }, { icon: 'code' as const, text: 'Write code and run the tests' }, { icon: 'check' as const, text: 'Submit when you are ready' }].map(item => <li key={item.text} className="flex items-center gap-3"><WorkspaceIcon name={item.icon} className="text-muted-foreground" />{item.text}</li>)}</ol>
      </section>
      <LoginForm className="w-full" />
    </div>
    <footer className="px-6 py-6 text-center text-xs text-muted-foreground">Your courses. Your code. Your next step.</footer>
  </main>
}
