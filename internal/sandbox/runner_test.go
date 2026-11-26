package sandbox

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

// --- Mock Docker Client ---

type mockHijackedConn struct {
	mu          sync.Mutex
	written     bytes.Buffer
	closed      bool
	closeNotify chan struct{}
}

func newMockHijackedConn() *mockHijackedConn {
	return &mockHijackedConn{closeNotify: make(chan struct{})}
}

func (m *mockHijackedConn) Read(_ []byte) (int, error) { return 0, io.EOF }
func (m *mockHijackedConn) Write(p []byte) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.written.Write(p)
}
func (m *mockHijackedConn) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.closed {
		m.closed = true
		close(m.closeNotify)
	}
	return nil
}
func (m *mockHijackedConn) LocalAddr() net.Addr                { return nil }
func (m *mockHijackedConn) RemoteAddr() net.Addr               { return nil }
func (m *mockHijackedConn) SetDeadline(_ time.Time) error      { return nil }
func (m *mockHijackedConn) SetReadDeadline(_ time.Time) error  { return nil }
func (m *mockHijackedConn) SetWriteDeadline(_ time.Time) error { return nil }
func (m *mockHijackedConn) WrittenBytes() []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := make([]byte, m.written.Len())
	copy(cp, m.written.Bytes())
	return cp
}

type mockDockerAPI struct {
	pingErr       error
	inspectImgErr error
	createErr     error
	attachErr     error
	startErr      error

	mu               sync.Mutex
	lastCfg          *container.Config
	lastHostCfg      *container.HostConfig
	removedIDs       []string
	started          bool
	waitedAfterStart bool
	createdCounter   atomic.Int64
	activeContainers atomic.Int64
	maxObservedConc  atomic.Int64

	onStart func(ctx context.Context, id string, stdin []byte) (stdout []byte, stderr []byte, exitCode int64, oomKilled bool, waitErr error)
	waitDelay time.Duration
	stdinConn *mockHijackedConn
	streamPr  *io.PipeReader
	streamPw  *io.PipeWriter
}

func newMockDockerAPI() *mockDockerAPI {
	return &mockDockerAPI{}
}

func (m *mockDockerAPI) Ping(_ context.Context) (types.Ping, error) {
	return types.Ping{}, m.pingErr
}

func (m *mockDockerAPI) ImageInspect(_ context.Context, _ string, _ ...client.ImageInspectOption) (image.InspectResponse, error) {
	return image.InspectResponse{}, m.inspectImgErr
}

func (m *mockDockerAPI) ContainerCreate(_ context.Context, cfg *container.Config, hostCfg *container.HostConfig, _ *network.NetworkingConfig, _ *ocispec.Platform, _ string) (container.CreateResponse, error) {
	if m.createErr != nil {
		return container.CreateResponse{}, m.createErr
	}
	n := m.createdCounter.Add(1)
	m.mu.Lock()
	m.lastCfg = cfg
	m.lastHostCfg = hostCfg
	m.started = false
	m.waitedAfterStart = false
	m.stdinConn = newMockHijackedConn()
	m.streamPr, m.streamPw = io.Pipe()
	m.mu.Unlock()

	cur := m.activeContainers.Add(1)
	for {
		prev := m.maxObservedConc.Load()
		if cur <= prev || m.maxObservedConc.CompareAndSwap(prev, cur) {
			break
		}
	}
	return container.CreateResponse{ID: "ctr-" + string(rune('0'+n))}, nil
}

func (m *mockDockerAPI) ContainerAttach(_ context.Context, _ string, _ container.AttachOptions) (types.HijackedResponse, error) {
	if m.attachErr != nil {
		return types.HijackedResponse{}, m.attachErr
	}
	m.mu.Lock()
	conn := m.stdinConn
	pr := m.streamPr
	m.mu.Unlock()
	return types.HijackedResponse{
		Conn:   conn,
		Reader: bufio.NewReader(pr),
	}, nil
}

func (m *mockDockerAPI) ContainerStart(_ context.Context, _ string, _ container.StartOptions) error {
	if m.startErr != nil {
		return m.startErr
	}
	m.mu.Lock()
	m.started = true
	m.mu.Unlock()
	return nil
}

