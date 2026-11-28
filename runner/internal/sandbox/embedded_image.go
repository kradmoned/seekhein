package sandbox

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
	"time"

	"github.com/docker/docker/api/types/build"
	pythonsandbox "github.com/kradmoned/seekhein/docker/python-sandbox"
)

const embeddedDigestLabel = "seekkhein.sandbox.digest"

var embeddedSandboxFiles = []string{"Dockerfile", "harness.py"}

func buildEmbeddedTar() (*bytes.Buffer, string, error) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	h := sha256.New()

	for _, name := range embeddedSandboxFiles {
		data, err := pythonsandbox.Files.ReadFile(name)
		if err != nil {
			_ = tw.Close()
			return nil, "", fmt.Errorf("read embedded %s: %w", name, err)
		}
		_, _ = fmt.Fprintf(h, "%s:%d\n", name, len(data))
		_, _ = h.Write(data)

		if err := tw.WriteHeader(&tar.Header{
			Name: name,
			Mode: 0o644,
			Size: int64(len(data)),
		}); err != nil {
			_ = tw.Close()
			return nil, "", fmt.Errorf("write tar header for %s: %w", name, err)
		}
		if _, err := tw.Write(data); err != nil {
			_ = tw.Close()
			return nil, "", fmt.Errorf("write tar body for %s: %w", name, err)
		}
	}

	if err := tw.Close(); err != nil {
		return nil, "", fmt.Errorf("close tar archive: %w", err)
	}
	return &buf, hex.EncodeToString(h.Sum(nil)), nil
}

func parseImageBuildStream(r io.Reader) error {
	type buildStreamMsg struct {
		Error       string `json:"error"`
		ErrorDetail struct {
			Message string `json:"message"`
		} `json:"errorDetail"`
	}

	dec := json.NewDecoder(r)
	for {
		var msg buildStreamMsg
		err := dec.Decode(&msg)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("decode docker build output: %w", err)
		}
		if msg.ErrorDetail.Message != "" {
			return errors.New(strings.TrimSpace(msg.ErrorDetail.Message))
		}
		if msg.Error != "" {
			return errors.New(strings.TrimSpace(msg.Error))
		}
	}
}

func ensureImage(ctx context.Context, cli dockerAPI, cfg Config) error {
	inspectCtx, cancelInspect := context.WithTimeout(ctx, 5*time.Second)
	defer cancelInspect()

	inspected, inspectErr := cli.ImageInspect(inspectCtx, cfg.Image)
	if !cfg.AutoBuildImage {
		if inspectErr != nil {
			return fmt.Errorf("%w: sandbox image %q not found (build with 'make sandbox-image'): %v", ErrSandboxUnavailable, cfg.Image, inspectErr)
		}
		return nil
	}

	tarBuf, digest, err := buildEmbeddedTar()
	if err != nil {
		return fmt.Errorf("%w: prepare embedded sandbox build context: %v", ErrSandboxUnavailable, err)
	}

	if inspectErr == nil {
		existing := ""
		if inspected.Config != nil && inspected.Config.Labels != nil {
			existing = inspected.Config.Labels[embeddedDigestLabel]
		}
		if existing == "" || existing == digest {
			return nil
		}
		log.Printf("sandbox: embedded image %s is outdated, rebuilding...", cfg.Image)
	} else {
		log.Printf("sandbox: building embedded image %s...", cfg.Image)
	}

	resp, err := cli.ImageBuild(ctx, tarBuf, build.ImageBuildOptions{
		Tags:        []string{cfg.Image},
		Dockerfile:  "Dockerfile",
		Remove:      true,
		ForceRemove: true,
		Labels:      map[string]string{embeddedDigestLabel: digest},
	})
	if err != nil {
		return fmt.Errorf("%w: auto-building sandbox image %q failed: %v", ErrSandboxUnavailable, cfg.Image, err)
	}
	defer resp.Body.Close()

	if err := parseImageBuildStream(resp.Body); err != nil {
		return fmt.Errorf("%w: auto-building sandbox image %q failed: %v", ErrSandboxUnavailable, cfg.Image, err)
	}

	log.Printf("sandbox: built embedded image %s", cfg.Image)
	return nil
}
