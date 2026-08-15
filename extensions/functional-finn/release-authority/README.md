# Functional Finn release authority (source-complete transport slice)

This directory contains the non-live source for a two-service Signal release
boundary. It includes a private `signal-cli 0.14.5` stdio JSON-RPC adapter and
launchd entrypoints, but it does not install, load, or mutate services.

- `_finnrel` accepts untrusted response candidates only from the attested
  `_openclaw` Unix peer, validates evidence, owns the canonical release ledger,
  and signs an immutable text frame with its Ed25519 key.
- `_finnsig` accepts only frames signed by `_finnrel`, owns the sender ledger and
  eventual Signal linked-device store, and is the only process allowed to call a
  physical Signal sender.
- `_openclaw` has neither key nor Signal-store access. Its only intended endpoints
  are candidate submission and normalized-ingress retrieval.

`_finnsig` launches one absolute, root-attested `signal-cli --config <private>
-a <account> jsonRpc` child without a shell. Stdout is byte-bounded before JSON
parsing, requests are exactly correlated, `receive` notifications become durable
normalized ingress, and a send succeeds only with a positive timestamp. A crash
after attempt admission is durable `UNKNOWN` and is never automatically retried.

`_finnrel` invokes HHEM only through a separate offline worker process. Mechanical
span, freshness, provenance, and exact-message checks remain authoritative; model
unavailability, timeout, malformed output, or insufficient support fail closed.

The MVP codec is strict canonical UTF-8 JSON because this frozen source tree has
no CBOR implementation. A four-byte big-endian frame length is checked before the
body is read or parsed. The signed text frame is a fixed-order positional array;
decoding must reproduce the exact bytes.

Run only the deterministic foundation tests:

```sh
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=extensions/functional-finn/release-authority \
python3 -m unittest discover \
  -s extensions/functional-finn/release-authority/tests -t . -v
```

The files under `deployment/` remain inert templates. The scripts default to a
plan and require `--apply`; production use additionally requires the gates in
the architecture plan. This source slice does not claim the `_finnsig` UID,
filesystem, linked-device, or physical-send isolation proofs.