func (m *mockDockerAPI) ContainerWait(ctx context.Context, id string, _ container.WaitCondition) (<-chan container.WaitResponse, <-chan error) {
	resCh := make(chan container.WaitResponse, 1)
	errCh := make(chan error, 1)

	m.mu.Lock()
	started := m.started
	m.waitedAfterStart = started
	conn := m.stdinConn
	pw := m.streamPw
	onStart := m.onStart
	delay := m.waitDelay
	m.mu.Unlock()

	if !started {
		// Mirror real Docker WaitConditionNotRunning: returns immediately if container hasn't started yet.
		resCh <- container.WaitResponse{StatusCode: 0}
		return resCh, errCh
	}

	go func() {
		defer pw.Close()

		// Wait briefly for stdin write + CloseWrite.
		select {
		case <-conn.closeNotify:
		case <-ctx.Done():
			errCh <- ctx.Err()
			return
		case <-time.After(500 * time.Millisecond):
		}

		if delay > 0 {
			select {
			case <-time.After(delay):
			case <-ctx.Done():
				errCh <- ctx.Err()
				return
			}
		}

		if onStart != nil {
			out, errOut, code, _, wErr := onStart(ctx, id, conn.WrittenBytes())
			if len(out) > 0 {
				_, _ = pw.Write(frameDockerStream(1, out))
			}
			if len(errOut) > 0 {
				_, _ = pw.Write(frameDockerStream(2, errOut))
			}
			if wErr != nil {
				errCh <- wErr
				return
			}
			resCh <- container.WaitResponse{StatusCode: code}
			return
		}
		resCh <- container.WaitResponse{StatusCode: 0}
	}()

	return resCh, errCh
}

func (m *mockDockerAPI) ContainerInspect(_ context.Context, id string) (container.InspectResponse, error) {
	m.mu.Lock()
	conn := m.stdinConn
	onStart := m.onStart
	m.mu.Unlock()

	var oom bool
	var code int
	if onStart != nil {
		_, _, exitCode, oomFlag, _ := onStart(context.Background(), id, conn.WrittenBytes())
		oom = oomFlag
		code = int(exitCode)
	}
	return container.InspectResponse{
		ContainerJSONBase: &container.ContainerJSONBase{
			State: &container.State{
				OOMKilled: oom,
				ExitCode:  code,
			},
		},
	}, nil
}

func (m *mockDockerAPI) ContainerRemove(_ context.Context, containerID string, _ container.RemoveOptions) error {
	m.activeContainers.Add(-1)
	m.mu.Lock()
	m.removedIDs = append(m.removedIDs, containerID)
	m.mu.Unlock()
	return nil
}

func (m *mockDockerAPI) Close() error { return nil }

func frameDockerStream(streamType byte, data []byte) []byte {
	hdr := make([]byte, 8)
	hdr[0] = streamType
	binary.BigEndian.PutUint32(hdr[4:8], uint32(len(data)))
	return append(hdr, data...)
}

// --- Unit Tests ---

func TestNewRunnerFailFast(t *testing.T) {
	t.Run("ping failure", func(t *testing.T) {
		cli := newMockDockerAPI()
		cli.pingErr = errors.New("socket missing")
		_, err := newRunnerWithClient(context.Background(), DefaultConfig(), cli)
		if !errors.Is(err, ErrSandboxUnavailable) {
			t.Fatalf("expected ErrSandboxUnavailable, got %v", err)
		}
	})

	t.Run("missing image failure", func(t *testing.T) {
		cli := newMockDockerAPI()
		cli.inspectImgErr = errors.New("No such image")
		_, err := newRunnerWithClient(context.Background(), DefaultConfig(), cli)
		if !errors.Is(err, ErrSandboxUnavailable) {
			t.Fatalf("expected ErrSandboxUnavailable, got %v", err)
		}
		if !strings.Contains(err.Error(), "make sandbox-image") {
			t.Fatalf("expected actionable build hint in error, got %v", err)
		}
	})
}

