package sandbox

import "time"

// RunRequest holds the student code and test suite to execute inside the sandbox.
type RunRequest struct {
	Code           string
	Tests          string
	PerTestTimeout time.Duration // optional override; 0 uses Config.PerTestTimeout
}

// RunStatus classifies the overall outcome of a sandbox execution.
type RunStatus string

const (
	StatusOK           RunStatus = "ok"
	StatusSyntaxError  RunStatus = "syntax_error"
	StatusRuntimeError RunStatus = "runtime_error"
	StatusTimeout      RunStatus = "timeout"
	StatusOOM          RunStatus = "oom"
	StatusInternalErr  RunStatus = "internal_error"
)

// SyntaxErrorInfo captures syntax or indentation error locations.
type SyntaxErrorInfo struct {
	Source       string `json:"-"`                       // internal-only: "solution" or "tests"
	ErrorType    string `json:"error_type"`              // e.g. "SyntaxError", "IndentationError"
	ErrorMessage string `json:"error_message,omitempty"` // e.g. "expected ':'"
	Line         int    `json:"line"`                    // 1-based line number in solution.py (0 if not from solution.py)
	CodeLine     string `json:"code_line,omitempty"`     // offending line text from solution.py
}

// TraceFrame represents a single filtered stack frame from solution.py.
type TraceFrame struct {
	Line     int    `json:"line"`
	Function string `json:"function"`
	Code     string `json:"code"`
}

// TestStatus classifies an individual test case result.
type TestStatus string

const (
	TestPassed   TestStatus = "passed"
	TestFailed   TestStatus = "failed"
	TestTimedOut TestStatus = "timeout"
	TestNotRun   TestStatus = "not_run"
)

// TestResult holds full server-side execution details for a single test case.
type TestResult struct {
	Index           int          `json:"index"`        // 1-based test order
	Name            string       `json:"name"`         // raw function/method name (e.g. "test_empty_list")
	DisplayName     string       `json:"display_name"` // docstring first line or humanized Name
	Hidden          bool         `json:"hidden"`       // true when Name starts with "test_hidden_"
	Status          TestStatus   `json:"status"`       // "passed", "failed", "timeout", "not_run"
	Passed          bool         `json:"passed"`
	Inputs          string       `json:"inputs,omitempty"`
	Expected        string       `json:"expected,omitempty"`
	Actual          string       `json:"actual,omitempty"`
	ErrorType       string       `json:"error_type,omitempty"`
	ErrorMessage    string       `json:"error_message,omitempty"`
	Traceback       []TraceFrame `json:"traceback,omitempty"` // strictly solution.py frames only
	Stdout          string       `json:"stdout,omitempty"`
	StdoutTruncated bool         `json:"stdout_truncated,omitempty"`
	DurationMs      int64        `json:"duration_ms"`
	Detail          string       `json:"-"` // internal-only raw traceback/assertion snippet; never serialized to student

	hasDocstring bool
	usedExpect   bool
}

// RunResult holds the full internal result returned by Runner.Run.
type RunResult struct {
	Status          RunStatus        `json:"status"`
	Score           int              `json:"score"`  // 0..100 integer percentage
	Ran             int              `json:"ran"`    // number of tests actually executed
	Passed          int              `json:"passed"` // number of tests that passed
	Failed          int              `json:"failed"` // number of tests that ran and failed/timed out
	Total           int              `json:"total"`  // total discovered tests in the lab
	Stdout          string           `json:"stdout"` // top-level import stdout (if any)
	StdoutTruncated bool             `json:"stdout_truncated"`
	DurationMs      int64            `json:"duration_ms"`
	Tests           []TestResult     `json:"tests"`
	SyntaxError     *SyntaxErrorInfo `json:"syntax_error,omitempty"`
	InternalError   string           `json:"-"` // never exposed to student
}

// StudentTestResult is the browser-safe per-test view returned to students.
type StudentTestResult struct {
	Index           int          `json:"index"`
	Name            string       `json:"name"`
	DisplayName     string       `json:"display_name"`
	Hidden          bool         `json:"hidden"`
	Status          TestStatus   `json:"status"`
	Passed          bool         `json:"passed"`
	Inputs          string       `json:"inputs,omitempty"`
	Expected        string       `json:"expected,omitempty"`
	Actual          string       `json:"actual,omitempty"`
	ErrorType       string       `json:"error_type,omitempty"`
	ErrorMessage    string       `json:"error_message,omitempty"`
	Traceback       []TraceFrame `json:"traceback,omitempty"`
	Stdout          string       `json:"stdout,omitempty"`
	StdoutTruncated bool         `json:"stdout_truncated,omitempty"`
	DurationMs      int64        `json:"duration_ms"`
}

