# Code signing (Windows: Azure Artifact Signing; Linux: OpenPGP)

Both are **off until configured**. With nothing configured, builds are exactly
the unsigned builds this project has always shipped, and the release notes,
`download.json` and the website keep saying "unsigned". Do not change that copy
until a signed build exists and its signature has been measured.

| State | Windows (`npm run dist`, `dist:test`, cutter) | Linux (`linux-apt-repository.mjs`) |
| --- | --- | --- |
| Nothing configured | `signExecutable: false`; nothing is signed, even with a stray `CSC_LINK` | prints `OFF`, writes nothing |
| Partly configured | the build **refuses** and lists what is missing | refuses |
| Fully configured | every `.exe` of ours is signed, read back and required to be Valid, timestamped and signed by the configured publisher | signed repository + `.asc` per `.deb`, verified with `gpgv` |

## Windows: Azure Artifact Signing

How it is wired: `package.json` `build.extends` names
`electron-builder-signing.cjs`, so every electron-builder run passes through
`windows-signing.cjs`. When configured, electron-builder calls
`artifact-signing-sign.cjs` once per file. It runs Microsoft's documented
command (`signtool sign /v /fd SHA256 /tr http://timestamp.acs.microsoft.com
/td SHA256 /dlib Azure.CodeSigning.Dlib.dll /dmdf metadata.json <file>`), then
reads the signature back with `Get-AuthenticodeSignature`. The packed speech
bundle's `python.exe` keeps its vendor bytes and signature, because afterPack
verifies that bundle against sha256 pins.

### Configuration (outside the repository)

| Variable | Value |
| --- | --- |
| `TOOLSENABLED_ARTIFACT_SIGNING_ENDPOINT` | the region endpoint of the account, for example `https://eus.codesigning.azure.net` |
| `TOOLSENABLED_ARTIFACT_SIGNING_ACCOUNT` | the Artifact Signing account name |
| `TOOLSENABLED_ARTIFACT_SIGNING_PROFILE` | the certificate profile name |
| `TOOLSENABLED_ARTIFACT_SIGNING_PUBLISHER` | the exact CN on the certificate. For an individual validation this is the validated legal name (for example `Joshua Pinckard`); later, for the organization, `ToolsEnabled, Inc.` |
| `TOOLSENABLED_ARTIFACT_SIGNING_AUTH` | `azure-cli` (you ran `az login`) or `service-principal` (the `AZURE_*` variables below) |
| `TOOLSENABLED_ARTIFACT_SIGNING_SIGNTOOL` | absolute path to `signtool.exe` (x64) |
| `TOOLSENABLED_ARTIFACT_SIGNING_DLIB` | absolute path to the matching x64 `Azure.CodeSigning.Dlib.dll` |

Instead of the variables, the non-secret values can go in a JSON file named by
`TOOLSENABLED_ARTIFACT_SIGNING_CONFIG`, using the keys `endpoint`,
`codeSigningAccountName`, `certificateProfileName`, `publisherName`, `auth`,
`signtoolPath` and `dlibPath`. Keep it outside the repository, for example
`%LOCALAPPDATA%\ToolsEnabled-Build\artifact-signing.json`. Environment variables
override the file. The file refuses secrets. Authentication is `az login` or
the service-principal environment (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and
`AZURE_CLIENT_CERTIFICATE_PATH`, which is preferred, or `AZURE_CLIENT_SECRET`).

Check readiness on the Windows build machine:

```powershell
node tools/code-signing/artifact-signing-preflight.mjs                 # no signature spent
node tools/code-signing/artifact-signing-preflight.mjs --probe release\win-unpacked\ToolsEnabled.exe   # signs a COPY; spends 1 signature
```

### Owner runbook: individual validation today, on Basic

Sources: the Artifact Signing quickstart, the role tutorial and the signing
integrations page on learn.microsoft.com. Each step is also cited in the
business report.

1. **Azure subscription.** Sign up with billing **Account Type: Individual**.
   The legal name and sold-to address on the billing account must match the
   government ID used for validation. Use a paid (pay-as-you-go) subscription:
   free, trial and sponsored subscriptions are not supported.
2. **Register the provider:** `az provider register --namespace Microsoft.CodeSigning`.
3. **Create the account** on the **Basic** SKU ($9.99/month, 5,000
   signatures, one certificate profile of each type):
   `az extension add --name artifact-signing` and
   `az artifact-signing create -n <account> -l <region> -g <resource-group> --sku Basic`.
   The endpoint is the region's (for example East US is `https://eus.codesigning.azure.net`).
4. **Give yourself "Artifact Signing Identity Verifier"** on the account
   (portal: Access control (IAM) > Add role assignment). You also need at
   least Reader on the subscription.
5. **Identity validation (portal only):** Identity validations > Individual >
   New identity > Public. The form fills from the billing account. When the
   status is Action Required, open the link. Verify with AU10TIX, then add and
   present the Verified ID in Microsoft Authenticator. Microsoft documents that
   the status changes to Completed a few minutes after success.
6. **Create the certificate profile:** type **Public Trust**, and choose the
   completed individual validation as "Verified CN and O". Note the profile
   name.
7. **Signing rights.** Give "Artifact Signing Certificate Profile Signer",
   scoped to the profile, to whoever signs:

   ```sh
   az role assignment create --assignee <object id of you or the CI app> \
     --role "Artifact Signing Certificate Profile Signer" \
     --scope "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CodeSigning/codeSigningAccounts/<account>/certificateProfiles/<profile>"
   ```
