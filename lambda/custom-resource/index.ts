import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { createWebhook, deleteWebhook } from "../webhook/github-client";

const ssm = new SSMClient({});

interface ResourceProperties {
  WebhookUrl: string;
  GithubTokenParam: string;
  WebhookSecretParam: string;
  TargetTypeParam: string;
  TargetSlugParam: string;
}

interface CloudFormationEvent {
  RequestType: "Create" | "Update" | "Delete";
  PhysicalResourceId?: string;
  ResourceProperties: ResourceProperties;
}

interface CloudFormationResponse {
  PhysicalResourceId: string;
  Data?: Record<string, string>;
}

async function fetchParams(props: ResourceProperties): Promise<{
  githubToken: string;
  webhookSecret: string;
  targetType: string;
  targetSlug: string;
}> {
  const result = await ssm.send(
    new GetParametersCommand({
      Names: [
        props.GithubTokenParam,
        props.WebhookSecretParam,
        props.TargetTypeParam,
        props.TargetSlugParam,
      ],
      WithDecryption: true,
    })
  );
  const byName = Object.fromEntries(
    (result.Parameters ?? []).map((p) => [p.Name!, p.Value!])
  );
  return {
    githubToken: byName[props.GithubTokenParam],
    webhookSecret: byName[props.WebhookSecretParam],
    targetType: byName[props.TargetTypeParam],
    targetSlug: byName[props.TargetSlugParam],
  };
}

export async function handler(
  event: CloudFormationEvent
): Promise<CloudFormationResponse> {
  const props = event.ResourceProperties;

  if (event.RequestType === "Create") {
    console.log("Custom resource Create: registering GitHub webhook");
    const { githubToken, webhookSecret, targetType, targetSlug } =
      await fetchParams(props);

    const result = await createWebhook(
      targetType,
      targetSlug,
      props.WebhookUrl,
      webhookSecret,
      githubToken
    );

    console.log(
      `Registered webhook id=${result.id} for ${targetType} "${targetSlug}"`
    );
    return {
      PhysicalResourceId: String(result.id),
      Data: { WebhookId: String(result.id) },
    };
  }

  if (event.RequestType === "Delete") {
    const hookId = parseInt(event.PhysicalResourceId!, 10);
    console.log(`Custom resource Delete: removing GitHub webhook id=${hookId}`);

    const { githubToken, targetType, targetSlug } = await fetchParams(props);
    await deleteWebhook(targetType, targetSlug, hookId, githubToken);
    console.log(`Deleted webhook id=${hookId}`);

    return { PhysicalResourceId: event.PhysicalResourceId! };
  }

  // Update: no-op — webhook URL is stable across deployments
  console.log("Custom resource Update: no-op");
  return { PhysicalResourceId: event.PhysicalResourceId! };
}