func TestRunHardeningAndStdcopy(t *testing.T) {
	cli := newMockDockerAPI()
	var capturedInput harnessInputPayload
	cli.onStart = func(_ context.Context, _ string, stdin []byte) ([]byte, []byte, int64, bool, error) {
		_ = json.Unmarshal(stdin, &capturedInput)
		out, _ := json.Marshal(harnessOutputWire{
			Status: StatusOK,
			Score:  100,
			Ran:    1,
			Passed: 1,
			Failed: 0,
			Total:  1,
			Tests: []harnessTestResultWire{
				{
					Index:        1,
					Name:         "test_add",
					DisplayName:  "Adds numbers",
					Status:       TestPassed,
					Passed:       true,
					Inputs:       "a=1, b=2",
					Expected:     "3",
					Actual:       "3",
					HasDocstring: true,
				},
			},
		})
		return out, []byte("harmless stderr"), 0, false, nil
	}

	r, err := newRunnerWithClient(context.Background(), DefaultConfig(), cli)
	if err != nil {
		t.Fatalf("newRunnerWithClient: %v", err)
	}

	res, err := r.Run(context.Background(), RunRequest{
		Code:  "def add(a, b): return a + b",
		Tests: "def test_add(): expect(add(1, 2), 3)",
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != StatusOK || res.Score != 100 || res.Passed != 1 {
		t.Fatalf("unexpected RunResult: %+v", res)
	}
	if capturedInput.Code == "" || capturedInput.Tests == "" {
		t.Fatalf("expected payload delivered over stdin, got %+v", capturedInput)
	}

	cli.mu.Lock()
	cfg := cli.lastCfg
	hostCfg := cli.lastHostCfg
	removed := append([]string(nil), cli.removedIDs...)
	waitedAfterStart := cli.waitedAfterStart
	cli.mu.Unlock()

	if !waitedAfterStart {
		t.Fatalf("expected ContainerWait to be called after ContainerStart")
	}
	if cfg.User != "1000:1000" || !cfg.NetworkDisabled || cfg.Tty || !cfg.OpenStdin {
		t.Fatalf("unexpected container.Config hardening: %+v", cfg)
	}
	if hostCfg.NetworkMode != "none" || !hostCfg.ReadonlyRootfs || hostCfg.AutoRemove {
		t.Fatalf("unexpected HostConfig isolation flags: %+v", hostCfg)
	}
	if hostCfg.Tmpfs["/work"] != "rw,noexec,nosuid,size=8m,mode=1777" || hostCfg.Tmpfs["/tmp"] != "rw,noexec,nosuid,size=4m,mode=1777" {
		t.Fatalf("unexpected tmpfs config: %+v", hostCfg.Tmpfs)
	}
	if hostCfg.Memory != DefaultMemoryLimitBytes || hostCfg.MemorySwap != DefaultMemoryLimitBytes {
		t.Fatalf("expected memory=swap=%d, got mem=%d swap=%d", DefaultMemoryLimitBytes, hostCfg.Memory, hostCfg.MemorySwap)
	}
	if hostCfg.NanoCPUs != DefaultNanoCPUs || hostCfg.PidsLimit == nil || *hostCfg.PidsLimit != DefaultPidsLimit {
		t.Fatalf("unexpected CPU/PID limits: %+v", hostCfg.Resources)
	}
	if len(hostCfg.CapDrop) != 1 || hostCfg.CapDrop[0] != "ALL" {
		t.Fatalf("expected CapDrop ALL, got %+v", hostCfg.CapDrop)
	}
	if len(hostCfg.SecurityOpt) != 1 || hostCfg.SecurityOpt[0] != "no-new-privileges:true" {
		t.Fatalf("expected no-new-privileges, got %+v", hostCfg.SecurityOpt)
	}
	if len(removed) != 1 {
		t.Fatalf("expected container to be forcefully removed, got %v", removed)
	}
}

func TestRunOOMTimeoutAndSizeLimits(t *testing.T) {
	t.Run("size limits reject before semaphore", func(t *testing.T) {
		cli := newMockDockerAPI()
		cfg := DefaultConfig()
		cfg.MaxConcurrent = 1
		cfg.MaxCodeBytes = 10
		cfg.MaxTestsBytes = 10
		r, err := newRunnerWithClient(context.Background(), cfg, cli)
		if err != nil {
			t.Fatalf("newRunnerWithClient: %v", err)
		}
		// Fill the single semaphore slot to prove size checks bypass queue wait.
		r.sem <- struct{}{}
		defer func() { <-r.sem }()

		_, err = r.Run(context.Background(), RunRequest{Code: strings.Repeat("a", 11), Tests: "pass"})
		if !errors.Is(err, ErrCodeTooLarge) {
			t.Fatalf("expected ErrCodeTooLarge, got %v", err)
		}
		_, err = r.Run(context.Background(), RunRequest{Code: "pass", Tests: strings.Repeat("b", 11)})
		if !errors.Is(err, ErrTestsTooLarge) {
			t.Fatalf("expected ErrTestsTooLarge, got %v", err)
		}
	})

	t.Run("OOMKilled reported as StatusOOM", func(t *testing.T) {
		cli := newMockDockerAPI()
		cli.onStart = func(_ context.Context, _ string, _ []byte) ([]byte, []byte, int64, bool, error) {
			return nil, nil, 137, true, nil
		}
		r, err := newRunnerWithClient(context.Background(), DefaultConfig(), cli)
		if err != nil {
			t.Fatalf("newRunnerWithClient: %v", err)
		}
		res, err := r.Run(context.Background(), RunRequest{Code: "x = [0]*(10**9)", Tests: "def test_a(): pass"})
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if res.Status != StatusOOM || res.Score != 0 {
			t.Fatalf("expected StatusOOM score 0, got %+v", res)
		}
	})

	t.Run("hard container timeout removes container", func(t *testing.T) {
		cli := newMockDockerAPI()
		cli.waitDelay = 500 * time.Millisecond
		cfg := DefaultConfig()
		cfg.PerTestTimeout = 50 * time.Millisecond
		cfg.ContainerTimeout = 80 * time.Millisecond

		r, err := newRunnerWithClient(context.Background(), cfg, cli)
		if err != nil {
			t.Fatalf("newRunnerWithClient: %v", err)
		}
		res, err := r.Run(context.Background(), RunRequest{Code: "while True: pass", Tests: "def test_a(): pass"})
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if res.Status != StatusTimeout || res.Score != 0 {
			t.Fatalf("expected StatusTimeout score 0, got %+v", res)
		}
		cli.mu.Lock()
		removedCount := len(cli.removedIDs)
		cli.mu.Unlock()
		if removedCount != 1 {
			t.Fatalf("expected container force-removed on timeout, count=%d", removedCount)
		}
	})

	t.Run("semaphore queue saturation returns ErrQueueFull", func(t *testing.T) {
		cli := newMockDockerAPI()
		cli.waitDelay = 120 * time.Millisecond
		cfg := DefaultConfig()
		cfg.MaxConcurrent = 1
		cfg.QueueWaitTimeout = 40 * time.Millisecond

		r, err := newRunnerWithClient(context.Background(), cfg, cli)
		if err != nil {
			t.Fatalf("newRunnerWithClient: %v", err)
		}

		var wg sync.WaitGroup
		errs := make(chan error, 2)
		for range 2 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, runErr := r.Run(context.Background(), RunRequest{Code: "pass", Tests: "def test_a(): pass"})
				errs <- runErr
			}()
		}
		wg.Wait()
		close(errs)

		var gotOK, gotQueueFull int
		for e := range errs {
			switch {
			case e == nil:
				gotOK++
			case errors.Is(e, ErrQueueFull):
				gotQueueFull++
			default:
				t.Fatalf("unexpected error: %v", e)
			}
		}
		if gotOK != 1 || gotQueueFull != 1 {
			t.Fatalf("expected 1 ok and 1 ErrQueueFull, got ok=%d queueFull=%d", gotOK, gotQueueFull)
		}
	})
}

