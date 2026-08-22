# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/martinezooo/VanillaShot/security/advisories/new)
rather than opening a public issue.

Include what you did, what happened, and what you expected. A proof of concept
helps, but a clear description is enough to start.

There is no bounty and no formal response-time commitment. This is a
single-maintainer project. Reports are read and acted on in good faith.

## Supported versions

Only the latest release is supported. VanillaShot is pre-1.0 and has no in-app
updater, so fixes reach you by rebuilding from source.

## Threat model

VanillaShot is a local, offline tool. It makes no network requests, has no
server, no account and no telemetry, so the usual remote attack surface does not
apply. What is worth scrutiny:

**The screen-memory store.** Recordings, keyframes and the OCR index live
unencrypted under `~/Library/Application Support/com.hackjitsu.vanillashot/`.
Any process running as the same user can read them without a macOS permission
prompt. That much is a known limitation, documented in the README, and not a
defect report. Attacks that reach the store from outside that trust boundary are
in scope.

**The `vanillashot://` URL scheme.** The verb set is fixed and takes no
payloads, but any local process can invoke it, including `memory/start`, and so
can a web page the user clicks through. Findings that widen this surface, or
that get arbitrary data through it, are in scope.

**Redaction correctness.** This is the most serious bug class here, because the
whole point of the tool is that a redacted screenshot is safe to share. Report
anything that lets a redaction be reversed: recoverable pixels under a blur or
blackout, original data surviving in the exported PNG or its metadata, or a
masked barcode that still decodes.

**Detection gaps.** A secret format that goes unflagged is worth reporting. The
tool is a safety net rather than a guarantee, so always check a screenshot
before sharing it.

## Out of scope

The absence of code signing and notarisation. This is known and documented.
Builds are ad-hoc signed and meant to be built from source.

Anything that requires an attacker who already has code execution as the user,
for reading the screen-memory store. See above.
