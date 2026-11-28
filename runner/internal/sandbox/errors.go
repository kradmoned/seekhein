package sandbox

import "errors"

var (
	// ErrCodeTooLarge is returned when submitted student code exceeds Config.MaxCodeBytes.
	ErrCodeTooLarge = errors.New("sandbox: code exceeds maximum size")
	// ErrTestsTooLarge is returned when lab test code exceeds Config.MaxTestsBytes.
	ErrTestsTooLarge = errors.New("sandbox: tests exceed maximum size")
	// ErrQueueFull is returned when all container worker slots remain busy past QueueWaitTimeout.
	ErrQueueFull = errors.New("sandbox: worker queue saturated")
	// ErrSandboxUnavailable is returned when the Docker daemon or configured sandbox image is unavailable.
	ErrSandboxUnavailable = errors.New("sandbox: docker daemon or image unavailable")
)