func TestViewsAndValidateLabWarnings(t *testing.T) {
	cli := newMockDockerAPI()
	cli.onStart = func(_ context.Context, _ string, _ []byte) ([]byte, []byte, int64, bool, error) {
		out, _ := json.Marshal(harnessOutputWire{
			Status: StatusOK,
			Score:  100,
			Ran:    3,
			Passed: 3,
			Failed: 0,
			Total:  3,
			Tests: []harnessTestResultWire{
				{
					Index:        1,
					Name:         "test_slow_cases[1]",
					DisplayName:  "Slow cases (case 1/2)",
					Status:       TestPassed,
					Passed:       true,
					DurationMs:   1500,
					HasDocstring: false,
				},
				{
					Index:        2,
					Name:         "test_slow_cases[2]",
					DisplayName:  "Slow cases (case 2/2)",
					Status:       TestPassed,
					Passed:       true,
					DurationMs:   10,
					HasDocstring: false,
				},
				{
					Index:        3,
					Name:         "test_fast_labeled",
					DisplayName:  "Fast labeled test",
					Status:       TestPassed,
					Passed:       true,
					DurationMs:   5,
					HasDocstring: true,
				},
			},
		})
		return out, nil, 0, false, nil
	}

	r, err := newRunnerWithClient(context.Background(), DefaultConfig(), cli)
	if err != nil {
		t.Fatalf("newRunnerWithClient: %v", err)
	}
	vr, err := r.ValidateLab(context.Background(), "def f(): return 1", "import unittest\nclass T(unittest.TestCase):\n    def test_slow_cases(self): pass")
	if err != nil {
		t.Fatalf("ValidateLab: %v", err)
	}
	if !vr.Valid || vr.TotalTests != 3 || vr.PassedTests != 3 {
		t.Fatalf("unexpected ValidationResult: %+v", vr)
	}
	if len(vr.Warnings) != 2 {
		t.Fatalf("expected 2 warnings (slow test + unlabeled method), got %v", vr.Warnings)
	}
	if !strings.Contains(vr.Warnings[1], "test_slow_cases") || strings.Contains(vr.Warnings[1], "test_slow_cases[1]") {
		t.Fatalf("expected deduplicated unlabeled method warning for test_slow_cases, got %q", vr.Warnings[1])
	}

	// Verify 0-test rejection message.
	cli.onStart = func(_ context.Context, _ string, _ []byte) ([]byte, []byte, int64, bool, error) {
		out, _ := json.Marshal(harnessOutputWire{
			Status: StatusOK,
			Score:  0,
			Ran:    0,
			Passed: 0,
			Failed: 0,
			Total:  0,
			Tests:  []harnessTestResultWire{},
		})
		return out, nil, 0, false, nil
	}
	vrZero, err := r.ValidateLab(context.Background(), "def f(): return 1", "def test_top_level(): assert True")
	if err != nil {
		t.Fatalf("ValidateLab zero: %v", err)
	}
	if vrZero.Valid || !strings.Contains(vrZero.Summary, "unittest.TestCase") {
		t.Fatalf("expected unittest.TestCase rejection for 0-test suite, got %+v", vrZero)
	}
}