8. **CI service principal** (optional; the owner machine can use `az login` instead):

   ```sh
   az ad sp create-for-rbac --name toolsenabled-artifact-signing --create-cert --create-password false
   ```

   This creates an app with no role and a local certificate that includes its
   private key. Assign it the role from step 7, then set `AZURE_TENANT_ID`,
   `AZURE_CLIENT_ID` (the appId) and `AZURE_CLIENT_CERTIFICATE_PATH`, and
   `TOOLSENABLED_ARTIFACT_SIGNING_AUTH=service-principal`. Keep that PEM out
   of every repository.
9. **Tools on the Windows build machine:**
   `winget install -e --id Microsoft.Azure.ArtifactSigningClientTools`
   (SignTool 10.0.2261.755 or newer, .NET 8, VC++ runtime and the dlib). Point
   the two path variables at the x64 `signtool.exe` and the x64 dlib.
10. **Prove it:** run the preflight with `--probe`, then `npm run dist:test`
    (a test-channel installer). Inspect it with
    `Get-AuthenticodeSignature` before any release cut.

### Later: switch to the ToolsEnabled, Inc. organization

1. Create an **Organization** identity validation (Public). This needs the
   legal entity name, a website, a primary email on the company's own domain,
   a business identifier and the business address. Microsoft quotes 1 to 20
   business days, and it may ask for documents issued within the last 12
   months.
2. Basic allows **one** Public Trust profile. Delete the individual profile
   and create the organization one, or move to Premium for the overlap.
   Deleting a profile does not revoke certificates already issued or
   invalidate signatures already made.
3. Change `TOOLSENABLED_ARTIFACT_SIGNING_PROFILE` and
   `TOOLSENABLED_ARTIFACT_SIGNING_PUBLISHER` to `ToolsEnabled, Inc.`, and
   re-assign the signer role on the new profile. Nothing in the repository
   changes. The read-back refuses a build still using the old profile.
4. Expect SmartScreen reputation to start again under the new publisher name.
   Microsoft notes that changing the signing identity affects the
   publisher-trust signal.

## Linux: signed apt repository and detached signatures

`apt` checks repositories, not individual packages. It refuses unsigned
repositories by default, and "apt-secure does not review signatures at a
package level" (apt-secure(8)). `linux-apt-repository.mjs` therefore signs
`InRelease` (clearsigned) and `Release.gpg` (detached). Those bind `Packages`,
which binds each `.deb` by SHA-256. It also writes a `.asc` next to each `.deb`
for direct downloads. The `.deb` is never modified, so its SHA-256 still
matches the release notes.

### Owner: create the key yourself

```sh
tools/code-signing/linux-signing-key-owner.sh --gnupghome /media/<encrypted-usb>/toolsenabled-signing-key --print-plan   # review
tools/code-signing/linux-signing-key-owner.sh --gnupghome /media/<encrypted-usb>/toolsenabled-signing-key
```

This creates a certify-only primary key (5 years) that stays **offline**, and
an ed25519 **signing subkey** (2 years). It also exports the public key, a full
secret backup, a subkey-only export and the revocation certificate. Keep the
primary backup and the revocation certificate offline, in two places. Import
only `signing-subkey-only.asc` on the build machine.

### Sign a release

```sh
TOOLSENABLED_LINUX_SIGNING_KEY=<signing subkey fingerprint> \
node tools/code-signing/linux-apt-repository.mjs --repo <local copy of the published repo> \
  --deb release/cut-<version>/toolsenabled_<version>_amd64.deb
```

Optional: `TOOLSENABLED_LINUX_SIGNING_GNUPGHOME`, and
`TOOLSENABLED_LINUX_SIGNING_PASSPHRASE_FILE` for unattended signing. A pool
file that already exists with different bytes is refused. Publishing the
directory (for example at `https://toolsenabled.ai/apt/`) is a separate,
separately approved step.

### What a customer runs (Ubuntu 24.04), once published

```sh
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://toolsenabled.ai/apt/toolsenabled-archive-keyring.pgp | sudo tee /etc/apt/keyrings/toolsenabled-archive-keyring.pgp >/dev/null
gpg --show-keys /etc/apt/keyrings/toolsenabled-archive-keyring.pgp    # compare with the fingerprint on the website
printf 'Types: deb\nURIs: https://toolsenabled.ai/apt\nSuites: stable\nComponents: main\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/toolsenabled-archive-keyring.pgp\n' \
  | sudo tee /etc/apt/sources.list.d/toolsenabled.sources
sudo apt update && sudo apt install toolsenabled
```

A direct `.deb` download is checked with
`gpgv --keyring ./toolsenabled-archive-keyring.pgp toolsenabled_<v>_amd64.deb.asc toolsenabled_<v>_amd64.deb`.

## What is not proved

- Proved on 2026-09-25 (1.0.46, now published): real signatures from the
  ToolsEnabled, Inc. profile, read back Valid and timestamped on Windows for
  the installer, the installed program, its uninstaller and elevate.exe. The
  release lane built under wine and signed each file on the Windows build
  machine with this module's arguments and read-back. One measured constraint:
  SignTool with the dlib needs per-user DPAPI, which a key-based SSH logon does
  not have ("Access is denied"), so signing must run in a logged-on session.
- SmartScreen reputation for the new publisher is not measured, and cannot be
  forced; the site copy says Windows may still warn.
- The Linux proof uses a throwaway one-day key and a fixture `.deb`. The
  owner's key does not exist yet, and nothing has been published.
