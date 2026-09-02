#!/usr/bin/env bash
# Run once after cloning: points git at the repo's hooks and checks gitleaks is available.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
chmod +x .githooks/*
if command -v gitleaks >/dev/null 2>&1; then
  echo "Hooks enabled. gitleaks $(gitleaks version) found."
else
  cat <<'EOF'
Hooks enabled, but gitleaks is not installed. Install it:
  macOS:   brew install gitleaks
  Windows: winget install gitleaks   (or: scoop install gitleaks)
  Linux:   see https://github.com/gitleaks/gitleaks#installing
Commits are blocked until it is present.
EOF
fi