// --- End-to-End Python Harness Wire Tests ---

func runLocalPythonHarness(t *testing.T, code, tests string, perTestTimeoutSec float64) *RunResult {
	t.Helper()
	pyBin, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not found on host")
	}

	harnessPath := filepath.Join("..", "..", "docker", "python-sandbox", "harness.py")
	workDir := t.TempDir()

	payload, err := json.Marshal(harnessInputPayload{
		Code:               code,
		Tests:              tests,
		PerTestTimeoutSec:  perTestTimeoutSec,
		MaxStdoutBytes:     DefaultMaxStdoutBytes,
		MaxTestStdoutBytes: DefaultMaxTestStdoutBytes,
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, pyBin, "-B", harnessPath)
	cmd.Env = append(os.Environ(), "SANDBOX_WORK_DIR="+workDir)
	cmd.Stdin = bytes.NewReader(payload)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		t.Fatalf("harness failed: %v\nstdout: %s\nstderr: %s", err, stdout.String(), stderr.String())
	}

	res, err := parseHarnessOutput(bytes.TrimSpace(stdout.Bytes()))
	if err != nil {
		t.Fatalf("parseHarnessOutput failed: %v\nraw stdout: %q\nstderr: %q", err, stdout.String(), stderr.String())
	}
	return res
}

func TestHarnessUnittestAssertionsAndLifecycle(t *testing.T) {
	code := `
def add(a, b):
    return a + b

def invert(d):
    return {v: k for k, v in d.items()}

def divide(a, b):
    if b == 0:
        raise ValueError("cannot divide by zero")
    return a / b
`
	tests := `
import unittest
from solution import add, invert, divide

class TestMathAndDict(unittest.TestCase):
    events = []

    @classmethod
    def setUpClass(cls):
        cls.base = 10

    @classmethod
    def tearDownClass(cls):
        cls.events.append("tearDownClass")

    def setUp(self):
        self.cleanups = []
        self.addCleanup(lambda: self.cleanups.append("cleaned"))

    def test_add_with_setup(self):
        """Adds against setup base"""
        self.assertEqual(add(self.base, 5), 15)

    def test_invert_dict(self):
        """Inverts dictionary keys and values"""
        self.assertDictEqual(invert({"a": 1, "b": 2}), {1: "a", 2: "b"})

    def test_almost_equal(self):
        self.assertAlmostEqual(divide(1, 3), 0.333333, places=5)

    def test_raises(self):
        """Raises ValueError when dividing by zero"""
        with self.assertRaises(ValueError):
            divide(10, 0)
`
	res := runLocalPythonHarness(t, code, tests, 2.0)
	if res.Status != StatusOK || res.Score != 100 || res.Ran != 4 || res.Passed != 4 || res.Failed != 0 || res.Total != 4 {
		t.Fatalf("unexpected happy path result: %+v", res)
	}
	if res.Tests[0].DisplayName != "Adds against setup base" || res.Tests[0].Actual != "15" || res.Tests[0].Expected != "15" {
		t.Fatalf("unexpected assertEqual capture: %+v", res.Tests[0])
	}
	if res.Tests[1].Actual != "{1: 'a', 2: 'b'}" || res.Tests[1].Expected != "{1: 'a', 2: 'b'}" {
		t.Fatalf("unexpected assertDictEqual capture: %+v", res.Tests[1])
	}
	if res.Tests[2].DisplayName != "Almost equal" {
		t.Fatalf("expected humanized fallback display name, got %q", res.Tests[2].DisplayName)
	}
}

