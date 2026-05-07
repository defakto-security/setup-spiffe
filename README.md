# setup-spiffe

GitHub Action that mints a [SPIFFE](https://spiffe.io) SVID for a workflow job by attesting its
GitHub Actions OIDC token to a [Defakto](https://defakto.security) trust domain.

The Action calls GitHub's OIDC endpoint to mint a fresh, signed JWT for the job, sends it as
attestation evidence to `<trust-domain-id>.agent.spirl.com:443`, and writes the resulting X.509
SVID (and optionally a JWT-SVID) to the runner filesystem for use by later steps.

## Why

The SPIFFE community ships [`spiffe/spire`](https://github.com/spiffe/spire) and assumes a long-lived
agent. CI jobs are ephemeral: there is no agent. Instead, the Action uses
[`@defakto/spiffe`](https://www.npmjs.com/package/@defakto/spiffe)'s
`AttestingWorkloadAPIClient`, which performs the full attestation handshake on every call —
collect evidence, exchange for an SVID, done. The GitHub OIDC token is the evidence.

## Usage

```yaml
permissions:
  id-token: write   # required — the Action mints a GitHub OIDC token
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: defakto-security/setup-spiffe@v0
        id: spiffe
        with:
          trust-domain-id: example.org
          audience: defakto-github      # default; must match the policy registered with Defakto
          jwt-audience: my-service      # optional — also fetch a JWT-SVID

      - run: |
          echo "Got SPIFFE ID: ${{ steps.spiffe.outputs.spiffe-id }}"
          openssl x509 -in "$SPIFFE_X509_SVID" -noout -text
          curl --cert "$SPIFFE_X509_SVID" --key "$SPIFFE_X509_KEY" --cacert "$SPIFFE_X509_BUNDLE" \
               https://api.example.org/whoami
```

## Inputs

| Input             | Required | Default                       | Description                                                                                       |
| ----------------- | -------- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `trust-domain-id` | yes¹     | —                             | Defakto trust domain. Used to construct the endpoint `<trust-domain-id>.agent.spirl.com:443`.     |
| `audience`        | no       | `defakto-github`              | OIDC audience claim requested when minting the GitHub Actions JWT used as attestation evidence.   |
| `jwt-audience`    | no       | —                             | If set, the Action also fetches a JWT-SVID for this audience. Comma-separated for multiple.       |
| `output-dir`      | no       | `${RUNNER_TEMP}/spiffe`       | Directory to write SVID material into. Created if missing, with `0700` perms.                     |
| `export-env`      | no       | `true`                        | When `true`, exports `SPIFFE_X509_SVID`, `SPIFFE_X509_KEY`, `SPIFFE_X509_BUNDLE` env vars.        |

¹ Can also be supplied via the `DEFAKTO_TRUST_DOMAIN_ID` environment variable.

## Outputs

| Output             | Description                                                                       |
| ------------------ | --------------------------------------------------------------------------------- |
| `spiffe-id`        | The SPIFFE ID URI granted, e.g. `spiffe://example.org/github/owner/repo`.         |
| `svid-cert-path`   | Path to the PEM-encoded X.509 SVID certificate chain (leaf first).                |
| `svid-key-path`    | Path to the PEM-encoded PKCS#8 private key for the SVID.                          |
| `bundle-path`      | Path to the PEM-encoded trust bundle for the SVID's trust domain.                 |
| `expires-at`       | ISO-8601 timestamp at which the X.509 SVID expires.                               |
| `jwt`              | Raw JWT-SVID (only when `jwt-audience` was set). Masked in logs via `setSecret`.  |
| `jwt-path`         | Path to the file containing the JWT-SVID (only when `jwt-audience` was set).      |

## Environment variables exported (when `export-env: true`)

| Variable             | Points at                          |
| -------------------- | ---------------------------------- |
| `SPIFFE_X509_SVID`   | The X.509 cert chain PEM file.     |
| `SPIFFE_X509_KEY`    | The PKCS#8 private key PEM file.   |
| `SPIFFE_X509_BUNDLE` | The trust bundle PEM file.         |
| `SPIFFE_JWT_SVID`    | The JWT-SVID file (when fetched).  |

## Security notes

- The Action requires `id-token: write` permission. Without it, GitHub will not mint an OIDC token
  for the job and attestation will fail.
- SVID material is written with `0600` perms into a directory created with `0700` perms.
- The JWT-SVID is registered with `core.setSecret` so it will be masked in subsequent log output.
- The GitHub OIDC token used as evidence is short-lived and is never written to disk by this
  Action. It is fetched fresh from the GitHub Actions runtime on each invocation.

## Future work

The SVID lifecycle is presently "fetch once at job start, write to disk, exit." Roadmap:

- Serve a local Workload API socket so that workloads can pull rotated SVIDs without re-running the Action.
- Use the SVID directly to mint cloud access tokens (`/aws`, `/gcp`, `/azure` integrations
  already exist in `@defakto/spiffe`).

## Development

```sh
npm install
npm run typecheck
npm run build       # bundles src/main.ts → dist/index.js with @vercel/ncc
```

`dist/` is committed because GitHub Actions loads `dist/index.js` directly at runtime
(see `runs.main` in `action.yml`). Re-run `npm run build` and commit `dist/` after any change to `src/`.
