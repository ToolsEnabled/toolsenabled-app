# Cloud Mirror

Cloud Mirror publishes a classified snapshot of a local Git checkout to a
dedicated private GitHub repository so a Cloud environment can work against the
same source revision as the computer running ToolsEnabled.

## User flow

1. Open **Settings -> Cloud mirror**.
2. Name the local project and choose its local Git checkout.
3. Confirm the repository-relative Cloud Mirror boundary manifest. The default
   is `config/cloud-mirror-boundary.json`.
4. Paste the dedicated private GitHub repository URL.
5. Choose the Cloud environment that is bound to that same repository.
6. Register the mirror.

One private repository may hold several ToolsEnabled projects. Each project is
isolated on a derived branch named `cloud-mirror/<projectKey>`.

## Boundary manifest

The boundary manifest is the customer's publication decision. ToolsEnabled
does not generate it, copy one from another project, or guess which tracked
files may leave the computer. The path entered in Settings must be a
non-traversing relative path inside the selected checkout.

The JSON document uses schema version 1 and has two explicit rule classes:
`mirror` for tracked paths that may enter the private mirror, and `withhold` for
tracked paths that must not. Each class has `paths` and `prefixes` arrays;
prefixes end in `/`. Withhold wins, but every tracked path must still match a
rule or publication refuses as `CLOUD_MIRROR_UNCLASSIFIED`. A minimal shape to
edit for the selected repository is:

```json
{
  "schemaVersion": 1,
  "mirror": {
    "paths": ["replace/with/a-reviewed-file"],
    "prefixes": []
  },
  "withhold": {
    "paths": [],
    "prefixes": ["replace/with/a-reviewed-private-directory/"]
  },
  "credentialScanAcknowledged": {}
}
```

Replace the illustrative entries; they are not defaults. A credential-shaped
value in a selected blob still refuses publication. `credentialScanAcknowledged`
is only for reviewed synthetic fixtures and each real entry requires a stated
reason; it is not a general bypass.

## Safety contract

Registration succeeds only when all of these facts are established:

- the typed remote is an HTTPS `github.com` URL that canonicalizes to a GitHub
  `owner/name` without embedded credentials; SSH transports are refused;
- the authenticated GitHub API can read that exact repository and reports it
  as private, active, and not archived;
- the selected Cloud environment reports the identical `owner/name`;
- the local folder is a Git checkout with a complete Cloud Mirror boundary;
- the current Windows account can read and dry-run-push to the remote; and
- no other project occupies the derived repository/branch pair.

The GitHub privacy check is repeated immediately before every publication.
Cached Cloud-environment visibility is never treated as proof, and there is no
public-repository override in the product path. Registry entries created before
this proof was recorded remain disabled until the user registers them again.

Cloud Mirror does not pull, merge, reset, switch, or edit the source checkout.
It builds a filtered tree with a temporary Git index, scans selected blobs for
credential-shaped values, creates an unattached publication commit, and pushes
that exact commit ID to the derived workspace branch.

## If a mirror was pointed at the wrong repository

Use **Disable locally** on that registered mirror first. This removes the local
privacy proof and publication receipts, so ToolsEnabled will not publish or
dispatch through the binding again. It does not contact GitHub and does not
delete or change the repository or its `cloud-mirror/<projectKey>` branch.

The disabled row can then be re-registered against the same private destination
or repointed to a different private repository and matching Cloud environment;
the full destination verification runs again before it is enabled. Remote
cleanup remains an explicit GitHub operation: make a mistaken destination
private before reviewing its contents, then remove only that project's exact
`cloud-mirror/<projectKey>` ref. Changing or deleting a ref cannot retract
copies that were already cloned or cached, so any credential that may have been
present must still be rotated. The whole-app local-data reset also forgets the
local registration, but it never removes a GitHub repository or branch.
