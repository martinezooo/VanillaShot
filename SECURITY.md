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

**Untrusted text reaching a sink.** Decoded payloads and OCR text are rendered
as text and copied on request, and nothing else. The build ships no shell or
opener plugin, both `/usr/bin/open` call sites pass a constant compiled into the
binary, and no payload reaches a filename, a path, or a query. Anything that
breaks one of those statements is in scope.

**Redaction correctness.** This is the most serious bug class here, because the
whole point of the tool is that a redacted screenshot is safe to share. Report
anything that lets a redaction be reversed: recoverable pixels under a blur or
blackout, original data surviving in the exported PNG or its metadata, or a
masked barcode that still decodes.

Blackout is drawn fully opaque, with the compositing state forced rather than
inherited, so no trace of the original pixels reaches the export. Earlier builds
drew it at 98% opacity, which left the source pattern recoverable with a levels
stretch. That is fixed in 0.2.1.

**Classifier bypasses.** Decoded barcode payloads and OCR text are
attacker-controlled. If you can craft a payload that carries a secret past the
classifier and out of "Mask all sensitive", that is a bug worth reporting.
Invisible characters are stripped before classification for this reason, and
unknown URI schemes are treated as sensitive rather than plain text.

**Detection gaps.** A secret format that goes unflagged is worth reporting. The
tool is a safety net rather than a guarantee, so always check a screenshot
before sharing it.

## Out of scope

The absence of Apple notarisation. This is known and documented. The published
DMG is signed but not notarised, so macOS asks before opening it once.

Anything that requires an attacker who already has code execution as the user,
for reading the screen-memory store. See above.
