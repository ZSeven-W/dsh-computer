# DSH Computer Helper Release Pipeline

This repository contains the complete release pipeline for the native DSH
Computer Helper. The only intentionally missing ingredient is the owner's
Developer ID Application certificate and App Store Connect notary credentials.
Nothing in this pipeline fakes a signature, stubs notarization, or claims a
release artifact is stable when it is not.

## Status

- The native helper is currently used as an ad-hoc development build, and the
  driver reports `identityStable: false` for that build.
- The release pipeline builds, assembles, signs, notarizes, staples, verifies,
  packages into a DMG, writes SHA256 checksums, and renders a Homebrew cask.
- Without the owner's signing identity, the pipeline prints every step as a
  dry run and exits nonzero at the codesigning step with:
  `missing signing identity: set DSH_COMPUTER_SIGNING_IDENTITY ...`
- Notarization itself is **not verified** in this repository: it requires the
  owner's Developer ID certificate and App Store Connect API key.

## One-time owner setup

### 1. Developer ID Application certificate

Install the certificate in the login keychain and confirm it is visible:

```sh
security find-identity -v -p codesigning
```

The output contains entries such as:

```text
1) ABCDEF1234567890ABCDEF1234567890ABCDEF12 "Developer ID Application: Your Name (TEAM123456)"
```

Copy the exact common name (or SHA-1) into the release config.

### 2. Team ID

Find the Team ID in Apple Developer > Membership. It is usually 10 characters,
e.g. `TEAM123456`.

### 3. App Store Connect API key for notarytool

1. Go to <https://appstoreconnect.apple.com/access/api>.
2. Create a Team Key with Developer ID capability.
3. Download the `.p8` file once and store it outside this repository (or in a
   git-ignored local path).
4. Record the Key ID and Issuer ID.

### 4. Configure credentials

Copy the checked-in example and fill it in:

```sh
cp scripts/release/release-config.example.env scripts/release/release-config.env
chmod 600 scripts/release/release-config.env
```

The file is git-ignored. The following variables are supported:

```text
DSH_COMPUTER_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAM123456)"
DSH_COMPUTER_TEAM_ID="TEAM123456"
DSH_COMPUTER_NOTARY_KEY_ID="ABCDEF1234"
DSH_COMPUTER_NOTARY_ISSUER_ID="00000000-0000-0000-0000-000000000000"
DSH_COMPUTER_NOTARY_KEY_PATH="/absolute/path/to/AuthKey_ABCDEF1234.p8"
```

Real environment variables with the same names take precedence over the config
file. Never commit `scripts/release/release-config.env`.

## Commands

### Dry run (no certificate required)

```sh
pnpm run release:dry-run
```

This builds the native helper, assembles the app bundle, prints every step that
would run (codesign, notarytool, stapler, verification, DMG, checksums, cask),
and then exits nonzero with the missing-identity message. It does **not**
ad-hoc sign the release artifact or claim success.

Expected final lines look like:

```text
[release] Codesigning with Developer ID + Hardened Runtime + entitlements
[release] Missing Developer ID signing identity.
[dry-run] WOULD codesign --force --options runtime --timestamp --sign $DSH_COMPUTER_SIGNING_IDENTITY --entitlements .../DSHComputerHelper.entitlements .../DSH Computer Helper.app
[dry-run] WOULD ditto -c -k --keepParent .../DSH Computer Helper.app .../DSH Computer Helper-0.1.0-rc.1-notarization.zip
[dry-run] WOULD xcrun notarytool submit <zip> --key-id $DSH_COMPUTER_NOTARY_KEY_ID --issuer $DSH_COMPUTER_NOTARY_ISSUER_ID --key $DSH_COMPUTER_NOTARY_KEY_PATH --wait
[dry-run] WOULD xcrun stapler staple .../DSH Computer Helper.app
[dry-run] WOULD codesign --verify --deep --strict --verbose=2 .../DSH Computer Helper.app
[dry-run] WOULD /usr/sbin/spctl --assess --type execute --verbose=4 .../DSH Computer Helper.app
[dry-run] WOULD xcrun stapler validate .../DSH Computer Helper.app
[dry-run] WOULD hdiutil create -volname "DSH Computer Helper" -srcfolder .../DSH Computer Helper.app -ov -format UDZO .../DSH Computer Helper-0.1.0-rc.1.dmg
[dry-run] WOULD write SHA256SUMS for ...
[dry-run] WOULD generate .../dsh-computer.rb from .../dsh-computer.rb.template ...

error: missing signing identity: set DSH_COMPUTER_SIGNING_IDENTITY ...
```

