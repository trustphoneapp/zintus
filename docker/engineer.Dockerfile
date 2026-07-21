FROM oven/bun:1.3.14

USER root
RUN apt-get update \
  && apt-get install --yes --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

USER bun
