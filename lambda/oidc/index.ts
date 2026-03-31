import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { setVariable, deleteVariable } from "../webhook/github-client";

const ssm = new SSMClient({});

interface ResourceProperties {
  RoleArn: string;
  GithubTokenParam: string;
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
}

const VARIABLE_NAME = "AWS_ROLE_ARN";

async function fetchParams(props: ResourceProperties): Promise<{
  githubToken: string;
  targetType: string;
  targetSlug: string;
}> {
  const result = await ssm.send(
    new GetParametersCommand({
      Names: [
        props.GithubTokenParam,
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
    targetType: byName[props.TargetTypeParam],
    targetSlug: byName[props.TargetSlugParam],
  };
}

export async function handler(
  event: CloudFormationEvent
): Promise<CloudFormationResponse> {
  const props = event.ResourceProperties;
  const physicalId = event.PhysicalResourceId ?? `${props.TargetSlugParam}/${VARIABLE_NAME}`;

  if (event.RequestType === "Delete") {
    console.log(`Deleting GitHub Actions variable ${VARIABLE_NAME}`);
    const { githubToken, targetType, targetSlug } = await fetchParams(props);
    await deleteVariable(targetType, targetSlug, VARIABLE_NAME, githubToken);
    console.log(`Deleted ${VARIABLE_NAME}`);
    return { PhysicalResourceId: physicalId };
  }

  // Create or Update: set the variable to the current role ARN
  console.log(`Setting GitHub Actions variable ${VARIABLE_NAME} = ${props.RoleArn}`);
  const { githubToken, targetType, targetSlug } = await fetchParams(props);
  await setVariable(targetType, targetSlug, VARIABLE_NAME, props.RoleArn, githubToken);
  console.log(`Set ${VARIABLE_NAME} for ${targetType} "${targetSlug}"`);

  return { PhysicalResourceId: physicalId };
}