### Real run (after owner supplies credentials)

```sh
pnpm run release
```

This runs the same pipeline for real. It will:

1. `swift build -c release` the helper.
2. Assemble `DSH Computer Helper.app`.
3. Codesign with Developer ID, Hardened Runtime, timestamp, and the checked-in
   entitlements file.
4. Create a notarization zip.
5. `xcrun notarytool submit ... --wait`.
6. `xcrun stapler staple` the app.
7. Verify with `codesign --verify --deep --strict`, `spctl --assess`, and
   `stapler validate`.
8. Build `DSH Computer Helper-<version>.dmg` with `hdiutil`.
9. Write `SHA256SUMS`.
10. Generate `dsh-computer.rb` from the template with the real DMG SHA256.

Artifacts are written to `dist/release/`.

### Verify an artifact

```sh
pnpm run release:verify -- path/to/DSH\ Computer\ Helper.app
pnpm run release:verify -- path/to/DSH\ Computer\ Helper.app --json
```

The script reports the truth: identity, signature kind, team identifier,
authorities, CDHash, Hardened Runtime, entitlements, spctl assessment, and
notarization ticket presence/absence. It does not fabricate `releaseReady`.

### Checksums only

```sh
pnpm run release:checksum -- file1 file2
```

## Entitlements audit

`scripts/release/DSHComputerHelper.entitlements` is the release entitlements
file. It intentionally contains no AX or screen-recording entitlement because
both are TCC permissions, not entitlement keys:

- **Accessibility (`AXUIElement*`)**: macOS grants Accessibility to the exact
  code-signed bundle identity via System Settings > Privacy & Security >
  Accessibility. No entitlement key is needed.
- **Screen Recording (`CGWindowListCreateImage`)**: macOS grants Screen
  Recording to the exact code-signed bundle identity via System Settings >
  Privacy & Security > Screen Recording. No entitlement key is needed.

The file makes two hardening choices explicit:

- `com.apple.security.get-task-allow = false`: release builds must not allow a
  debugger to attach through `task_for_pid`.
- `com.apple.security.cs.allow-jit = false`: the helper is a native executable
  and does not use a JIT; keeping this false preserves Hardened Runtime.

Hardened Runtime itself is enabled by `codesign --options runtime --timestamp`.

## Helper identity plumbing

`identityStable` is not a build flag:

- Swift `makeStatus()` computes it from the actual code signature: the app
  bundle identifier must equal
  `io.github.zseven-w.dsh-computer.helper`, the signature must be signed,
  non-ad-hoc, have a `TeamIdentifier`, and the code identifier must match the
  fixed bundle id.
- The Node resolver (`src/native-helper.ts`) additionally validates the fixed
  installed-app path with `codesign --verify --deep --strict`, parses the real
  signature, and only then returns `identityStable: true` for the
  `installed-app` resolution source. Development worktree/cache builds remain
  `identityStable: false`.

Therefore, when a properly Developer ID-signed helper is installed at the fixed
path, the driver's `computer_evidence` status reports `identityStable: true`
based on the real signature evaluation.

## Homebrew template

`scripts/release/dsh-computer.rb.template` is checked in as a template with
placeholder `__VERSION__`, `__DMG_FILENAME__`, and `__SHA256__`. The pipeline
renders a concrete `dsh-computer.rb` into the output directory after computing
the DMG checksum. Do not commit a concrete URL/checksum as if it were already
published.

## Notarization caveat

This repository cannot verify notarization because that requires the owner's
Developer ID certificate and an App Store Connect API key. The dry-run output
explicitly prints the notarytool command and does not attempt to call Apple.
After the owner supplies credentials, run `pnpm run release` and confirm the
final output includes successful `stapler validate` and `releaseReady: true`.
