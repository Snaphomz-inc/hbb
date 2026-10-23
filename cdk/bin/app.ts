#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import * as fs from "node:fs";
import * as path from "node:path";
import { SiteStack } from "../lib/site-stack";

/**
 * One stack per city: `cdk deploy -c city=la` reads cities/la/city.json for the domain and
 * deploys SiteStack-la. The city defaults to the CITY environment variable, then "la".
 */
const app = new cdk.App();
const city: string = app.node.tryGetContext("city") ?? process.env.CITY ?? "la";
const file = path.resolve(__dirname, "..", "..", "cities", city, "city.json");
if (!fs.existsSync(file)) throw new Error(`no city config at ${file}`);
const config = JSON.parse(fs.readFileSync(file, "utf-8")) as { slug: string; domain: string };

new SiteStack(app, `SiteStack-${config.slug}`, {
  city: config.slug,
  domain: config.domain,
  // CloudFront certificates and the shared GitHub OIDC role both live in us-east-1.
  env: { region: "us-east-1" },
});
