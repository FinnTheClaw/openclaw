# Conservative source-size ratchet

`pnpm check:loc` enforces a maximum of 500 nonblank physical lines for new or newly governed source files. Existing governed files may not exceed the greater of 500 lines or their exact count in the immutable base commit.

The checker deliberately does not parse comments, strings, templates, or any programming language. Every nonblank physical line is counted, including comment-only lines. This stricter mechanical metric guarantees that a file containing at most 500 counted lines cannot contain more than 500 non-comment code lines.

For each changed path, the checker independently validates the immutable base blob, staged Git index blob and mode, and working-tree file and mode. When staged and working content differ, both representations must pass. Copies and files that become governed through a rename, executable bit, or shebang receive the new-file limit unless the exact base path was already governed.
