# Code Signing Policy

DevDeck's Windows installer is digitally signed so you can verify it really comes
from this project and has not been tampered with after release.

## Signing

Free code signing for DevDeck is provided by [SignPath.io](https://signpath.io),
using a free code signing certificate issued by the
[SignPath Foundation](https://signpath.org).

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
