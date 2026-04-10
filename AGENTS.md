# Repository Guidelines

## Project Structure & Module Organization
This repository is a TypeScript AWS CDK app for provisioning ephemeral GitHub Actions runners on EC2.

- `bin/github-aws-runner.ts`: CDK entrypoint.
- `lib/github-aws-runner-stack.ts`: main infrastructure definition.
- `lambda/*/index.ts`: Lambda handlers for webhook processing, IP updates, watchdog cleanup, OIDC setup, cache bucket management, and custom resources.
- `lambda/webhook/github-client.ts`: GitHub API helper logic.
- `test/*.test.ts`: Jest assertions against the synthesized CloudFormation template.
- `config.sh`: helper script for parameter setup and deployment workflows.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run build`: compile TypeScript to `dist/`.
- `npm run watch`: rebuild on file changes during local development.
- `npm test`: run Jest tests in `test/`.
- `npm run cdk -- synth`: synthesize the CloudFormation template.
- `npm run cdk -- deploy`: deploy the stack to AWS.

Use `npm run cdk -- diff` before deployment when changing infrastructure.

## Coding Style & Naming Conventions
Use TypeScript with `strict` compiler settings enabled in [`tsconfig.json`](/home/jasonshobe/work/github-aws-runner/tsconfig.json). Follow the existing style:

- 2-space indentation and semicolons.
- Double quotes for strings.
- `PascalCase` for classes, interfaces, and CDK constructs.
- `camelCase` for variables and functions.
- Keep Lambda handlers small and place service-specific helpers beside them.

No dedicated formatter or linter is configured, so match the surrounding file exactly.

## Testing Guidelines
Tests use Jest with `ts-jest`; file names follow `*.test.ts`. Prefer assertion-style infrastructure tests with `aws-cdk-lib/assertions`, similar to [`test/github-aws-runner.test.ts`](/home/jasonshobe/work/github-aws-runner/test/github-aws-runner.test.ts). Add or update tests for any stack, IAM, scheduling, or environment-variable change. Run `npm test` before opening a PR.

## Commit & Pull Request Guidelines
Recent commits use short, imperative summaries such as `Add optional GitHub OIDC authentication support` and `Reorganize README for clarity and consistency`. Keep commit subjects concise, capitalized, and focused on one change.

PRs should explain the operational impact, list test coverage, and link related issues when applicable. Include `cdk diff` output or equivalent notes for infrastructure changes, plus sample config or workflow snippets when behavior changes are user-facing.
