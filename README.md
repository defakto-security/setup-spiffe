# setup-spiffe

GitHub Action that mints a [SPIFFE](https://spiffe.io) SVID for a workflow job by attesting its
GitHub Actions OIDC token to a [Defakto](https://defakto.security) trust domain.

The Action calls GitHub's OIDC endpoint to mint a fresh, signed JWT for the job, sends it as
attestation evidence to the Defakto agent endpoint for your tenant
(`<trust-domain-id>.agent.spirl.com:443`, where `<trust-domain-id>` is your Defakto-assigned
identifier — e.g. `td-0000000` — not your SPIFFE trust domain name), and writes the resulting
X.509 SVID (and optionally a JWT-SVID) to the runner filesystem for use by later steps.

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
          trust-domain-id: td-0000000       # your Defakto tenant ID
          jwt-svid-audience: my-service     # optional — also fetch a JWT-SVID

      - run: |
          echo "Got SPIFFE ID: ${{ steps.spiffe.outputs.spiffe-id }}"
          openssl x509 -in "$SPIFFE_X509_SVID" -noout -subject -issuer -dates
```

## Inputs

| Input                      | Required | Default                       | Description                                                                                       |
| -------------------------- | -------- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `trust-domain-id`          | yes¹     | —                             | Defakto tenant ID (e.g. `td-0000000`) — not the SPIFFE trust domain. Used to construct the agent endpoint `<trust-domain-id>.agent.spirl.com:443`. |
| `workload-socket-endpoint` | no²      | —                             | SPIFFE Workload API endpoint. When set (and `mode` is `auto`), the Workload API is used and attestation is skipped. |
| `mode`                     | no       | `auto`                        | `auto` \| `serverless` \| `workload-api`. Forces the SVID source. See [Workload API vs. attestation](#workload-api-vs-attestation). |
| `jwt-svid-audience`        | no       | —                             | If set, the Action also fetches a JWT-SVID for this audience. Comma-separated for multiple.       |
| `output-dir`               | no       | `${RUNNER_TEMP}/spiffe`       | Directory to write SVID material into. Created if missing, with `0700` perms.                     |
| `export-env`               | no       | `true`                        | When `true`, exports `SPIFFE_X509_SVID`, `SPIFFE_X509_KEY`, `SPIFFE_X509_BUNDLE` env vars.        |

¹ Can also be supplied via the `DEFAKTO_TRUST_DOMAIN_ID` environment variable. Not required when a Workload API socket is configured.

² Can also be supplied via the `SPIFFE_ENDPOINT_SOCKET` environment variable. Accepts `unix:///path`, `unix://path`, `unix:path`, or a bare path.

## Workload API vs. attestation

The Action picks its SVID source in the following order:

1. **Workload API** — if `workload-socket-endpoint` (or `SPIFFE_ENDPOINT_SOCKET`) is set, the Action talks the standard SPIFFE Workload API gRPC protocol over the given Unix socket. `trust-domain-id` is not used in this mode. The Action still mints a GitHub Actions OIDC token (audience `https://spirl.com`) and sends it to the Workload API as the `identity-exchange-token` gRPC header on every request, so `id-token: write` permission is still required.
2. **Serverless attestation** — otherwise, the Action falls back to `AttestingWorkloadAPIClient`: it mints a GitHub Actions OIDC token, sends it as evidence to `<trust-domain-id>.agent.spirl.com:443`, and receives an SVID in return.

By default (`mode: auto`) the Workload API takes precedence when a socket is
configured. To override that precedence, set `mode` explicitly:

- `mode: auto` (default) — Workload API if a socket is configured, otherwise
  serverless attestation.
- `mode: serverless` — always perform serverless attestation. Any
  `SPIFFE_ENDPOINT_SOCKET` in the environment is ignored. Useful on runners
  where a socket is exported by the environment but a specific job wants the
  attestation flow. Setting `workload-socket-endpoint` as an action input
  alongside `mode: serverless` is rejected as contradictory.
- `mode: workload-api` — require a Workload API socket; fail fast if none is
  configured.

## Outputs

| Output             | Description                                                                           |
| ------------------ | ------------------------------------------------------------------------------------- |
| `spiffe-id`        | The SPIFFE ID URI granted, e.g. `spiffe://example.org/github/owner/repo`.             |
| `x509-svid-path`   | Path to the PEM-encoded X.509 SVID certificate chain (leaf first).                    |
| `x509-key-path`    | Path to the PEM-encoded PKCS#8 private key for the SVID.                              |
| `x509-bundle-path` | Path to the PEM-encoded trust bundle for the SVID's trust domain.                     |
| `expires-at`       | ISO-8601 timestamp at which the X.509 SVID expires.                                   |
| `jwt-svid`         | Raw JWT-SVID (only when `jwt-svid-audience` was set). Masked in logs via `setSecret`. |
| `jwt-svid-path`    | Path to the file containing the JWT-SVID (only when `jwt-svid-audience` was set).     |

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
