# Code Signing Policy

This document describes how DevDeck's Windows installer is code-signed so users
can verify it really comes from this project and has not been tampered with after
release.

## Signing

DevDeck has applied to the [SignPath Foundation](https://signpath.org) free
code-signing program. Once approved, free code signing is provided by
[SignPath.io](https://signpath.io) using a certificate issued by the SignPath
Foundation. Until the certificate is issued, release installers are unsigned.

## Project roles

- **Author / Committer:** Jordi Tomás ([@Jorditomasg](https://github.com/Jorditomasg))
- **Reviewer / Approver:** Jordi Tomás

Only the listed maintainer may commit to the release branch and approve signed
releases.

## Privacy policy

DevDeck runs entirely on your machine and manages local development services. It
does not collect, store or transmit personal data. The only outbound network
request is the built-in updater, which fetches release metadata and installers
from this project's GitHub Releases to offer in-app updates. Every update is
verified against a public key bundled in the app before anything is installed.
