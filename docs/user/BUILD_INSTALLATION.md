# Identify, stage, and verify a Recursion build

From a clean checkout of the intended commit, create a new empty staging directory:

```powershell
npm run prepare:install -- --output artifacts/production-install
```

The command copies only the production inventory and generates `build-info.json`. It records the actual Git revision, whether the checkout has changes, and a deterministic production hash. Text hashes normalize BOM and CRLF; binary hashes use exact bytes. Generated metadata is excluded from its own hash. The command rejects existing nonempty output, symbolic links, the repository root and production directories. Use a new output directory for each build.

Staging does not install or reload Recursion. Before replacing an account's extension files, preserve a backup of its production inventory and build metadata outside the extension directory. Copy the staged production inventory into the intended account extension, removing any superseded production files. Keep account settings, chats, and journals in their existing host locations.

Verify the actual installed files against the staged package, using the account-only check for an account installation:

```powershell
npm run verify:install -- --repo-root artifacts/production-install --installed-root F:/SillyTavern/SillyTavern/data/default-user/extensions/Recursion --account-only
```

The verifier checks exact file bytes, missing/extra production files, unsafe links, and the metadata hash against the installed production tree. A stamp alone cannot pass verification. For a public installation, provide both `--installed-root` and `--public-root` instead of `--account-only`.

Reload SillyTavern after a verified copy. Diagnostics show `build.status: declared` when the extension's own metadata is valid, or `unavailable` when it is absent, malformed, oversized, or cannot load within two seconds. Runtime metadata is a declaration; the installation verifier establishes content agreement. Diagnostics never substitute the current repository revision for an unidentified installed build.

Rollback uses the preserved production backup, followed by verification against that backup and another reload. Neither staging nor verification launches provider requests or changes user settings.
