# mausbridge: where this Mac keeps the agent CLIs that ship inside desktop apps. Sourced by the other scripts.
# Override any of these in the environment; nothing here is installed globally.
: "${MAUSBRIDGE_CODEX_DIR:=$HOME/Desktop/软件管理/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS}"
: "${MAUSBRIDGE_DSH_DIR:=$HOME/Desktop/软件管理/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin}"
export PATH="$MAUSBRIDGE_CODEX_DIR:$MAUSBRIDGE_DSH_DIR:$HOME/.local/bin:$PATH"