func TestHarnessSubTestExpansionAndBootDevDiagnostics(t *testing.T) {
	code := `
def two_sum(nums, target):
    print(f"checking nums={nums}")
    first = nums[0]
    if nums == [3, 3]:
        return [0, 0]
    return [0, 1]
`
	tests := `
import unittest
from solution import two_sum

class TestTwoSum(unittest.TestCase):
    def test_examples(self):
        """Finds two indices summing to target"""
        cases = [
            ("basic pair", [2, 7, 11, 15], 9, [0, 1]),
            ("empty list", [], 5, []),
            ("duplicate values", [3, 3], 6, [0, 1]),
        ]
        for label, nums, target, expected in cases:
            with self.subTest(msg=label, nums=nums, target=target):
                self.assertEqual(two_sum(nums, target), expected)

    def test_single_subtest(self):
        """Handles negative numbers"""
        with self.subTest(nums=[-3, 4, 3, 90], target=0):
            self.assertEqual(two_sum([-3, 4, 3, 90], 0), [0, 1])
`
	res := runLocalPythonHarness(t, code, tests, 2.0)
	if res.Status != StatusOK || res.Ran != 4 || res.Passed != 2 || res.Failed != 2 || res.Total != 4 || res.Score != 50 {
		t.Fatalf("unexpected subTest expansion summary: %+v", res)
	}

	// Verify student view preserves full Boot.dev details without leaking <test_suite> frames or Detail.
	sv := res.ToStudentView()
	svJSON, err := json.Marshal(sv)
	if err != nil {
		t.Fatalf("marshal StudentRunResult: %v", err)
	}
	svStr := string(svJSON)
	if strings.Contains(svStr, "<test_suite>") {
		t.Fatalf("student view leaked <test_suite> frame: %s", svStr)
	}

	// Expanded subTests: basic pair (pass), empty list (IndexError + filtered solution.py traceback), duplicate values (Expecting/Actual).
	if sv.Tests[0].Name != "test_examples[1]" || sv.Tests[0].DisplayName != "basic pair" || !sv.Tests[0].Passed {
		t.Fatalf("unexpected first expanded subTest: %+v", sv.Tests[0])
	}
	emptyCase := sv.Tests[1]
	if emptyCase.Name != "test_examples[2]" || emptyCase.Inputs != "nums=[], target=5" || emptyCase.ErrorType != "IndexError" || emptyCase.Stdout != "checking nums=[]\n" || len(emptyCase.Traceback) != 1 || emptyCase.Traceback[0].Line != 4 {
		t.Fatalf("unexpected filtered traceback/stdout for empty case: %+v", emptyCase)
	}
	dupCase := sv.Tests[2]
	if dupCase.Inputs != "nums=[3, 3], target=6" || dupCase.Expected != "[0, 1]" || dupCase.Actual != "[0, 0]" || dupCase.ErrorType != "AssertionError" {
		t.Fatalf("unexpected Boot.dev assertion fields: %+v", dupCase)
	}
	// Single subTest stays 1 entry keeping method name and docstring.
	singleCase := sv.Tests[3]
	if singleCase.Name != "test_single_subtest" || singleCase.DisplayName != "Handles negative numbers" || singleCase.Inputs != "nums=[-3, 4, 3, 90], target=0" {
		t.Fatalf("unexpected single subTest shape: %+v", singleCase)
	}

	// Tutor context keeps passed tests and full raw traceback detail.
	tc := res.ToTutorContext()
	if len(tc.PassedTests) != 2 || tc.PassedTests[0] != "test_examples[1]" {
		t.Fatalf("unexpected PassedTests in TutorRunContext: %+v", tc.PassedTests)
	}
	if len(tc.Failures) != 2 || tc.Failures[0].Detail == "" || !strings.Contains(tc.Failures[0].Detail, "<test_suite>") {
		t.Fatalf("expected full raw traceback in TutorRunContext failures: %+v", tc.Failures)
	}
}

