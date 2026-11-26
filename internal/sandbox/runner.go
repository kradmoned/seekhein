package sandbox

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
)

const (
	maxRawHarnessStdoutBytes = 256 * 1024
	maxRawHarnessStderrBytes = 32 * 1024
)

// Runner executes untrusted student Python code and hidden test suites inside
// isolated Docker containers.
type Runner interface {
	Run(ctx context.Context, req RunRequest) (*RunResult, error)
	ValidateLab(ctx context.Context, solutionCode, testCode string) (*ValidationResult, error)
	Close() error
}

type runner struct {
	cfg Config
	cli dockerAPI
	sem chan struct{}
}

// NewRunner creates a Docker-backed Runner and fails fast if Docker Ping or
// sandbox image inspection fails.
func NewRunner(ctx context.Context, cfg Config) (Runner, error) {
	cfg = cfg.withDefaults()
	if err := cfg.validate(); err != nil {
		return nil, err
	}

	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("%w: failed to create docker client: %v", ErrSandboxUnavailable, err)
	}

	r, err := newRunnerWithClient(ctx, cfg, &sdkDockerClient{cli: cli})
	if err != nil {
		_ = cli.Close()
		return nil, err
	}
	return r, nil
}

func newRunnerWithClient(ctx context.Context, cfg Config, cli dockerAPI) (*runner, error) {
	cfg = cfg.withDefaults()
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	if cli == nil {
		return nil, fmt.Errorf("%w: nil docker client", ErrSandboxUnavailable)
	}

	pingCtx, cancelPing := context.WithTimeout(ctx, 5*time.Second)
	defer cancelPing()
	if _, err := cli.Ping(pingCtx); err != nil {
		return nil, fmt.Errorf("%w: docker daemon ping failed: %v", ErrSandboxUnavailable, err)
	}

	inspectCtx, cancelInspect := context.WithTimeout(ctx, 5*time.Second)
	defer cancelInspect()
	if _, err := cli.ImageInspect(inspectCtx, cfg.Image); err != nil {
		return nil, fmt.Errorf("%w: sandbox image %q not found (build with 'make sandbox-image'): %v", ErrSandboxUnavailable, cfg.Image, err)
	}

	return &runner{
		cfg: cfg,
		cli: cli,
		sem: make(chan struct{}, cfg.MaxConcurrent),
	}, nil
}

func (r *runner) Close() error {
	if r.cli == nil {
		return nil
	}
	return r.cli.Close()
}

type harnessInputPayload struct {
	Code               string  `json:"code"`
	Tests              string  `json:"tests"`
	PerTestTimeoutSec  float64 `json:"per_test_timeout_sec"`
	MaxStdoutBytes     int     `json:"max_stdout_bytes"`
	MaxTestStdoutBytes int     `json:"max_test_stdout_bytes"`
}

