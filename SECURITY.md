# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting feature for this repository when available,
or contact the repository maintainer privately.

Include the affected version, reproduction steps, and potential impact. Avoid
including real organizational API specifications or credentials.

## Security model

SpecLift is a static frontend application. Conversion happens in browser
memory, without a backend or remote conversion API. Changes that introduce
network access, telemetry, persistence, or third-party scripts must be clearly
disclosed and justified during review.
