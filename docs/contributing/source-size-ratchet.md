# Source-size ratchet

`pnpm check:loc` enforces at most 500 non-comment, nonblank physical source
lines for every new governed source file. A pre-existing governed file may not
exceed the greater of 500 lines or its exact immutable-base count.

The checker evaluates the immutable-base-to-index and immutable-base-to-working
tree snapshots separately. A staged representation cannot borrow a working-tree
allowance. Renames preserve an allowance only when the exact old base path was
already governed; copies and newly governed executable/shebang files are new.
The checker reads index blobs and working-tree files through separate,
descriptor-safe paths and fails closed on malformed paths, nonregular files,
invalid UTF-8, races, or resource exhaustion.

For TypeScript/JavaScript, Rust, Python, and shell files, a small lexical
scanner excludes only comment-only physical lines. It recognizes quoted text,
multiline comments/strings, Rust raw strings, and shell heredoc payloads so a
comment marker inside data is not treated as a comment. Other governed formats
use the conservative nonblank metric. A line containing both code and a
comment counts as code; string and heredoc payload lines count as source.

The root `prepack` lifecycle runs this gate before build work. The Docker
packager intentionally disables npm lifecycle scripts, so it calls the same
checker explicitly before it creates build output or a tarball. There is one
policy implementation, not two independent ratchets.

## U18234 provenance

`9044f390634b1bb0a7a5347f33d039035617c5ec` is a local, isolated U18234 intake
candidate, not an official upstream OpenClaw commit. It is outside the frozen
Moira history and is unavailable as an object in this worktree, so this port
does not claim to cherry-pick it or to preserve an unverifiable upstream patch.
The preserved, reproducible evidence is the clean frozen-lineage P00 port:
`ace8de8173fe95ba61312e421a33b7a9f8d4900f`, parent
`e9030d5476e5572a44ba89f653bc5c6c428ea351`, with its five changed paths. Any
future intake report must retain that distinction and bind a recoverable patch
or source object before making stronger provenance claims.
