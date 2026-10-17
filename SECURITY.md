# Security policy

## Reporting a vulnerability

Please do not disclose exploitable vulnerabilities in public issues or pull requests.
Use GitHub's **Security → Advisories → Report a vulnerability** for this repository
when private reporting is available. If it is unavailable, contact the maintainer
through the contact details on their GitHub profile and request a private channel
before sending technical details or credentials.

Maintainers should enable private vulnerability reporting before publishing a
Marketplace release. This document does not assert that it is already enabled.

Include the affected action commit/version, workflow event and permissions,
runner type, reproduction using dummy credentials, and expected/actual behavior.
Never include real tokens, private repository content, or unredacted logs.

## Support and trust boundary

Use the latest reviewed release and pin its full commit SHA. Older releases do
not automatically receive security backports. See README.md for permission,
fork, imported-code, and self-hosted-runner restrictions. The action imports
source code; it does not establish that imported code is safe to execute.
