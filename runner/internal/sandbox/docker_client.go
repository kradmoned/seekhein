package sandbox

import (
	"context"
	"io"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/build"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

// dockerAPI abstracts the subset of the Docker Go SDK used by Runner so
// lifecycle and hardening behavior can be unit-tested without a daemon.
type dockerAPI interface {
	Ping(ctx context.Context) (types.Ping, error)
	ImageInspect(ctx context.Context, imageID string, inspectOpts ...client.ImageInspectOption) (image.InspectResponse, error)
	ImageBuild(ctx context.Context, buildContext io.Reader, options build.ImageBuildOptions) (build.ImageBuildResponse, error)
	ContainerCreate(ctx context.Context, config *container.Config, hostConfig *container.HostConfig, networkingConfig *network.NetworkingConfig, platform *ocispec.Platform, containerName string) (container.CreateResponse, error)
	ContainerAttach(ctx context.Context, containerID string, options container.AttachOptions) (types.HijackedResponse, error)
	ContainerStart(ctx context.Context, containerID string, options container.StartOptions) error
	ContainerWait(ctx context.Context, containerID string, condition container.WaitCondition) (<-chan container.WaitResponse, <-chan error)
	ContainerInspect(ctx context.Context, containerID string) (container.InspectResponse, error)
	ContainerRemove(ctx context.Context, containerID string, options container.RemoveOptions) error
	Close() error
}

type sdkDockerClient struct {
	cli *client.Client
}

func (s *sdkDockerClient) Ping(ctx context.Context) (types.Ping, error) {
	return s.cli.Ping(ctx)
}

func (s *sdkDockerClient) ImageInspect(ctx context.Context, imageID string, inspectOpts ...client.ImageInspectOption) (image.InspectResponse, error) {
	return s.cli.ImageInspect(ctx, imageID, inspectOpts...)
}

func (s *sdkDockerClient) ImageBuild(ctx context.Context, buildContext io.Reader, options build.ImageBuildOptions) (build.ImageBuildResponse, error) {
	return s.cli.ImageBuild(ctx, buildContext, options)
}

func (s *sdkDockerClient) ContainerCreate(ctx context.Context, config *container.Config, hostConfig *container.HostConfig, networkingConfig *network.NetworkingConfig, platform *ocispec.Platform, containerName string) (container.CreateResponse, error) {
	return s.cli.ContainerCreate(ctx, config, hostConfig, networkingConfig, platform, containerName)
}

func (s *sdkDockerClient) ContainerAttach(ctx context.Context, containerID string, options container.AttachOptions) (types.HijackedResponse, error) {
	return s.cli.ContainerAttach(ctx, containerID, options)
}

func (s *sdkDockerClient) ContainerStart(ctx context.Context, containerID string, options container.StartOptions) error {
	return s.cli.ContainerStart(ctx, containerID, options)
}

func (s *sdkDockerClient) ContainerWait(ctx context.Context, containerID string, condition container.WaitCondition) (<-chan container.WaitResponse, <-chan error) {
	return s.cli.ContainerWait(ctx, containerID, condition)
}

func (s *sdkDockerClient) ContainerInspect(ctx context.Context, containerID string) (container.InspectResponse, error) {
	return s.cli.ContainerInspect(ctx, containerID)
}

func (s *sdkDockerClient) ContainerRemove(ctx context.Context, containerID string, options container.RemoveOptions) error {
	return s.cli.ContainerRemove(ctx, containerID, options)
}

func (s *sdkDockerClient) Close() error {
	return s.cli.Close()
}
