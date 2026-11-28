import { Notice } from "@/components/ui/notice"
import { Spinner } from "@/components/ui/spinner"
import { useState, type ComponentProps, type FormEvent } from "react";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export function LoginForm({ className, ...props }: ComponentProps<"div">) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        console.error("Supabase sign-in failed", {
          code: error.code,
          status: error.status,
          message: error.message,
        });
        setErrorMessage(error.message);
      }
    } catch (error) {
      console.error("Unexpected sign-in error", error);
      setErrorMessage("Could not sign in. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }
  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card className="border shadow-sm ring-0 dark:shadow-none">
        <CardHeader>
          <CardTitle><h1 className="text-2xl font-semibold">Sign in to Seekhein</h1></CardTitle>
          <CardDescription>
            Use your institution account to open your courses.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  placeholder="you@school.edu"
                  required
                />
              </Field>
              <Field>
                <div className="flex items-center">
                  <FieldLabel htmlFor="password">Password</FieldLabel>

                </div>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </Field>
              <Field>
                {errorMessage && (
                  <Notice tone="error" title="Could not sign in">{errorMessage}</Notice>
                )}

                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting && <Spinner />}{isSubmitting ? "Signing in…" : "Sign in"}
                </Button>
                <FieldDescription className="text-center">Accounts are provided by your institution. Contact your teacher for access.</FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
