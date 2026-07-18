# OpenRappter Bar signing and notarization

Public DMGs are signed with **Developer ID Application**, submitted to Apple's
notary service, stapled, mounted, and assessed by Gatekeeper before release.

## Repository secrets

The release and health workflows require:

- `MACOS_CERTIFICATE_P12_BASE64`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_API_KEY_P8_BASE64`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER_ID`

Never commit `.p12`, `.p8`, or private-key material. Keep an encrypted,
access-controlled recovery copy outside the repository and GitHub.

## Routine rotation

1. Create the replacement credential before revoking the old one.
2. For signing, create a **Developer ID Application** certificate using the G2
   intermediary and export its identity as a password-protected PKCS#12.
3. For notarization, create an App Store Connect API key with the minimum role
   required by Apple's notary service.
4. Replace all five repository secrets in one maintenance window.
5. Manually run **macOS Signing Health**.
6. Publish a canary `vX.Y.Z-bar` release and verify:
   - `codesign --verify --deep --strict`
   - `xcrun stapler validate`
   - `spctl --assess` reports `Notarized Developer ID`
7. Revoke the old credential only after the canary succeeds.

The weekly health workflow opens an Issue when the certificate has fewer than
90 days remaining or the notarization API key no longer authenticates.

## Suspected compromise

1. Revoke the affected certificate or API key in Apple Developer/App Store
   Connect immediately.
2. Disable Bar releases until replacement secrets validate.
3. Audit recent release workflow runs and published asset digests.
4. Replace the credential, run the health workflow, and publish a new release.
5. Document affected versions and advise users to update if artifact integrity
   is uncertain.

Use `™`, not `®`, for **RAPP + X™** until trademark registration is granted;
Apple signing/notarization and RAR receipts are separate trust systems.