// StudentRunResult is the browser-safe execution summary returned to students.
type StudentRunResult struct {
	Status          RunStatus           `json:"status"`
	Score           int                 `json:"score"`
	Ran             int                 `json:"ran"`
	Passed          int                 `json:"passed"`
	Failed          int                 `json:"failed"`
	Total           int                 `json:"total"`
	Stdout          string              `json:"stdout"`
	StdoutTruncated bool                `json:"stdout_truncated"`
	DurationMs      int64               `json:"duration_ms"`
	Tests           []StudentTestResult `json:"tests"`
	SyntaxError     *SyntaxErrorInfo    `json:"syntax_error,omitempty"`
}

// ToStudentView converts a RunResult into a leak-safe StudentRunResult.
// For standard tests it preserves Boot.dev learning diagnostics; for test_hidden_*
// tests it strips Inputs, Expected, Actual, and assertion ErrorMessage, and always
// suppresses internal Detail/InternalError and non-solution syntax errors.
func (r *RunResult) ToStudentView() StudentRunResult {
	if r == nil {
		return StudentRunResult{
			Status: StatusInternalErr,
			Tests:  []StudentTestResult{},
		}
	}

	out := StudentRunResult{
		Status:          r.Status,
		Score:           r.Score,
		Ran:             r.Ran,
		Passed:          r.Passed,
		Failed:          r.Failed,
		Total:           r.Total,
		Stdout:          r.Stdout,
		StdoutTruncated: r.StdoutTruncated,
		DurationMs:      r.DurationMs,
		Tests:           make([]StudentTestResult, 0, len(r.Tests)),
	}

	if r.SyntaxError != nil && r.SyntaxError.Source == "solution" {
		out.SyntaxError = &SyntaxErrorInfo{
			Source:       r.SyntaxError.Source,
			ErrorType:    r.SyntaxError.ErrorType,
			ErrorMessage: r.SyntaxError.ErrorMessage,
			Line:         r.SyntaxError.Line,
			CodeLine:     r.SyntaxError.CodeLine,
		}
	}

	for _, t := range r.Tests {
		st := StudentTestResult{
			Index:           t.Index,
			Name:            t.Name,
			DisplayName:     t.DisplayName,
			Hidden:          t.Hidden,
			Status:          t.Status,
			Passed:          t.Passed,
			ErrorType:       t.ErrorType,
			Traceback:       cloneTraceFrames(t.Traceback),
			Stdout:          t.Stdout,
			StdoutTruncated: t.StdoutTruncated,
			DurationMs:      t.DurationMs,
		}
		if !t.Hidden {
			st.Inputs = t.Inputs
			st.Expected = t.Expected
			st.Actual = t.Actual
			st.ErrorMessage = t.ErrorMessage
		} else if t.ErrorType != "" && t.ErrorType != "AssertionError" {
			st.ErrorMessage = t.ErrorMessage
		}
		out.Tests = append(out.Tests, st)
	}

	return out
}

// TutorSyntaxError exposes full syntax-error context to the AI tutor service.
type TutorSyntaxError struct {
	Source       string `json:"source"` // "solution" or "tests"
	ErrorType    string `json:"error_type"`
	ErrorMessage string `json:"error_message,omitempty"`
	Line         int    `json:"line"`
	CodeLine     string `json:"code_line,omitempty"`
}

// TutorTestFailure gives the AI tutor full failure diagnostics, including hidden tests.
type TutorTestFailure struct {
	Index        int          `json:"index"`
	Name         string       `json:"name"`
	DisplayName  string       `json:"display_name"`
	Hidden       bool         `json:"hidden"`
	Status       TestStatus   `json:"status"` // "failed" or "timeout"
	Inputs       string       `json:"inputs,omitempty"`
	Expected     string       `json:"expected,omitempty"`
	Actual       string       `json:"actual,omitempty"`
	ErrorType    string       `json:"error_type,omitempty"`
	ErrorMessage string       `json:"error_message,omitempty"`
	Traceback    []TraceFrame `json:"traceback,omitempty"`
	Stdout       string       `json:"stdout,omitempty"`
	Detail       string       `json:"detail,omitempty"`
	DurationMs   int64        `json:"duration_ms"`
}

