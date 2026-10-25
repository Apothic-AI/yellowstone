# Test environment for the Yellowstone installer.
#
# Why this exists: install.sh and scripts/*.sh write to ~/.config/herdr,
# ~/.pi/agent, ~/.agents/skills and ~/.local/bin. Testing them on a working
# machine means either trusting that every write is a no-op, or auditing
# afterwards. In a container the question does not arise — the whole HOME is
# expendable, and a mistake costs a rebuild.
#
# Two things this catches that a manual audit does not:
#   * writes that claim to be no-ops ("unchanged") but are not;
#   * the idempotency test that installs an already-installed package, which
#     rewrites ~/.pi/agent/npm/package-lock.json even when the dependency set is
#     identical.
#
# Usage (from the repo root):
#   docker build -f test/Dockerfile -t yellowstone-test .
#   docker run --rm yellowstone-test              # full suite
#   docker run --rm yellowstone-test smoke        # fast subset
#   docker run --rm -v "$PWD:/repo:ro" yellowstone-test   # test the mounted repo
#
# The repo is baked in at build time so the image also works with no network
# beyond what the build already needed. Mount over /repo to test a work tree.

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PYTHONUNBUFFERED=1

# git        plugin installs and package updates
# python3    helper parsing in herdr-agy.sh and some plugins
# curl/ca-certificates  the herdr and pi installers
# procps     pgrep in scripts that check for running agents
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        python3 \
        curl \
        ca-certificates \
        procps \
        jq \
        diffutils \
    && rm -rf /var/lib/apt/lists/*

# A non-root user with a HOME, because the scripts deliberately refuse to touch
# root-owned config and because ~/.local/bin must be writable. node:*-slim
# already owns UID 1000 (the `node` user), so reuse it rather than inventing a
# second UID and chowning everything twice.
RUN id -u tester >/dev/null 2>&1 || useradd -m -s /bin/bash tester

# --- the real installers, so the tests exercise real binaries -----------------
# These are what a new machine runs. Installing them here rather than stubbing
# them is the point: a stub would not have herdr's plugin manifest format.
USER tester
WORKDIR /home/tester
RUN curl -fsSL https://herdr.dev/install.sh | sh \
    && curl -fsSL https://pi.dev/install.sh | sh
# The pi managed installer activates at ~/.pi/agent/bin, not ~/.local/bin.
ENV PATH="/home/tester/.pi/agent/bin:/home/tester/.local/bin:${PATH}"

# --- the repo under test ------------------------------------------------------
# Copied rather than mounted so `docker run` works without flags. The suite
# re-copies from /repo when that mount exists.
USER root
COPY --chown=tester:tester . /repo
USER tester
WORKDIR /repo

# Fail the build if the image cannot even load the config it was built from.
# `pi` may land in either ~/.local/bin (managed installer) or node's global
# prefix (npm), so check both rather than assuming one layout.
ENV PATH="/home/tester/.pi/agent/bin:/home/tester/.local/bin:/usr/local/bin:${PATH}"
RUN sh -c 'set -e; herdr --version; node --version; if command -v pi >/dev/null 2>&1; then pi --version; else echo "pi not on PATH after install" >&2; ls -la /home/tester/.local/bin /usr/local/bin >&2; exit 1; fi'

COPY --chown=tester:tester test/run-tests.sh /home/tester/run-tests.sh
RUN chmod +x /home/tester/run-tests.sh

ENTRYPOINT ["/home/tester/run-tests.sh"]
CMD ["all"]
