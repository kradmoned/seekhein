import { TeacherLabOverview } from '@/pages/teacher-lab-overview'
import { ExecutionOutput } from "@/components/execution-output"
import { Notice } from "@/components/ui/notice"
import { useNotifications } from "@/hooks/use-notifications"
import { configureEditorThemes } from "@/lib/editor-theme"
import { WorkspaceIcon } from "@/components/workspace-icon"
import { LabRules } from "@/components/lab-rules"
import { ResizableSplit } from "@/components/ui/resizable"
import { Link } from "react-router"
import type { OnMount } from "@monaco-editor/react"
import { installIntegrityGuard, labDetail } from "@/lib/integrity"
import { createTelemetry } from "@/lib/telemetry"
import { execution } from "@/lib/submission-contract"
import { useSubmissions } from "@/hooks/use-submissions"
import { SubmissionControls } from "@/components/submission-controls"
import { LabSkeleton, LoadingStatus } from "@/components/loading-state"
import { Spinner } from "@/components/ui/spinner"
import { useTheme } from "@/lib/theme";
import { useEffect, useState, useRef } from "react";
import { useParams, useSearchParams } from "react-router";
import Editor from "@monaco-editor/react";
import Markdown from "react-markdown";

import { api } from "@/lib/api";
import type { LabDetail, RunResult } from "@/lib/types";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";

import { draftKey as makeDraftKey, readDraft, writeDraft, validateCode } from "@/lib/workspace";

export function LabPage() {
  const { id = "", courseId } = useParams();
  const [params] = useSearchParams();
  const labPath = courseId ? `/courses/${courseId}/labs/${id}` : `/labs/${id}`;
  const { profile } = useAuth();

  if (profile?.role === 'teacher' && params.get('view') !== 'preview') {
    return <TeacherLabOverview key={`${profile.id}:${id}`} id={id} courseId={courseId} labPath={labPath} />
  }
  return (
    <LabWorkspace key={`${profile!.id}:${profile!.role}:${id}`} id={id} userId={profile!.id} labPath={labPath} />
  );
}

