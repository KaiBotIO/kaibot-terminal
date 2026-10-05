# Thin wrapper around the prebuilt, self-contained daemon binary. The build
# context is expected to contain a Linux x86_64 `kaibot-terminal` binary and the
# built web UI in `dist/` (produced by the release workflow), NOT the monorepo.
#
#   docker build -t kaibot-terminal \
#     --build-arg BINARY=kaibot-terminal-x86_64-unknown-linux-gnu \
#     -f apps/kaibot-terminal/Dockerfile .
#
# Run:
#   docker run -p 8080:8080 -v kaibot-data:/data \
#     -e KAIBOT_API_URL=https://api.example.com \
#     -e EXECUTOR_SESSION_TOKEN=... kaibot-terminal
FROM debian:bookworm-slim

ARG BINARY=kaibot-terminal

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY ${BINARY} /usr/local/bin/kaibot-terminal
COPY dist /opt/kaibot/dist
RUN chmod +x /usr/local/bin/kaibot-terminal

# Isolated, persistent data dir; the daemon writes its DB + .port under a profile
# rooted at HOME, so pointing HOME at the volume keeps state across restarts.
ENV KAIBOT_BUILD_TYPE=docker \
    KAIBOT_STATIC_DIR=/opt/kaibot/dist \
    KAIBOT_PROFILE=docker \
    HOME=/data \
    PORT=8080
VOLUME ["/data"]
WORKDIR /data
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/kaibot-terminal"]
