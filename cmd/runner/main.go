package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/kradmoned/seekhein/internal/sandbox"
)

const maxRequestBodyBytes = 512 * 1024

type runHTTPRequest struct {
	Code              string  `json:"code"`
	Tests             string  `json:"tests"`
	PerTestTimeoutSec float64 `json:"per_test_timeout_sec,omitempty"`
}

type validateHTTPRequest struct {
	Solution string `json:"solution"`
	Tests    string `json:"tests"`
}

type errorResponse struct {
	Error string `json:"error"`
}

// NewHandler constructs the standalone HTTP API handler backed by a sandbox.Runner.
func NewHandler(r sandbox.Runner) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	mux.HandleFunc("POST /run", func(w http.ResponseWriter, req *http.Request) {
		var body runHTTPRequest
		if !decodeJSONBody(w, req, &body) {
			return
		}

		view := req.URL.Query().Get("view")
		if view == "" {
			view = "student"
		}
		if view != "student" && view != "tutor" && view != "full" {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid view parameter (must be student, tutor, or full)"})
			return
		}

		var perTestTimeout time.Duration
		if body.PerTestTimeoutSec > 0 {
			perTestTimeout = time.Duration(body.PerTestTimeoutSec * float64(time.Second))
		}

		res, err := r.Run(req.Context(), sandbox.RunRequest{
			Code:           body.Code,
			Tests:          body.Tests,
			PerTestTimeout: perTestTimeout,
		})
		if err != nil {
			writeRunnerError(w, err)
			return
		}
		if res.Status == sandbox.StatusInternalErr {
			log.Printf("sandbox internal_error (duration=%dms): %s", res.DurationMs, res.InternalError)
		}

		switch view {
		case "tutor":
			writeJSON(w, http.StatusOK, res.ToTutorContext())
		case "full":
			writeJSON(w, http.StatusOK, res)
		default:
			writeJSON(w, http.StatusOK, res.ToStudentView())
		}
	})

	mux.HandleFunc("POST /validate", func(w http.ResponseWriter, req *http.Request) {
		var body validateHTTPRequest
		if !decodeJSONBody(w, req, &body) {
			return
		}

		vr, err := r.ValidateLab(req.Context(), body.Solution, body.Tests)
		if err != nil {
			writeRunnerError(w, err)
			return
		}
		if vr.Status == sandbox.StatusInternalErr {
			log.Printf("sandbox validate internal_error (duration=%dms): %s", vr.DurationMs, vr.Summary)
		}

		status := http.StatusOK
		if !vr.Valid {
			status = http.StatusUnprocessableEntity
		}
		writeJSON(w, status, vr)
	})

	return mux
}

func decodeJSONBody(w http.ResponseWriter, req *http.Request, dst any) bool {
	req.Body = http.MaxBytesReader(w, req.Body, maxRequestBodyBytes)
	dec := json.NewDecoder(req.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeJSON(w, http.StatusRequestEntityTooLarge, errorResponse{Error: "request body too large"})
			return false
		}
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid JSON request body"})
		return false
	}
	return true
}

func writeRunnerError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, sandbox.ErrCodeTooLarge), errors.Is(err, sandbox.ErrTestsTooLarge):
		writeJSON(w, http.StatusRequestEntityTooLarge, errorResponse{Error: err.Error()})
	case errors.Is(err, sandbox.ErrQueueFull):
		writeJSON(w, http.StatusTooManyRequests, errorResponse{Error: err.Error()})
	case errors.Is(err, sandbox.ErrSandboxUnavailable):
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Error: err.Error()})
	default:
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: err.Error()})
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func configFromEnv() sandbox.Config {
	cfg := sandbox.DefaultConfig()
	if img := os.Getenv("SANDBOX_IMAGE"); img != "" {
		cfg.Image = img
	}
	if v, ok := envPositiveInt("SANDBOX_MAX_CONCURRENT"); ok {
		cfg.MaxConcurrent = v
	}
	if v, ok := envPositiveInt("SANDBOX_QUEUE_WAIT_SEC"); ok {
		cfg.QueueWaitTimeout = time.Duration(v) * time.Second
	}
	if v, ok := envPositiveInt("SANDBOX_PER_TEST_TIMEOUT_SEC"); ok {
		cfg.PerTestTimeout = time.Duration(v) * time.Second
	}
	if v, ok := envPositiveInt("SANDBOX_CONTAINER_TIMEOUT_SEC"); ok {
		cfg.ContainerTimeout = time.Duration(v) * time.Second
	}
	return cfg
}

func envPositiveInt(key string) (int, bool) {
	raw := os.Getenv(key)
	if raw == "" {
		return 0, false
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v <= 0 {
		return 0, false
	}
	return v, true
}

func main() {
	addr := os.Getenv("RUNNER_ADDR")
	if addr == "" {
		addr = ":8081"
	}

	initCtx, cancelInit := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelInit()

	runner, err := sandbox.NewRunner(initCtx, configFromEnv())
	if err != nil {
		log.Fatalf("failed to initialize sandbox runner: %v", err)
	}
	defer func() {
		_ = runner.Close()
	}()

	srv := &http.Server{
		Addr:              addr,
		Handler:           NewHandler(runner),
		ReadHeaderTimeout: 5 * time.Second,
	}

	stopCh := make(chan os.Signal, 1)
	signal.Notify(stopCh, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-stopCh
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Printf("sandbox runner listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("runner server error: %v", err)
	}
}