function LabWorkspace({ id, userId, labPath }: { id: string; userId: string; labPath: string }) {
  const theme = useTheme();
  const { profile } = useAuth();
  const student = profile?.role === 'student';
  const submission = useSubmissions(userId, id, student);
  const wrapper = useRef<HTMLDivElement>(null);
  const guard = useRef<ReturnType<typeof installIntegrityGuard> | null>(null);
  const telemetry = useRef<ReturnType<typeof createTelemetry> | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [submissionDetailsOpen, setSubmissionDetailsOpen] = useState(false);
  const { notify, dismiss } = useNotifications();
  const integrityNoticeId = `integrity:${userId}:${id}`;
  useEffect(() => () => dismiss(integrityNoticeId), [dismiss, integrityNoticeId]);
  const [telemetryWarning, setTelemetryWarning] = useState('');
  useEffect(() => () => { guard.current?.dispose(); telemetry.current?.dispose(); }, []);
  const draftKey = student ? makeDraftKey(userId, id) : `teacher-preview:${userId}:${id}`;
  const runController = useRef<AbortController | null>(null);
  useEffect(() => () => runController.current?.abort(), []);
  const [lab, setLab] = useState<LabDetail | null>(null);
  const [code, setCode] = useState("");
  const [loadError, setLoadError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [serviceError, setServiceError] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [submittedCode, setSubmittedCode] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api<unknown>(`/api/labs/${encodeURIComponent(id)}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        const data = labDetail(value);
        let initialCode = data.starter;

        try {
          initialCode = readDraft(draftKey, data.starter, localStorage);
        } catch {
          setStorageError(
            "Browser storage is unavailable. Draft changes may be lost on reload.",
          );
        }

        setCode(initialCode);
        setLab(data);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setLoadError(error.message);
      });

    return () => controller.abort();
  }, [id, draftKey, attempt]);

  function updateCode(value: string) {
    setCode(value);

    try {
      writeDraft(draftKey, value, localStorage);
      setStorageError("");
    } catch {
      setStorageError(
        "Unable to save this draft locally. Copy your code before leaving.",
      );
    }
  }

  const mountEditor: OnMount = (editor) => {
    guard.current?.dispose(); telemetry.current?.dispose(); telemetry.current = null;
    if (!lab || !wrapper.current) return;
    if (student) telemetry.current = createTelemetry(userId, id, lab.integrity_policy, setTelemetryWarning);
    guard.current = installIntegrityGuard(editor, wrapper.current, student ? lab.integrity_policy : null,
      (type, payload) => telemetry.current?.emit(type, payload), message => notify('Editor action blocked', message, 'warning', integrityNoticeId), updateCode);
    updateCode(guard.current.getAcceptedCode());
    setEditorReady(true);
  };
  function showFinalResult(value: RunResult, snapshot: string) {
    setResult(value); setSubmittedCode(snapshot); setServiceError('');
  }
  async function runCode() {
    if (runController.current || !guard.current || submission.busy) return;
    const snapshot = guard.current.getAcceptedCode();
    setServiceError("");

    const validation = validateCode(snapshot);
    if (validation) { setServiceError(validation); return; }
    const body = JSON.stringify({ code: snapshot });
    const controller = new AbortController();
    runController.current = controller;
    setRunning(true);
    setResult(null);
    setSubmittedCode(snapshot);

    try {
      if (student) { telemetry.current?.emit('run'); await telemetry.current?.flush(); }
      if (controller.signal.aborted) return;
      const response = execution(await api<unknown>(`/api/labs/${encodeURIComponent(id)}/run`, {
        signal: controller.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }));
      if (!controller.signal.aborted) setResult(response);
    } catch (error) {
      if (controller.signal.aborted) return;
      setServiceError(
        error instanceof Error ? error.message : "Execution request failed.",
      );
    } finally {
      runController.current = null;
      if (!controller.signal.aborted) setRunning(false);
    }
  }

  if (loadError) {
    return (
      <section className="space-y-3 p-6">
        <Notice tone="error" title="Lab could not be loaded">{loadError}</Notice>
        <Button onClick={() => { setLoadError(""); setAttempt((value) => value + 1); }}>
          Try again
        </Button>
      </section>
    );
  }

  if (!lab)
    return (
      <LabSkeleton />
    );

  const output = (
    <ExecutionOutput result={result} busy={running || submission.busy || !!serviceError} stale={code !== submittedCode} onClear={() => setResult(null)}>
        {student && submission.message && <Notice tone={submission.messageTone} title={submission.messageTitle}
          actions={!submission.busy && (submission.pending.length > 0 || submission.statusError || submission.storageError) ? <Button size="sm" variant="outline" onClick={() => setSubmissionDetailsOpen(true)}>Review submission</Button> : undefined}>{submission.message}</Notice>}
        {student && !submission.message && !submission.busy && (submission.statusError || submission.storageError || submission.pending.length > 0) &&
          <Notice tone={submission.pending.length ? 'warning' : 'error'} title={submission.pending.length ? 'Pending submission' : 'Submission needs attention'}
            actions={<Button size="sm" variant="outline" onClick={() => setSubmissionDetailsOpen(true)}>Review submission</Button>}>
            {submission.pending.length ? 'A saved request still needs recovery. Your original code is preserved.' : 'Open submission details to check the problem and retry.'}
          </Notice>}
        {running && (
          <LoadingStatus>Running your code. This may take more than 30 seconds.</LoadingStatus>
        )}

        {serviceError && (
          <Notice tone="error" title="Code could not be run" actions={<Button size="sm" variant="outline" disabled={running || submission.busy || !editorReady} onClick={runCode}>Retry run</Button>}>{serviceError}</Notice>
        )}

    </ExecutionOutput>
  );

  const editor = (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-card" aria-label="Python editor">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2">
        <h2 className="flex items-center gap-2 font-mono text-sm"><WorkspaceIcon name="code" className="text-primary" />starter.py</h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" className="rounded-md" onClick={runCode} disabled={running || submission.busy || !editorReady}>
            {running ? <Spinner /> : <WorkspaceIcon name="play" />}{running ? "Running…" : "Run code"}
          </Button>
          {student && <SubmissionControls offerSubmitAnyway={!!result && !(result.status === 'ok' && result.total > 0 && result.passed === result.total)} submission={submission} code={code} editorReady={editorReady} runBusy={running}
            getCode={() => guard.current!.getAcceptedCode()} flush={() => telemetry.current?.flush() ?? Promise.resolve()} onResult={showFinalResult}
            open={submissionDetailsOpen} onOpenChange={setSubmissionDetailsOpen} />}
        </div>
      </header>
      <div ref={wrapper} className="min-h-0 flex-1">
        <Editor
          loading={<LoadingStatus>Loading Python editor…</LoadingStatus>}
          height="100%"
          path={`${userId}/${id}/starter.py`}
          language="python"
          theme={theme === "dark" ? "seekhein-dark" : "seekhein-light"}
          beforeMount={configureEditorThemes}
          defaultValue={code}
          onMount={mountEditor}
          options={{
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 15,
            lineHeight: 24,
            padding: { top: 16, bottom: 16 },
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            renderLineHighlight: "all",
            tabSize: 4,
            scrollBeyondLastLine: false,
            ariaLabel: "Editable Python starter code",
          }}
        />
      </div>
      <footer className="flex min-h-8 shrink-0 flex-wrap items-center justify-between gap-x-3 border-t px-4 py-1 text-xs text-muted-foreground">
        <span>Python</span><span>{!editorReady ? 'Loading editor…' : storageError ? 'Draft not saved to this device' : 'Draft saved on this device'}</span>
      </footer>
    </section>
  );

  return (
    <section className="flex min-h-full flex-col gap-1 p-1 lg:h-full lg:min-h-0 lg:overflow-hidden">
      {!student && <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3"><div><p className="font-medium">Teacher preview</p><p className="text-xs text-muted-foreground">Test the lab without submitting a student attempt. Changes here do not edit the published starter code.</p></div><Link className="text-sm font-medium underline" to={labPath}>Back to lab management</Link></header>}
      {telemetryWarning && <Notice tone="warning" title="Activity sync needs attention" className="shrink-0">{telemetryWarning}</Notice>}
      {storageError && <Notice tone="error" title="Draft is not saved on this device" className="shrink-0">{storageError}</Notice>}
      <ResizableSplit className="lg:flex-1" desktopOnly defaultSize={38} minFirst={220} minSecond={360} label="Resize instructions and workspace"
        first={<section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-card">
          <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2"><h1 className="text-base font-medium leading-snug">{lab.title}</h1>{student && <LabRules policy={lab.integrity_policy} />}</header>
          <article className="lab-markdown min-h-0 max-h-[32dvh] flex-1 overflow-auto p-5 lg:max-h-none" tabIndex={0} aria-label="Lab instructions"><Markdown skipHtml>{lab.instructions}</Markdown></article>
        </section>}
        second={<ResizableSplit className="h-[75dvh] min-h-[440px] lg:h-full lg:min-h-0" direction="vertical" defaultSize={72} minFirst={160} minSecond={100} label="Resize code and output" first={editor} second={output} />}
      />
    </section>
  );
}
