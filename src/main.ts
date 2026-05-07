import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  AttestingWorkloadAPIClient,
  marshalX509SVID,
  type AttestationEvidence,
  type Attestor,
} from "@defakto/spiffe";

/**
 * Inline GitHub Actions OIDC attestor.
 *
 * Equivalent to `@defakto/spiffe`'s `GithubAttestor`, kept local so this
 * Action builds against the currently-published `@defakto/spiffe` (0.3.x).
 * Once the SDK ships `GithubAttestor`, this class can be replaced with the
 * upstream import.
 */
class GithubAttestor implements Attestor {
  readonly pluginName = "github";
  readonly pluginVersion = "1.0";
  readonly #audience: string;
  constructor(audience: string) {
    this.#audience = audience;
  }
  async collectEvidence(): Promise<AttestationEvidence> {
    const token = await core.getIDToken(this.#audience);
    if (!token) throw new Error("GitHub Actions OIDC fetcher returned an empty token");
    const payload = JSON.stringify({ token });
    return {
      pluginName: this.pluginName,
      pluginVersion: this.pluginVersion,
      payload: new TextEncoder().encode(payload),
    };
  }
}

async function run(): Promise<void> {
  const audience = core.getInput("audience") || "defakto-github";
  const trustDomainId =
    core.getInput("trust-domain-id") || process.env["DEFAKTO_TRUST_DOMAIN_ID"] || "";
  const jwtAudienceRaw = core.getInput("jwt-audience");
  const outputDir =
    core.getInput("output-dir") ||
    path.join(process.env["RUNNER_TEMP"] || process.cwd(), "spiffe");
  const exportEnv = (core.getInput("export-env") || "true").toLowerCase() !== "false";

  if (!trustDomainId) {
    throw new Error(
      "`trust-domain-id` input (or DEFAKTO_TRUST_DOMAIN_ID env var) is required",
    );
  }

  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });

  const attestor = new GithubAttestor(audience);
  const client = new AttestingWorkloadAPIClient({
    trustDomainId,
    attestors: [attestor],
  });

  try {
    core.info(`Attesting GitHub OIDC token (audience="${audience}") to ${trustDomainId}...`);
    const svid = await client.x509.getSVID();

    core.info(`Received X.509 SVID for ${svid.id.toString()}`);
    core.setOutput("spiffe-id", svid.id.toString());
    core.setOutput("expires-at", svid.expiresAt.toISOString());

    const { certChainPem, privateKeyPem } = await marshalX509SVID(svid);
    const bundle = await client.x509.getBundleForTrustDomain(svid.id.trustDomain);
    const bundlePem = bundle.x509Authorities.map((c) => c.toString()).join("");

    const certPath = path.join(outputDir, "svid.pem");
    const keyPath = path.join(outputDir, "svid.key");
    const bundlePath = path.join(outputDir, "bundle.pem");

    await Promise.all([
      fs.writeFile(certPath, certChainPem, { mode: 0o600 }),
      fs.writeFile(keyPath, privateKeyPem, { mode: 0o600 }),
      fs.writeFile(bundlePath, bundlePem, { mode: 0o600 }),
    ]);

    core.setOutput("svid-cert-path", certPath);
    core.setOutput("svid-key-path", keyPath);
    core.setOutput("bundle-path", bundlePath);

    if (exportEnv) {
      core.exportVariable("SPIFFE_X509_SVID", certPath);
      core.exportVariable("SPIFFE_X509_KEY", keyPath);
      core.exportVariable("SPIFFE_X509_BUNDLE", bundlePath);
    }

    if (jwtAudienceRaw) {
      const audiences = jwtAudienceRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      core.info(`Fetching JWT-SVID for audience(s): ${audiences.join(", ")}`);
      const jwt = await client.jwt.fetchSVID(audiences);

      core.setSecret(jwt.token);
      const jwtPath = path.join(outputDir, "svid.jwt");
      await fs.writeFile(jwtPath, jwt.token, { mode: 0o600 });

      core.setOutput("jwt", jwt.token);
      core.setOutput("jwt-path", jwtPath);
      if (exportEnv) {
        core.exportVariable("SPIFFE_JWT_SVID", jwtPath);
      }
    }

    core.info(`Wrote SVID material to ${outputDir}`);
  } finally {
    await client.close();
  }
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(message);
});