func TestHarnessSyntaxImportTimeoutAndAdversarial(t *testing.T) {
	t.Run("syntax error in solution vs tests", func(t *testing.T) {
		resSol := runLocalPythonHarness(t, "def f(\n    return 1", "import unittest\nclass T(unittest.TestCase):\n    def test_a(self): pass", 2.0)
		if resSol.Status != StatusSyntaxError || resSol.SyntaxError == nil || resSol.SyntaxError.Source != "solution" || resSol.SyntaxError.Line != 1 {
			t.Fatalf("unexpected solution syntax error: %+v", resSol)
		}
		if sv := resSol.ToStudentView(); sv.SyntaxError == nil || sv.SyntaxError.Line != 1 {
			t.Fatalf("student view should keep solution syntax error line: %+v", sv)
		}

		resTest := runLocalPythonHarness(t, "def f(): return 1", "import unittest\nclass T(unittest.TestCase):\n    def test_a(self:\n        pass", 2.0)
		if resTest.Status != StatusSyntaxError || resTest.SyntaxError == nil || resTest.SyntaxError.Source != "tests" {
			t.Fatalf("unexpected test syntax error: %+v", resTest)
		}
		if sv := resTest.ToStudentView(); sv.SyntaxError != nil {
			t.Fatalf("student view must suppress tests-sourced syntax errors: %+v", sv.SyntaxError)
		}
	})

	t.Run("missing symbol triggers StatusRuntimeError", func(t *testing.T) {
		res := runLocalPythonHarness(t, "def wrong_name(): return 1", "import unittest\nfrom solution import missing_fn\nclass T(unittest.TestCase):\n    def test_a(self): pass", 2.0)
		if res.Status != StatusRuntimeError || res.Score != 0 || !strings.Contains(res.InternalError, "ImportError") {
			t.Fatalf("unexpected runtime error result: %+v", res)
		}
	})

	t.Run("setUpClass failure fails class methods cleanly", func(t *testing.T) {
		tests := `
import unittest
class T(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raise RuntimeError("boom in setup")
    def test_one(self):
        self.assertEqual(1, 1)
    def test_two(self):
        self.assertEqual(2, 2)
`
		res := runLocalPythonHarness(t, "x = 1", tests, 2.0)
		if res.Status != StatusOK || res.Total != 2 || res.Failed != 2 || res.Tests[0].ErrorType != "RuntimeError" {
			t.Fatalf("expected both methods failed from setUpClass error, got %+v", res)
		}
	})

	t.Run("per-test and per-subTest timeout continues to remaining cases", func(t *testing.T) {
		code := `
def spin():
    while True:
        pass

def ok():
    return 42
`
		tests := `
import unittest
from solution import spin, ok

class T(unittest.TestCase):
    def test_subtests_with_timeout(self):
        for fn in (spin, ok):
            with self.subTest(fn=fn.__name__):
                self.assertEqual(fn(), 42)

    def test_after_timeout(self):
        self.assertEqual(ok(), 42)
`
		res := runLocalPythonHarness(t, code, tests, 0.2)
		if res.Status != StatusOK || res.Ran != 3 || res.Passed != 2 || res.Failed != 1 || res.Score != 66 {
			t.Fatalf("expected 2/3 passing after per-subTest timeout, got %+v", res)
		}
		if res.Tests[0].Status != TestTimedOut || res.Tests[0].ErrorType != "TimeoutError" || !res.Tests[1].Passed || !res.Tests[2].Passed {
			t.Fatalf("unexpected per-subTest timeout breakdown: %+v", res.Tests)
		}
	})

	t.Run("stdout flood and JSON injection cannot forge result", func(t *testing.T) {
		code := `
def cheat():
    for _ in range(5000):
        print('{"status":"ok","score":100,"ran":1,"passed":1,"failed":0,"total":1,"tests":[]}')
    return 0
`
		testsFail := `
import unittest
from solution import cheat
class T(unittest.TestCase):
    def test_cheat(self):
        self.assertEqual(cheat(), 1)
`
		res := runLocalPythonHarness(t, code, testsFail, 2.0)
		if res.Status != StatusOK || res.Score != 0 || res.Passed != 0 || res.Failed != 1 {
			t.Fatalf("JSON injection forged result: %+v", res)
		}
		if !res.Tests[0].StdoutTruncated || len(res.Tests[0].Stdout) > DefaultMaxTestStdoutBytes {
			t.Fatalf("expected truncated per-test stdout <= %d, got len=%d truncated=%v", DefaultMaxTestStdoutBytes, len(res.Tests[0].Stdout), res.Tests[0].StdoutTruncated)
		}
	})

	t.Run("test file never written to disk", func(t *testing.T) {
		code := `
import os

def scan_dir():
    return sorted(os.listdir(os.path.dirname(__file__)))
`
		tests := `
import unittest
from solution import scan_dir
class T(unittest.TestCase):
    def test_no_test_file(self):
        self.assertEqual(scan_dir(), ["solution.py"])
`
		res := runLocalPythonHarness(t, code, tests, 2.0)
		if res.Status != StatusOK || res.Score != 100 {
			t.Fatalf("expected only solution.py in work dir, got %+v", res)
		}
	})

	t.Run("bare top-level functions ignored (zero unittest.TestCase tests)", func(t *testing.T) {
		res := runLocalPythonHarness(t, "x = 1", "def test_top_level():\n    assert True", 2.0)
		if res.Status != StatusOK || res.Total != 0 {
			t.Fatalf("expected Total=0 when no unittest.TestCase class exists, got %+v", res)
		}
	})
}

