package sandbox

import (
	"fmt"
	"time"
)

const (
	DefaultImage              = "seekkhein-python-sandbox:latest"
	DefaultMaxConcurrent      = 4
	DefaultQueueWaitTimeout   = 10 * time.Second
	DefaultPerTestTimeout     = 2 * time.Second
	DefaultContainerTimeout   = 6 * time.Second
	DefaultMaxCodeBytes       = 64 * 1024
	DefaultMaxTestsBytes      = 64 * 1024
	DefaultMaxStdoutBytes     = 16 * 1024
	DefaultMaxTestStdoutBytes = 4 * 1024
	DefaultMemoryLimitBytes   = int64(128 * 1024 * 1024)
	DefaultNanoCPUs           = int64(500_000_000)
	DefaultPidsLimit          = int64(64)
)

// Config controls container resource limits, timeouts, and worker concurrency.
type Config struct {
	Image              string
	AutoBuildImage     bool
	MaxConcurrent      int
	QueueWaitTimeout   time.Duration
	PerTestTimeout     time.Duration
	ContainerTimeout   time.Duration
	MaxCodeBytes       int
	MaxTestsBytes      int
	MaxStdoutBytes     int
	MaxTestStdoutBytes int
	MemoryLimitBytes   int64
	NanoCPUs           int64
	PidsLimit          int64
}

// DefaultConfig returns a Config populated with production-safe hackathon defaults.
func DefaultConfig() Config {
	return Config{
		Image:              DefaultImage,
		MaxConcurrent:      DefaultMaxConcurrent,
		QueueWaitTimeout:   DefaultQueueWaitTimeout,
		PerTestTimeout:     DefaultPerTestTimeout,
		ContainerTimeout:   DefaultContainerTimeout,
		MaxCodeBytes:       DefaultMaxCodeBytes,
		MaxTestsBytes:      DefaultMaxTestsBytes,
		MaxStdoutBytes:     DefaultMaxStdoutBytes,
		MaxTestStdoutBytes: DefaultMaxTestStdoutBytes,
		MemoryLimitBytes:   DefaultMemoryLimitBytes,
		NanoCPUs:           DefaultNanoCPUs,
		PidsLimit:          DefaultPidsLimit,
	}
}

func (c Config) withDefaults() Config {
	d := DefaultConfig()
	if c.Image == "" {
		c.Image = d.Image
	}
	if c.MaxConcurrent <= 0 {
		c.MaxConcurrent = d.MaxConcurrent
	}
	if c.QueueWaitTimeout <= 0 {
		c.QueueWaitTimeout = d.QueueWaitTimeout
	}
	if c.PerTestTimeout <= 0 {
		c.PerTestTimeout = d.PerTestTimeout
	}
	if c.ContainerTimeout <= 0 {
		c.ContainerTimeout = d.ContainerTimeout
	}
	if c.MaxCodeBytes <= 0 {
		c.MaxCodeBytes = d.MaxCodeBytes
	}
	if c.MaxTestsBytes <= 0 {
		c.MaxTestsBytes = d.MaxTestsBytes
	}
	if c.MaxStdoutBytes <= 0 {
		c.MaxStdoutBytes = d.MaxStdoutBytes
	}
	if c.MaxTestStdoutBytes <= 0 {
		c.MaxTestStdoutBytes = d.MaxTestStdoutBytes
	}
	if c.MemoryLimitBytes <= 0 {
		c.MemoryLimitBytes = d.MemoryLimitBytes
	}
	if c.NanoCPUs <= 0 {
		c.NanoCPUs = d.NanoCPUs
	}
	if c.PidsLimit <= 0 {
		c.PidsLimit = d.PidsLimit
	}
	return c
}

func (c Config) validate() error {
	if c.ContainerTimeout < c.PerTestTimeout {
		return fmt.Errorf("sandbox: ContainerTimeout (%s) must be >= PerTestTimeout (%s)", c.ContainerTimeout, c.PerTestTimeout)
	}
	if c.MaxTestStdoutBytes > c.MaxStdoutBytes {
		return fmt.Errorf("sandbox: MaxTestStdoutBytes (%d) must be <= MaxStdoutBytes (%d)", c.MaxTestStdoutBytes, c.MaxStdoutBytes)
	}
	return nil
}