func (r *runner) Run(ctx context.Context, req RunRequest) (*RunResult, error) {
	if len(req.Code) > r.cfg.MaxCodeBytes {
		return nil, fmt.Errorf("%w: %d bytes > %d max", ErrCodeTooLarge, len(req.Code), r.cfg.MaxCodeBytes)
	}
	if len(req.Tests) > r.cfg.MaxTestsBytes {
		return nil, fmt.Errorf("%w: %d bytes > %d max", ErrTestsTooLarge, len(req.Tests), r.cfg.MaxTestsBytes)
	}

	perTestTimeout := req.PerTestTimeout
	if perTestTimeout <= 0 {
		perTestTimeout = r.cfg.PerTestTimeout
	}
	if perTestTimeout > r.cfg.ContainerTimeout {
		perTestTimeout = r.cfg.ContainerTimeout
	}

	if err := r.acquireSlot(ctx); err != nil {
		return nil, err
	}
	defer r.releaseSlot()

	start := time.Now()
	runCtx, cancel := context.WithTimeout(ctx, r.cfg.ContainerTimeout)
	defer cancel()

	pidsLimit := r.cfg.PidsLimit
	containerCfg := &container.Config{
		Image:           r.cfg.Image,
		User:            "1000:1000",
		OpenStdin:       true,
		StdinOnce:       true,
		AttachStdin:     true,
		AttachStdout:    true,
		AttachStderr:    true,
		Tty:             false,
		NetworkDisabled: true,
	}
	hostCfg := &container.HostConfig{
		NetworkMode:    "none",
		ReadonlyRootfs: true,
		Tmpfs: map[string]string{
			"/work": "rw,noexec,nosuid,size=8m,mode=1777",
			"/tmp":  "rw,noexec,nosuid,size=4m,mode=1777",
		},
		CapDrop:     []string{"ALL"},
		SecurityOpt: []string{"no-new-privileges:true"},
		AutoRemove:  false,
		Resources: container.Resources{
			Memory:     r.cfg.MemoryLimitBytes,
			MemorySwap: r.cfg.MemoryLimitBytes,
			NanoCPUs:   r.cfg.NanoCPUs,
			PidsLimit:  &pidsLimit,
		},
	}

	created, err := r.cli.ContainerCreate(runCtx, containerCfg, hostCfg, nil, nil, "")
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("%w: container create failed: %v", ErrSandboxUnavailable, err)
	}

	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_ = r.cli.ContainerRemove(cleanupCtx, created.ID, container.RemoveOptions{Force: true})
	}()

	attach, err := r.cli.ContainerAttach(runCtx, created.ID, container.AttachOptions{
		Stream: true,
		Stdin:  true,
		Stdout: true,
		Stderr: true,
	})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("%w: container attach failed: %v", ErrSandboxUnavailable, err)
	}
	defer attach.Close()

	stdoutBuf := newLimitedBuffer(maxRawHarnessStdoutBytes)
	stderrBuf := newLimitedBuffer(maxRawHarnessStderrBytes)
	demuxErrCh := make(chan error, 1)
	go func() {
		_, copyErr := stdcopy.StdCopy(stdoutBuf, stderrBuf, attach.Reader)
		demuxErrCh <- copyErr
	}()

	if err := r.cli.ContainerStart(runCtx, created.ID, container.StartOptions{}); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("%w: container start failed: %v", ErrSandboxUnavailable, err)
	}

	payloadBytes, err := json.Marshal(harnessInputPayload{
		Code:               req.Code,
		Tests:              req.Tests,
		PerTestTimeoutSec:  perTestTimeout.Seconds(),
		MaxStdoutBytes:     r.cfg.MaxStdoutBytes,
		MaxTestStdoutBytes: r.cfg.MaxTestStdoutBytes,
	})
	if err != nil {
		return nil, fmt.Errorf("sandbox: marshal harness payload: %w", err)
	}
	if _, err := attach.Conn.Write(payloadBytes); err != nil {
		// Container may have already died (e.g. OOM or immediate exit); proceed to wait/inspect.
		_ = err
	}
	_ = attach.CloseWrite()

	// Wait after ContainerStart: calling WaitConditionNotRunning on a newly created
	// ("created") container returns immediately before the container starts.
	waitCh, waitErrCh := r.cli.ContainerWait(runCtx, created.ID, container.WaitConditionNotRunning)

	var exitCode int64 = -1
	select {
	case waitRes := <-waitCh:
		exitCode = waitRes.StatusCode
	case wErr := <-waitErrCh:
		if wErr != nil {
			if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
				attach.Close()
				return timeoutResult(time.Since(start)), nil
			}
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return &RunResult{
				Status:        StatusInternalErr,
				DurationMs:    time.Since(start).Milliseconds(),
				Tests:         []TestResult{},
				InternalError: fmt.Sprintf("container wait error: %v", wErr),
			}, nil
		}
	case <-runCtx.Done():
		attach.Close()
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
			return timeoutResult(time.Since(start)), nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return timeoutResult(time.Since(start)), nil
	}

	// Wait briefly for stdcopy to drain remaining stream data after container exit.
	select {
	case <-demuxErrCh:
	case <-time.After(1 * time.Second):
		attach.Close()
	}

	inspectCtx, inspectCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer inspectCancel()
	inspected, inspectErr := r.cli.ContainerInspect(inspectCtx, created.ID)
	elapsed := time.Since(start)
	if inspectErr == nil && inspected.State != nil {
		if inspected.State.OOMKilled {
			return oomResult(elapsed), nil
		}
		if exitCode < 0 {
			exitCode = int64(inspected.State.ExitCode)
		}
	}

	rawOut := bytes.TrimSpace(stdoutBuf.Bytes())
	if len(rawOut) == 0 {
		if exitCode == 137 {
			return oomResult(elapsed), nil
		}
		return &RunResult{
			Status:        StatusInternalErr,
			DurationMs:    elapsed.Milliseconds(),
			Tests:         []TestResult{},
			InternalError: fmt.Sprintf("sandbox exited with code %d and no output; stderr: %s", exitCode, strings.TrimSpace(stderrBuf.String())),
		}, nil
	}

	res, parseErr := parseHarnessOutput(rawOut)
	if parseErr != nil {
		if exitCode == 137 {
			return oomResult(elapsed), nil
		}
		return &RunResult{
			Status:        StatusInternalErr,
			DurationMs:    elapsed.Milliseconds(),
			Tests:         []TestResult{},
			InternalError: fmt.Sprintf("invalid harness output (%v); stderr: %s", parseErr, strings.TrimSpace(stderrBuf.String())),
		}, nil
	}
	if res.DurationMs == 0 {
		res.DurationMs = elapsed.Milliseconds()
	}
	return res, nil
}

