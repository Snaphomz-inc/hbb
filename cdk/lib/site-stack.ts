import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";

/** The one hosted zone every city site lives under. */
const ZONE = { hostedZoneId: "Z03826773GQ15YX1JR593", zoneName: "snaphomz.com" };

export type SiteProps = cdk.StackProps & {
  /** City slug, the folder under cities/. Names the stack and the records. */
  city: string;
  /** Full host name, for example la.snaphomz.com; must be a subdomain of the zone. */
  domain: string;
};

/**
 * One city site: a private S3 bucket behind CloudFront with a certificate and a Route 53 alias
 * in the existing snaphomz.com zone. Same shape as the other Snaphomz static sites. The site is a
 * static build (no API), so there is nothing here but the bucket and the CDN.
 */
export class SiteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SiteProps) {
    super(scope, id, props);

    const { city, domain } = props;
    const suffix = `.${ZONE.zoneName}`;
    if (!domain.endsWith(suffix)) throw new Error(`${city}: domain ${domain} must end with ${suffix}`);
    const recordName = domain.slice(0, -suffix.length);

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", ZONE);

    // CloudFront certificates must live in us-east-1; the deploy workflow runs the stack there.
    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: domain,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      comment: domain,
      domainNames: [domain],
      certificate,
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        // The neighborhood data files are large JSON; gzip/brotli at the edge matters.
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      // Routing is hash-based, so every page is index.html. A missing object from S3 behind
      // an access control arrives as 403; send both it and 404 to the app rather than an XML error.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: cdk.Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: cdk.Duration.minutes(5) },
      ],
    });

    const alias = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
    new route53.ARecord(this, "ARecord", { zone: hostedZone, recordName, target: alias });
    new route53.AaaaRecord(this, "AaaaRecord", { zone: hostedZone, recordName, target: alias });

    new cdk.CfnOutput(this, "DomainUrl", { value: `https://${domain}`, description: "Application URL" });
    new cdk.CfnOutput(this, "CloudFrontUrl", { value: `https://${distribution.distributionDomainName}`, description: "CloudFront distribution URL" });
    new cdk.CfnOutput(this, "DistributionId", { value: distribution.distributionId, description: "CloudFront distribution ID" });
    new cdk.CfnOutput(this, "SiteBucketOutput", { value: siteBucket.bucketName, description: "S3 bucket for static site" });
  }
}
