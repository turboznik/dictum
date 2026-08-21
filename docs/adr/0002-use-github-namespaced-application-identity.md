# Use a GitHub-namespaced application identity

Dictum uses `io.github.turboznik.dictum` as its permanent Tauri identifier. A namespace tied to the repository owner provides a conventional uniqueness claim without requiring a separately controlled domain; keeping it stable also preserves Dictum's Windows application, storage, and single-instance identity across releases.
