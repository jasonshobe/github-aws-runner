import {
  S3Client,
  CreateBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  type CreateBucketCommandInput,
  type BucketLocationConstraint,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({});

interface ResourceProperties {
  BucketName: string;
  ExpirationDays: string;
}

interface CloudFormationEvent {
  RequestType: "Create" | "Update" | "Delete";
  PhysicalResourceId?: string;
  ResourceProperties: ResourceProperties;
}

interface CloudFormationResponse {
  PhysicalResourceId: string;
}

async function applyLifecyclePolicy(
  bucketName: string,
  expirationDays: number
): Promise<void> {
  await s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucketName,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: "github-aws-runner-cache-expiry",
            Status: "Enabled",
            Filter: { Prefix: "" },
            Expiration: { Days: expirationDays },
          },
        ],
      },
    })
  );
}

export async function handler(
  event: CloudFormationEvent
): Promise<CloudFormationResponse> {
  const { BucketName, ExpirationDays } = event.ResourceProperties;
  const expirationDays = parseInt(ExpirationDays, 10);

  if (event.RequestType === "Delete") {
    // Retain the bucket — objects and lifecycle policy remain intact
    console.log(`Cache bucket retained on stack deletion: ${BucketName}`);
    return { PhysicalResourceId: BucketName };
  }

  if (event.RequestType === "Create") {
    const region = process.env.AWS_REGION!;
    const params: CreateBucketCommandInput = { Bucket: BucketName };
    // us-east-1 does not accept a LocationConstraint
    if (region !== "us-east-1") {
      params.CreateBucketConfiguration = {
        LocationConstraint: region as BucketLocationConstraint,
      };
    }

    try {
      await s3.send(new CreateBucketCommand(params));
      console.log(`Created cache bucket: ${BucketName}`);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        err.name === "BucketAlreadyOwnedByYou"
      ) {
        console.log(`Cache bucket already exists in this account: ${BucketName}`);
      } else {
        throw err;
      }
    }
  }

  await applyLifecyclePolicy(BucketName, expirationDays);
  console.log(
    `Applied lifecycle policy: objects expire after ${expirationDays} days`
  );

  return { PhysicalResourceId: BucketName };
}