// TutorRunContext carries the full pedagogical run summary for the AI tutor service.
type TutorRunContext struct {
	Status         RunStatus          `json:"status"`
	Score          int                `json:"score"`
	Ran            int                `json:"ran"`
	Passed         int                `json:"passed"`
	Failed         int                `json:"failed"`
	Total          int                `json:"total"`
	DurationMs     int64              `json:"duration_ms"`
	PassedTests    []string           `json:"passed_tests"`
	Failures       []TutorTestFailure `json:"failures"`
	SyntaxError    *TutorSyntaxError  `json:"syntax_error,omitempty"`
	TopLevelStdout string             `json:"top_level_stdout,omitempty"`
	InternalError  string             `json:"internal_error,omitempty"`
}

// ToTutorContext builds the full server-side context for the Python AI tutor service.
func (r *RunResult) ToTutorContext() TutorRunContext {
	if r == nil {
		return TutorRunContext{
			Status:      StatusInternalErr,
			PassedTests: []string{},
			Failures:    []TutorTestFailure{},
		}
	}

	ctx := TutorRunContext{
		Status:         r.Status,
		Score:          r.Score,
		Ran:            r.Ran,
		Passed:         r.Passed,
		Failed:         r.Failed,
		Total:          r.Total,
		DurationMs:     r.DurationMs,
		PassedTests:    []string{},
		Failures:       []TutorTestFailure{},
		TopLevelStdout: r.Stdout,
		InternalError:  r.InternalError,
	}

	if r.SyntaxError != nil {
		ctx.SyntaxError = &TutorSyntaxError{
			Source:       r.SyntaxError.Source,
			ErrorType:    r.SyntaxError.ErrorType,
			ErrorMessage: r.SyntaxError.ErrorMessage,
			Line:         r.SyntaxError.Line,
			CodeLine:     r.SyntaxError.CodeLine,
		}
	}

	for _, t := range r.Tests {
		if t.Passed {
			ctx.PassedTests = append(ctx.PassedTests, t.Name)
			continue
		}
		ctx.Failures = append(ctx.Failures, TutorTestFailure{
			Index:        t.Index,
			Name:         t.Name,
			DisplayName:  t.DisplayName,
			Hidden:       t.Hidden,
			Status:       t.Status,
			Inputs:       t.Inputs,
			Expected:     t.Expected,
			Actual:       t.Actual,
			ErrorType:    t.ErrorType,
			ErrorMessage: t.ErrorMessage,
			Traceback:    cloneTraceFrames(t.Traceback),
			Stdout:       t.Stdout,
			Detail:       t.Detail,
			DurationMs:   t.DurationMs,
		})
	}

	return ctx
}

// TeacherSyntaxError reports syntax errors in either the reference solution or lab tests.
type TeacherSyntaxError struct {
	Source       string `json:"source"` // "solution" or "tests"
	ErrorType    string `json:"error_type"`
	ErrorMessage string `json:"error_message"`
	Line         int    `json:"line"`
	CodeLine     string `json:"code_line,omitempty"`
}

// TeacherTestDiagnostic provides full unredacted test diagnostics during lab upload validation.
type TeacherTestDiagnostic struct {
	Index         int        `json:"index"`
	Name          string     `json:"name"`
	DisplayName   string     `json:"display_name"`
	Hidden        bool       `json:"hidden"`
	Status        TestStatus `json:"status"`
	Passed        bool       `json:"passed"`
	Inputs        string     `json:"inputs,omitempty"`
	Expected      string     `json:"expected,omitempty"`
	Actual        string     `json:"actual,omitempty"`
	ErrorType     string     `json:"error_type,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
	FullTraceback string     `json:"full_traceback,omitempty"`
	Stdout        string     `json:"stdout,omitempty"`
	DurationMs    int64      `json:"duration_ms"`
}

// ValidationResult is returned by Runner.ValidateLab when a teacher uploads a lab.
type ValidationResult struct {
	Valid         bool                    `json:"valid"`
	Summary       string                  `json:"summary"`
	Status        RunStatus               `json:"status"`
	DurationMs    int64                   `json:"duration_ms"`
	TotalTests    int                     `json:"total_tests"`
	RanTests      int                     `json:"ran_tests"`
	PassedTests   int                     `json:"passed_tests"`
	FailedTests   int                     `json:"failed_tests"`
	StandardTests int                     `json:"standard_tests"`
	HiddenTests   int                     `json:"hidden_tests"`
	SyntaxError   *TeacherSyntaxError     `json:"syntax_error,omitempty"`
	Stdout        string                  `json:"stdout,omitempty"`
	Tests         []TeacherTestDiagnostic `json:"tests"`
	Warnings      []string                `json:"warnings,omitempty"`
}

func cloneTraceFrames(in []TraceFrame) []TraceFrame {
	if len(in) == 0 {
		return nil
	}
	out := make([]TraceFrame, len(in))
	copy(out, in)
	return out
}
