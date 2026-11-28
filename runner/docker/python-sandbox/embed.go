package pythonsandbox

import "embed"

// Files embeds Dockerfile and harness.py directly into compiled Go binaries so
// the runner can build the sandbox image without external files on disk.
//
//go:embed Dockerfile harness.py
var Files embed.FS
