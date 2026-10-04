#!/bin/sh
# Post the [TEST] message using the already-running container.
#
# The host has no node — the app only exists inside the image — so this shells
# out to docker exec rather than running node directly.
set -e
exec docker exec flockord node src/index.js --test "$@"