func (r *runner) acquireSlot(ctx context.Context) error {
	select {
	case r.sem <- struct{}{}:
		return nil
	default:
	}

	timer := time.NewTimer(r.cfg.QueueWaitTimeout)
	defer timer.Stop()

	select {
	case r.sem <- struct{}{}:
		return nil
	case <-timer.C:
		return ErrQueueFull
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *runner) releaseSlot() {
	<-r.sem
}

func timeoutResult(elapsed time.Duration) *RunResult {
	return &RunResult{
		Status:        StatusTimeout,
		Score:         0,
		DurationMs:    elapsed.Milliseconds(),
		Tests:         []TestResult{},
		InternalError: "container execution exceeded hard timeout",
	}
}

func oomResult(elapsed time.Duration) *RunResult {
	return &RunResult{
		Status:        StatusOOM,
		Score:         0,
		DurationMs:    elapsed.Milliseconds(),
		Tests:         []TestResult{},
		InternalError: "container exceeded memory limit (OOMKilled)",
	}
}

func (r *runner) ValidateLab(ctx context.Context, solutionCode, testCode string) (*ValidationResult, error) {
	res, err := r.Run(ctx, RunRequest{
		Code:  solutionCode,
		Tests: testCode,
	})
	if err != nil {
		return nil, err
	}

	vr := &ValidationResult{
		Status:      res.Status,
		DurationMs:  res.DurationMs,
		TotalTests:  res.Total,
		RanTests:    res.Ran,
		PassedTests: res.Passed,
		FailedTests: res.Failed,
		Stdout:      res.Stdout,
		Tests:       make([]TeacherTestDiagnostic, 0, len(res.Tests)),
	}

	if res.SyntaxError != nil {
		vr.SyntaxError = &TeacherSyntaxError{
			Source:       res.SyntaxError.Source,
			ErrorType:    res.SyntaxError.ErrorType,
			ErrorMessage: res.SyntaxError.ErrorMessage,
			Line:         res.SyntaxError.Line,
			CodeLine:     res.SyntaxError.CodeLine,
		}
	}

	slowThresholdMs := r.cfg.PerTestTimeout.Milliseconds() / 2
	var slowTests []string
	var unlabeledTests []string
	seenUnlabeled := make(map[string]struct{})

	for _, t := range res.Tests {
		if !t.hasDocstring {
			baseName := baseMethodName(t.Name)
			if _, ok := seenUnlabeled[baseName]; !ok {
				seenUnlabeled[baseName] = struct{}{}
				unlabeledTests = append(unlabeledTests, baseName)
			}
		}
		if slowThresholdMs > 0 && t.DurationMs > slowThresholdMs {
			slowTests = append(slowTests, fmt.Sprintf("%s (%dms)", t.Name, t.DurationMs))
		}

		vr.Tests = append(vr.Tests, TeacherTestDiagnostic{
			Index:         t.Index,
			Name:          t.Name,
			DisplayName:   t.DisplayName,
			Status:        t.Status,
			Passed:        t.Passed,
			Inputs:        t.Inputs,
			Expected:      t.Expected,
			Actual:        t.Actual,
			ErrorType:     t.ErrorType,
			ErrorMessage:  t.ErrorMessage,
			FullTraceback: t.Detail,
			Stdout:        t.Stdout,
			DurationMs:    t.DurationMs,
		})
	}

	switch {
	case res.Status != StatusOK:
		vr.Valid = false
		if vr.SyntaxError != nil {
			vr.Summary = fmt.Sprintf("%s in %s at line %d: %s", vr.SyntaxError.ErrorType, vr.SyntaxError.Source, vr.SyntaxError.Line, vr.SyntaxError.ErrorMessage)
		} else if res.InternalError != "" {
			vr.Summary = fmt.Sprintf("lab execution failed (%s): %s", res.Status, firstLine(res.InternalError))
		} else {
			vr.Summary = fmt.Sprintf("lab execution failed with status %s", res.Status)
		}
	case res.Total < 1:
		vr.Valid = false
		vr.Summary = "lab must define at least 1 unittest.TestCase test method"
	case res.Passed != res.Total:
		vr.Valid = false
		vr.Summary = fmt.Sprintf("%d of %d tests failed against reference solution", res.Failed, res.Total)
	default:
		vr.Valid = true
		vr.Summary = fmt.Sprintf("All %d tests passed against reference solution", res.Total)
	}

	if len(slowTests) > 0 {
		vr.Warnings = append(vr.Warnings, fmt.Sprintf("slow reference test(s) exceeding 50%% of %s timeout: %s", r.cfg.PerTestTimeout, strings.Join(slowTests, ", ")))
	}
	if len(unlabeledTests) > 0 {
		vr.Warnings = append(vr.Warnings, fmt.Sprintf("test method(s) lack a docstring label: %s", strings.Join(unlabeledTests, ", ")))
	}

	return vr, nil
}

func baseMethodName(name string) string {
	if idx := strings.IndexByte(name, '['); idx >= 0 {
		return name[:idx]
	}
	return name
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if idx := strings.IndexByte(s, '\n'); idx >= 0 {
		return s[:idx]
	}
	return s
}

type harnessSyntaxErrorWire struct {
	Source       string `json:"source"`
	ErrorType    string `json:"error_type"`
	ErrorMessage string `json:"error_message"`
	Line         int    `json:"line"`
	CodeLine     string `json:"code_line"`
}

type harnessTestResultWire struct {
	Index           int          `json:"index"`
	Name            string       `json:"name"`
	DisplayName     string       `json:"display_name"`
	Status          TestStatus   `json:"status"`
	Passed          bool         `json:"passed"`
	Inputs          string       `json:"inputs"`
	Expected        string       `json:"expected"`
	Actual          string       `json:"actual"`
	ErrorType       string       `json:"error_type"`
	ErrorMessage    string       `json:"error_message"`
	Traceback       []TraceFrame `json:"traceback"`
	Stdout          string       `json:"stdout"`
	StdoutTruncated bool         `json:"stdout_truncated"`
	DurationMs      int64        `json:"duration_ms"`
	Detail          string       `json:"detail"`
	HasDocstring    bool         `json:"has_docstring"`
}

type harnessOutputWire struct {
	Status          RunStatus               `json:"status"`
	Score           int                     `json:"score"`
	Ran             int                     `json:"ran"`
	Passed          int                     `json:"passed"`
	Failed          int                     `json:"failed"`
	Total           int                     `json:"total"`
	Stdout          string                  `json:"stdout"`
	StdoutTruncated bool                    `json:"stdout_truncated"`
	DurationMs      int64                   `json:"duration_ms"`
	Tests           []harnessTestResultWire `json:"tests"`
	SyntaxError     *harnessSyntaxErrorWire `json:"syntax_error"`
	InternalError   string                  `json:"internal_error"`
}

func parseHarnessOutput(raw []byte) (*RunResult, error) {
	// If multiple lines exist (unexpected), decode the last JSON line cleanly.
	if idx := bytes.LastIndexByte(raw, '\n'); idx >= 0 {
		last := bytes.TrimSpace(raw[idx+1:])
		if len(last) > 0 && last[0] == '{' {
			raw = last
		}
	}

	var wire harnessOutputWire
	if err := json.Unmarshal(raw, &wire); err != nil {
		return nil, err
	}
	if wire.Status == "" {
		return nil, errors.New("missing status field")
	}

	res := &RunResult{
		Status:          wire.Status,
		Score:           wire.Score,
		Ran:             wire.Ran,
		Passed:          wire.Passed,
		Failed:          wire.Failed,
		Total:           wire.Total,
		Stdout:          wire.Stdout,
		StdoutTruncated: wire.StdoutTruncated,
		DurationMs:      wire.DurationMs,
		Tests:           make([]TestResult, 0, len(wire.Tests)),
		InternalError:   wire.InternalError,
	}
	if wire.SyntaxError != nil {
		res.SyntaxError = &SyntaxErrorInfo{
			Source:       wire.SyntaxError.Source,
			ErrorType:    wire.SyntaxError.ErrorType,
			ErrorMessage: wire.SyntaxError.ErrorMessage,
			Line:         wire.SyntaxError.Line,
			CodeLine:     wire.SyntaxError.CodeLine,
		}
	}
	for _, t := range wire.Tests {
		res.Tests = append(res.Tests, TestResult{
			Index:           t.Index,
			Name:            t.Name,
			DisplayName:     t.DisplayName,
			Status:          t.Status,
			Passed:          t.Passed,
			Inputs:          t.Inputs,
			Expected:        t.Expected,
			Actual:          t.Actual,
			ErrorType:       t.ErrorType,
			ErrorMessage:    t.ErrorMessage,
			Traceback:       t.Traceback,
			Stdout:          t.Stdout,
			StdoutTruncated: t.StdoutTruncated,
			DurationMs:      t.DurationMs,
			Detail:          t.Detail,
			hasDocstring:    t.HasDocstring,
		})
	}
	return res, nil
}

// limitedBuffer captures up to maxBytes without failing subsequent writes,
// preventing rogue container output from OOMing the Go API process.
type limitedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
	max int
}

func newLimitedBuffer(max int) *limitedBuffer {
	return &limitedBuffer{max: max}
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.max <= 0 {
		return len(p), nil
	}
	rem := l.max - l.buf.Len()
	if rem > 0 {
		toWrite := p
		if len(toWrite) > rem {
			toWrite = toWrite[:rem]
		}
		_, _ = l.buf.Write(toWrite)
	}
	return len(p), nil
}

func (l *limitedBuffer) Bytes() []byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]byte, l.buf.Len())
	copy(out, l.buf.Bytes())
	return out
}

func (l *limitedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

var _ io.Writer = (*limitedBuffer)(nil)
