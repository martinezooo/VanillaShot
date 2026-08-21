# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/hack-jitsu/VanillaShot/security/advisories/new)
rather than opening a public issue.

Include what you did, what happened, and what you expected. A proof of concept
helps, but a clear description is enough to start.

There is no bounty and no formal response-time commitment — this is a
single-maintainer project. Reports are read and acted on in good faith.

## Supported versions

Only the latest release is supported. VanillaShot is pre-1.0 and has no in-app
updater, so fixes reach you by rebuilding from source.

## Threat model

VanillaShot is a local, offline tool. It makes no network requests, has no
server, no account and no telemetry, so the usual remote attack surface does not
apply. What is worth scrutiny:

- **The screen-memory store.** Recordings, keyframes and the OCR index live
  unencrypted under `~/Library/Application Support/com.hackjitsu.vanillashot/`.
  Any process running as the same user can read them without a macOS permission
  prompt. This is a known limitation, documented in the README, not a defect
  report — but attacks that reach it from *outside* that trust boundary are.
- **The `vanillashot://` URL scheme.** The verb set is fixed and takes no
  payloads, but any local process — or a web page the user clicks through — can
  invoke it, including `memory/start`. Findings that widen this surface, or that
  get arbitrary data through it, are in scope.
- **Redaction correctness.** If a redaction can be reversed — recoverable pixels
  under a blur or blackout, original data surviving in the exported PNG or its
  metadata, a masked barcode still decodable — that is a security bug, and one
  of the more serious kinds here, because the whole point of the tool is that a
  redacted screenshot is safe to share.
- **Detection gaps.** A secret format that goes unflagged is a bug worth
  reporting, though the tool is explicitly a safety net rather than a guarantee:
  always check a screenshot before sharing it.

## Out of scope

- The absence of code signing and notarisation. This is known and documented;
  builds are ad-hoc signed and meant to be built from source.
- Anything requiring an attacker who already has code execution as the user, for
  reading the screen-memory store (see above).
