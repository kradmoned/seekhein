package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kradmoned/seekhein/internal/sandbox"
)

type stubRunner struct {
	runFn      func(ctx context.Context, req sandbox.RunRequest) (*sandbox.RunResult, error)
	validateFn func(ctx context.Context, solutionCode, testCode string) (*sandbox.ValidationResult, error)
}

func (s *stubRunner) Run(ctx context.Context, req sandbox.RunRequest) (*sandbox.RunResult, error) {
	return s.runFn(ctx, req)
}

func (s *stubRunner) ValidateLab(ctx context.Context, solutionCode, testCode string) (*sandbox.ValidationResult, error) {
	return s.validateFn(ctx, solutionCode, testCode)
}

func (s *stubRunner) Close() error { return nil }

func TestHealthEndpoint(t *testing.T) {
	h := NewHandler(&stubRunner{})
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal health: %v", err)
	}
	if body["status"] != "ok" {
		t.Fatalf("expected status ok, got %q", body["status"])
	}
}

func TestRunEndpointViewsAndErrors(t *testing.T) {
	sampleResult := &sandbox.RunResult{
		Status: sandbox.StatusOK,
		Score:  50,
		Ran:    2,
		Passed: 1,
		Failed: 1,
		Total:  2,
		Tests: []sandbox.TestResult{
			{
				Index:       1,
				Name:        "test_basic",
				DisplayName: "Basic test",
				Status:      sandbox.TestPassed,
				Passed:      true,
				Inputs:      "x=1",
				Expected:    "2",
				Actual:      "2",
			},
			{
				Index:        2,
				Name:         "test_edge",
				DisplayName:  "Edge case",
				Status:       sandbox.TestFailed,
				Passed:       false,
				Inputs:       "x=99",
				Expected:     "100",
				Actual:       "0",
				ErrorType:    "AssertionError",
				ErrorMessage: "0 != 100",
				Detail:       "secret traceback",
			},
		},
	}

	h := NewHandler(&stubRunner{
		runFn: func(_ context.Context, _ sandbox.RunRequest) (*sandbox.RunResult, error) {
			return sampleResult, nil
		},
	})

	// Default student view preserves Boot.dev learning fields while stripping internal Detail.
	req := httptest.NewRequest(http.MethodPost, "/run", bytes.NewBufferString(`{"code":"def f(x): return x","tests":"import unittest\nclass T(unittest.TestCase):\n    def test_a(self): pass"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("x=99")) || !bytes.Contains(rec.Body.Bytes(), []byte("0 != 100")) {
		t.Fatalf("student view missing Boot.dev learning diagnostics: %s", rec.Body.String())
	}
	if bytes.Contains(rec.Body.Bytes(), []byte("secret traceback")) {
		t.Fatalf("student view leaked internal Detail: %s", rec.Body.String())
	}

	// Tutor view preserves full failure diagnostics including Detail.
	reqTutor := httptest.NewRequest(http.MethodPost, "/run?view=tutor", bytes.NewBufferString(`{"code":"def f(x): return x","tests":"import unittest\nclass T(unittest.TestCase):\n    def test_a(self): pass"}`))
	recTutor := httptest.NewRecorder()
	h.ServeHTTP(recTutor, reqTutor)
	if recTutor.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", recTutor.Code)
	}
	if !bytes.Contains(recTutor.Body.Bytes(), []byte("x=99")) || !bytes.Contains(recTutor.Body.Bytes(), []byte("secret traceback")) {
		t.Fatalf("tutor view missing expected failure context: %s", recTutor.Body.String())
	}

	// Both view returns leak-safe student view alongside full tutor context in one run.
	reqBoth := httptest.NewRequest(http.MethodPost, "/run?view=both", bytes.NewBufferString(`{"code":"def f(x): return x","tests":"import unittest\nclass T(unittest.TestCase):\n    def test_a(self): pass"}`))
	recBoth := httptest.NewRecorder()
	h.ServeHTTP(recBoth, reqBoth)
	if recBoth.Code != http.StatusOK {
		t.Fatalf("expected 200 for view=both, got %d", recBoth.Code)
	}
	var bothPayload struct {
		Student json.RawMessage         `json:"student"`
		Tutor   sandbox.TutorRunContext `json:"tutor"`
	}
	if err := json.Unmarshal(recBoth.Body.Bytes(), &bothPayload); err != nil {
		t.Fatalf("unmarshal view=both response: %v", err)
	}
	if !bytes.Contains(bothPayload.Student, []byte("x=99")) || !bytes.Contains(bothPayload.Student, []byte("0 != 100")) {
		t.Fatalf("view=both student missing expected diagnostics: %s", bothPayload.Student)
	}
	if bytes.Contains(bothPayload.Student, []byte("secret traceback")) {
		t.Fatalf("view=both student leaked internal Detail: %s", bothPayload.Student)
	}
	if len(bothPayload.Tutor.PassedTests) != 1 || bothPayload.Tutor.PassedTests[0] != "test_basic" {
		t.Fatalf("view=both tutor unexpected PassedTests: %+v", bothPayload.Tutor.PassedTests)
	}
	if len(bothPayload.Tutor.Failures) != 1 || bothPayload.Tutor.Failures[0].Detail != "secret traceback" || bothPayload.Tutor.Failures[0].Inputs != "x=99" {
		t.Fatalf("view=both tutor unexpected Failures: %+v", bothPayload.Tutor.Failures)
	}

	// Invalid view returns 400.
	reqBad := httptest.NewRequest(http.MethodPost, "/run?view=admin", bytes.NewBufferString(`{"code":"a","tests":"b"}`))
	recBad := httptest.NewRecorder()
	h.ServeHTTP(recBad, reqBad)
	if recBad.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid view, got %d", recBad.Code)
	}

	// Sentinel error mappings.
	cases := []struct {
		err        error
		wantStatus int
	}{
		{fmt.Errorf("wrap: %w", sandbox.ErrCodeTooLarge), http.StatusRequestEntityTooLarge},
		{fmt.Errorf("wrap: %w", sandbox.ErrTestsTooLarge), http.StatusRequestEntityTooLarge},
		{sandbox.ErrQueueFull, http.StatusTooManyRequests},
		{sandbox.ErrSandboxUnavailable, http.StatusServiceUnavailable},
	}
	for _, tc := range cases {
		errHandler := NewHandler(&stubRunner{
			runFn: func(_ context.Context, _ sandbox.RunRequest) (*sandbox.RunResult, error) {
				return nil, tc.err
			},
		})
		r := httptest.NewRequest(http.MethodPost, "/run", bytes.NewBufferString(`{"code":"a","tests":"b"}`))
		w := httptest.NewRecorder()
		errHandler.ServeHTTP(w, r)
		if w.Code != tc.wantStatus {
			t.Fatalf("for error %v expected status %d, got %d", tc.err, tc.wantStatus, w.Code)
		}
	}
}

func TestValidateEndpoint(t *testing.T) {
	hPass := NewHandler(&stubRunner{
		validateFn: func(_ context.Context, _, _ string) (*sandbox.ValidationResult, error) {
			return &sandbox.ValidationResult{
				Valid:       true,
				Summary:     "All 2 tests passed against reference solution",
				TotalTests:  2,
				PassedTests: 2,
			}, nil
		},
	})
	rec := httptest.NewRecorder()
	hPass.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/validate", bytes.NewBufferString(`{"solution":"x=1","tests":"def test_x(): pass"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on valid lab, got %d", rec.Code)
	}

	hFail := NewHandler(&stubRunner{
		validateFn: func(_ context.Context, _, _ string) (*sandbox.ValidationResult, error) {
			return &sandbox.ValidationResult{
				Valid:   false,
				Summary: "lab must define at least 1 test",
			}, nil
		},
	})
	recFail := httptest.NewRecorder()
	hFail.ServeHTTP(recFail, httptest.NewRequest(http.MethodPost, "/validate", bytes.NewBufferString(`{"solution":"x=1","tests":"pass"}`)))
	if recFail.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 on invalid lab, got %d", recFail.Code)
	}
}

func TestConfigFromEnvAutoBuild(t *testing.T) {
	t.Setenv("SANDBOX_AUTO_BUILD", "")
	if cfg := configFromEnv(); !cfg.AutoBuildImage {
		t.Fatalf("expected AutoBuildImage=true by default")
	}

	t.Setenv("SANDBOX_AUTO_BUILD", "false")
	if cfg := configFromEnv(); cfg.AutoBuildImage {
		t.Fatalf("expected AutoBuildImage=false when SANDBOX_AUTO_BUILD=false")
	}

	t.Setenv("SANDBOX_AUTO_BUILD", "true")
	if cfg := configFromEnv(); !cfg.AutoBuildImage {
		t.Fatalf("expected AutoBuildImage=true when SANDBOX_AUTO_BUILD=true")
	}
}
