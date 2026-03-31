const GITHUB_API_BASE = "https://api.github.com";

export interface JitConfigResult {
  encodedJitConfig: string;
  runnerId: number;
}

export interface WebhookCreateResult {
  id: number;
  url: string;
}

/**
 * Generates a JIT (Just-In-Time) runner config for an ephemeral self-hosted runner.
 * The returned encodedJitConfig is passed directly to the runner via --jitconfig.
 */
export async function generateJitConfig(
  jobId: number,
  targetType: string,
  targetSlug: string,
  token: string
): Promise<JitConfigResult> {
  let endpoint: string;
  if (targetType === "org") {
    endpoint = `${GITHUB_API_BASE}/orgs/${encodeURIComponent(targetSlug)}/actions/runners/generate-jitconfig`;
  } else {
    const [owner, repo] = targetSlug.split("/");
    endpoint = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runners/generate-jitconfig`;
  }

  const body = {
    name: `aws-runner-${jobId}`,
    runner_group_id: 1,
    labels: ["self-hosted", "linux", "x64"],
    work_folder: "_work",
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitHub JIT config request failed: ${response.status} ${response.statusText} — ${text}`
    );
  }

  const data = (await response.json()) as {
    runner: { id: number };
    encoded_jit_config: string;
  };

  return {
    encodedJitConfig: data.encoded_jit_config,
    runnerId: data.runner.id,
  };
}

/**
 * Registers a webhook on a GitHub repo or org.
 * Returns the created webhook's ID (used as the custom resource PhysicalResourceId).
 */
export async function createWebhook(
  targetType: string,
  targetSlug: string,
  webhookUrl: string,
  webhookSecret: string,
  token: string
): Promise<WebhookCreateResult> {
  const endpoint = webhookEndpoint(targetType, targetSlug);

  const body = {
    name: "web",
    active: true,
    events: ["workflow_job"],
    config: {
      url: webhookUrl,
      content_type: "json",
      secret: webhookSecret,
      insecure_ssl: "0",
    },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitHub webhook create failed: ${response.status} ${response.statusText} — ${text}`
    );
  }

  const data = (await response.json()) as { id: number; url: string };
  return { id: data.id, url: data.url };
}

/**
 * Deletes a webhook by ID from a GitHub repo or org.
 * Returns silently if the webhook is already gone (404).
 */
export async function deleteWebhook(
  targetType: string,
  targetSlug: string,
  hookId: number,
  token: string
): Promise<void> {
  const base = webhookEndpoint(targetType, targetSlug);
  const endpoint = `${base}/${hookId}`;

  const response = await fetch(endpoint, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (response.status === 404) {
    return; // Already gone — idempotent delete
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitHub webhook delete failed: ${response.status} ${response.statusText} — ${text}`
    );
  }
}

function webhookEndpoint(targetType: string, targetSlug: string): string {
  if (targetType === "org") {
    return `${GITHUB_API_BASE}/orgs/${encodeURIComponent(targetSlug)}/hooks`;
  }
  const [owner, repo] = targetSlug.split("/");
  return `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`;
}
