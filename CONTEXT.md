# Dictum

Dictum is a corporate speech-to-text product adapted from Handy while maintaining its own identity and installation boundary.

## Language

**Dictum**:
The current speech-to-text product and the identity presented to its users.
_Avoid_: Handy, fork

**Handy**:
The upstream project on which Dictum is based, or a feature or dependency whose proper name includes Handy. It does not refer to the current product.

**Side-by-side installation**:
Handy and Dictum installed as separate products with distinct application identities and data. It does not promise that both applications can safely transcribe at the same time.

**Dictum server**:
The Deno service that contains Dictum's model mirror and post-processing gateway.

**Model mirror**:
The selectively populated, Hugging Face-compatible service from which Dictum downloads approved speech-to-text models. It serves an offline snapshot and never contacts Hugging Face at runtime.
_Avoid_: Hugging Face proxy

**Post-processing gateway**:
The authenticated, OpenAI-compatible service that forwards Dictum's post-processing requests to OpenRouter.

**Upstream model catalog**:
The complete, pinned snapshot of Dictum-compatible speech-to-text models available from the upstream model publisher.
_Avoid_: Available models, live catalog

**Dictum model catalog**:
The selected subset of the upstream model catalog embedded in a particular Dictum desktop build.
_Avoid_: Upstream model catalog

**Model allowlist**:
The set of upstream model identifiers an adopter chooses to include in the Dictum model catalog and model mirror.
