#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { LaSiteStack } from "../lib/la-site-stack";

const app = new cdk.App();
new LaSiteStack(app, "LaSiteStack", {
  // CloudFront certificates and the shared GitHub OIDC role both live in us-east-1.
  env: { region: "us-east-1" },
});
