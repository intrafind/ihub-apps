# Features — Unreleased

## Container Image: Signed SBOM and Vulnerability Report

The container image on `ghcr.io/intrafind/ihub-apps` now carries Trivy's SBOM and Trivy's
vulnerability report as signed attestations, so you can check what an image contains and what was
known about it at release time without scanning it yourself.

- The CycloneDX SBOM can be imported into tools such as Dependency-Track.
- The vulnerability report lists Trivy's findings of every severity on the day the image was
  built, including waived findings marked as suppressed. CVEs published later are not in it.
- Both are verified and downloaded with `gh attestation verify --predicate-type …`; the commands
  are in the security documentation under "Verifying a Release".
- The image keeps its existing BuildKit SBOM and build provenance.
