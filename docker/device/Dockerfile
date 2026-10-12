# The device container's image: the agent image plus libcwh-nodelete, preloaded into every process so a delete in
# a connected folder is refused until the user allows it, as production refuses it. Built locally on first use by
# the harness (src/runtime/device-image.ts) from this directory, on top of the resolved agent image; never
# published. The compile stage uses the agent image's own pinned base, so the library links against the glibc it
# loads into.
ARG BASE=cowork-agent-base:2

FROM --platform=linux/arm64 ubuntu:22.04@sha256:3b06811b2afd352be909dd088a004166d665dc76d38b13eada33522a9d915c6f AS shim
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY nodelete.c /src/nodelete.c
# Warnings never fail the on-demand build (a newer apt gcc must not break every bridge run); CI builds this stage
# with CFLAGS="-Wall -Wextra -Werror".
ARG CFLAGS="-Wall"
RUN gcc -shared -fPIC -O2 ${CFLAGS} -o /libcwh-nodelete.so /src/nodelete.c -ldl

FROM ${BASE}
COPY --from=shim /libcwh-nodelete.so /opt/cowork/lib/libcwh-nodelete.so
# COPY, not a RUN that writes it: the base image's last USER is not root, and COPY leaves the file root-owned 0644,
# which the device user (non-root, read-only root filesystem) cannot change.
COPY ld.so.preload /etc/ld.so.preload