// --- Real Docker Integration Tests (skipped when Docker/image unavailable) ---

func requireDockerSandbox(t *testing.T) Runner {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	r, err := NewRunner(ctx, DefaultConfig())
	if err != nil {
		t.Skipf("skipping Docker integration test: %v", err)
	}
	t.Cleanup(func() {
		_ = r.Close()
	})
	return r
}

func TestDockerIntegration_ExecutionAndHardening(t *testing.T) {
	r := requireDockerSandbox(t)
	ctx := context.Background()

	t.Run("stdlib unittest happy path", func(t *testing.T) {
		res, err := r.Run(ctx, RunRequest{
			Code: `
def divide(a, b):
    if b == 0:
        raise ValueError("division by zero")
    return a / b
`,
			Tests: `
import unittest
from solution import divide

class TestDivide(unittest.TestCase):
    def test_approx(self):
        self.assertAlmostEqual(divide(1, 3), 0.333333, places=4)

    def test_raises(self):
        with self.assertRaises(ValueError):
            divide(1, 0)
`,
		})
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if res.Status != StatusOK || res.Score != 100 || res.Passed != 2 {
			t.Fatalf("unexpected Docker result: %+v", res)
		}
	})

	t.Run("OOM bomb", func(t *testing.T) {
		res, err := r.Run(ctx, RunRequest{
			Code:  "data = bytearray(512 * 1024 * 1024)",
			Tests: "import unittest\nimport solution\nclass T(unittest.TestCase):\n    def test_a(self): pass",
		})
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if res.Status != StatusOOM {
			t.Fatalf("expected StatusOOM, got %+v", res)
		}
	})

	t.Run("network disabled", func(t *testing.T) {
		res, err := r.Run(ctx, RunRequest{
			Code: `
import socket
def try_connect():
    s = socket.create_connection(("1.1.1.1", 80), timeout=1)
    s.close()
`,
			Tests: `
import unittest
from solution import try_connect
class T(unittest.TestCase):
    def test_no_net(self):
        with self.assertRaises(OSError):
            try_connect()
`,
		})
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if res.Status != StatusOK || res.Score != 100 {
			t.Fatalf("expected network connection blocked, got %+v", res)
		}
	})

	t.Run("read-only rootfs", func(t *testing.T) {
		res, err := r.Run(ctx, RunRequest{
			Code: `
def write_root():
    with open("/etc/pwned", "w") as f:
        f.write("x")
`,
			Tests: `
import unittest
from solution import write_root
class T(unittest.TestCase):
    def test_ro(self):
        with self.assertRaises(OSError):
            write_root()
`,
		})
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if res.Status != StatusOK || res.Score != 100 {
			t.Fatalf("expected read-only rootfs failure, got %+v", res)
		}
	})
}
