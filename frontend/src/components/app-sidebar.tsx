import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { useState } from "react";
import { Link, useLocation } from "react-router";
import { useAuth } from "@/components/auth-provider";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { WorkspaceIcon } from "@/components/workspace-icon";

export function AppSidebar() {
  const { profile } = useAuth();
  const { setOpenMobile } = useSidebar();
  const { pathname } = useLocation();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const name = profile?.full_name || profile?.email || "Account";
  const initials = (profile?.full_name || profile?.email || "S")
    .split(/[\s@]+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  const items = [
    { to: "/courses", label: "My courses", icon: "book" as const },
    ...(profile?.role === "teacher"
      ? [{ to: "/courses/new", label: "Create course", icon: "add" as const }]
      : []),
  ];
  return (
    <Sidebar>
      <SidebarHeader className="gap-0 px-5 py-6">
        <Link
          to="/courses"
          onClick={() => setOpenMobile(false)}
          className="flex items-center gap-3 rounded-lg"
        >
          <span
            className="flex size-9 items-center justify-center rounded-lg border border-border bg-card font-mono text-base text-primary"
            aria-hidden="true"
          >
            s_
          </span>
          <span>
            <span className="block text-xl font-semibold leading-6">
              Seekhein<span className="text-primary">.</span>
            </span>
            <span className="block text-xs text-muted-foreground">
              Python learning workspace
            </span>
          </span>
        </Link>
      </SidebarHeader>
      <SidebarContent className="px-3 pt-3">
        <p className="mb-2 px-3 text-xs font-medium text-muted-foreground">
          {profile?.role === "teacher" ? "Teaching" : "Learning"}
        </p>
        <nav aria-label="Workspace navigation" className="space-y-1">
          {items.map((item) => {
            const active =
              item.to === "/courses"
                ? pathname !== "/courses/new"
                : pathname === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => setOpenMobile(false)}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-10 items-center gap-3 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${active ? "border-border bg-sidebar-accent text-sidebar-accent-foreground" : "border-transparent text-sidebar-foreground hover:bg-muted"}`}
              >
                <WorkspaceIcon name={item.icon} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </SidebarContent>
      <SidebarFooter className="gap-4 border-t p-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-card text-xs font-medium"
            aria-hidden="true"
          >
            {initials}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium" title={name}>
              {name}
            </p>
            <p className="text-xs capitalize text-muted-foreground">
              {profile?.role} account
            </p>
          </div>
        </div>
        {error && (
          <Notice tone="error" title="Could not sign out">
            {error}
          </Notice>
        )}
        <Button
          variant="outline"
          className="justify-start gap-3"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            setError("");
            try {
              const { error } = await supabase.auth.signOut();
              if (error) setError(error.message);
            } catch {
              setError("Unable to sign out. Try again.");
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? <Spinner /> : <WorkspaceIcon name="logout" />}
          {pending ? "Signing out…" : "Sign out"}
        </Button>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
