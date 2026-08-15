# Functional Finn verifier

This local CPU process is the semantic-support component of the release and memory-admission boundary. Mechanical scope, span, freshness, and state checks remain authoritative.

Pinned model inputs:

- `vectara/hallucination_evaluation_model` revision `8e4a2e6e96c708cc76c2344f7e4757df2515292c`
- `model.safetensors` SHA-256 `634de18a38cf1e991c1acd0f7a9e0d30f7ea187fba42bb4798f862d3edd31e72`
- `google/flan-t5-base` revision `7bcac572ce56db69c1ea7c8af255c5d7c9672fc2`

Deployment uses an isolated versioned virtual environment and model bundle. Set `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`; the server never downloads models. The Ed25519 private key and socket are runtime secrets outside Git. Signal receives only the public key.
