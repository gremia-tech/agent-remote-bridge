# Container image of a released bridge kit: ghcr.io/gremia-tech/agent-remote-bridge.
# Build context: a dist/ folder holding the linux-x64 and linux-arm64 kits of one release.
#   docker run -d -p 8788:8788 -v relay:/state ghcr.io/gremia-tech/agent-remote-bridge relay serve --listen 0.0.0.0 --state /state
#   docker run -it -p 8443:8443 -v bridge:/state ghcr.io/gremia-tech/agent-remote-bridge up --backend plain --no-console --state /state
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3 AS kit
ARG TARGETARCH VERSION
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
COPY dist/ /dist/
RUN case "$TARGETARCH" in amd64) a=x64 ;; arm64) a=arm64 ;; *) exit 1 ;; esac \
 && unzip -q "/dist/agent-remote-bridge-$VERSION-linux-$a.zip" -d /opt

FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
ARG VERSION
LABEL org.opencontainers.image.source="https://github.com/gremia-tech/agent-remote-bridge" \
      org.opencontainers.image.description="AI Agent Remote bridge and relay (herdr-remote)" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="$VERSION"
# openssl creates the bridge's certificate; git, procps and bash serve the plain-terminal backend.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl git procps bash \
 && rm -rf /var/lib/apt/lists/* && useradd -m -s /bin/bash bridge && mkdir /state && chown bridge:bridge /state && chmod 700 /state
COPY --from=kit /opt/agent-remote /opt/agent-remote
RUN ln -s /opt/agent-remote/herdr-remote /usr/local/bin/herdr-remote
USER bridge
WORKDIR /home/bridge
ENV HERDR_REMOTE_DESKTOP_NOTIFY=0
EXPOSE 8443 8788
ENTRYPOINT ["herdr-remote"]
CMD ["--help"]
