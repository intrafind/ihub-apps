# Features — Unreleased

## Signed Build Provenance and SBOMs for Releases

Releases can now be checked before they are installed. Release binaries, the Nextcloud plugin and
the container image on GHCR carry signed build provenance, which proves they were built by the
iHub Apps release workflow from the tagged source. Each release also lists CycloneDX SBOMs of the
dependencies it ships, for vulnerability and license tracking.

- Check a download: `gh attestation verify <file> --repo intrafind/ihub-apps`.
- Check the image:
  `gh attestation verify oci://ghcr.io/intrafind/ihub-apps:<version> --repo intrafind/ihub-apps`.
- The image carries its own SBOM, shown by `docker buildx imagetools inspect`.
- Details: *Security → Automated Security Checks → Verifying a Release* in the documentation.
