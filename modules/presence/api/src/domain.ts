import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import {
  ACMClient,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  RequestCertificateCommand,
} from '@aws-sdk/client-acm'
import {
  CloudFrontClient,
  CreateDistributionCommand,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront'
import { listGrants, resolveEntitlement } from '@makerbay/core'
import { getPresenceConfig, putPresenceConfig, type PresenceConfigRow } from './db'

/**
 * A tenant's page on their own domain: an ACM certificate validated by DNS,
 * then a small per-tenant CloudFront distribution in front of the same
 * presence renderer. Three states the owner can always see:
 *
 *   pending_validation - waiting for them to add the validation CNAME
 *   pending_dns        - certificate issued, distribution made; waiting for
 *                        them to point the domain at it
 *   active             - the distribution answers on their domain
 *
 * Pro-gated: this is the paid half of Presence. The free page at
 * makerbay.app/p/{slug} never goes away.
 */

const acm = new ACMClient({})
const cf = new CloudFrontClient({})

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

// A plausible hostname with at least one dot, and never one of ours. The
// operator allowlist exists so the whole flow can be exercised end-to-end
// against a subdomain we control; tenants can never claim makerbay.app names.
const DOMAIN_RX = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/
const operatorAllow = () => (process.env.DOMAIN_TEST_ALLOW ?? '').split(',').filter(Boolean)
const isOwnable = (d: string) =>
  DOMAIN_RX.test(d) &&
  (operatorAllow().includes(d) || (!d.endsWith('.makerbay.app') && d !== 'makerbay.app'))

async function requirePro(tenantId: string): Promise<APIGatewayProxyResultV2 | undefined> {
  // Presence is a free module, so getEffectiveEntitlement short-circuits to
  // the free tier without reading grants. Pro is exactly a grant, so read
  // the grants directly - a 'presence' grant at tier 'pro' opens the gate.
  const ent = resolveEntitlement('presence', await listGrants(tenantId, 'presence'), true)
  if (ent.planTier === 'pro') return undefined
  return json(402, {
    error: 'pro_required',
    message: 'A custom domain is part of Presence Pro. The makerbay.app page stays free.',
  })
}

interface DomainView {
  domain: string | null
  status?: string
  validation?: { name: string; value: string }
  target?: string
}

function view(config: PresenceConfigRow): DomainView {
  if (!config.customDomain) return { domain: null }
  return {
    domain: config.customDomain,
    status: config.domainStatus,
    validation: config.domainValidation,
    target: config.distributionDomain,
  }
}

export async function putDomain(
  tenantId: string,
  b: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const gate = await requirePro(tenantId)
  if (gate) return gate

  // People paste URLs, not hostnames. Take what they meant: strip protocol,
  // path, port and trailing dot before judging validity.
  const domain = String(b.domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
  if (!isOwnable(domain)) {
    return json(400, { error: 'invalid_domain', message: 'Enter a domain you own, like smithplumbing.com.au.' })
  }

  const existing = await getPresenceConfig(tenantId)
  if (existing.customDomain && existing.customDomain !== domain) {
    return json(409, {
      error: 'domain_exists',
      message: `This page already uses ${existing.customDomain}. Remove it first to change domains.`,
    })
  }
  if (existing.customDomain === domain) return getDomain(tenantId)

  const cert = await acm.send(
    new RequestCertificateCommand({
      DomainName: domain,
      ValidationMethod: 'DNS',
      Tags: [{ Key: 'makerbay-tenant', Value: tenantId }],
    }),
  )

  const validation = await validationRecord(cert.CertificateArn!)
  await putPresenceConfig({
    ...existing,
    tenantId,
    customDomain: domain,
    domainCertArn: cert.CertificateArn,
    domainStatus: 'pending_validation',
    domainValidation: validation,
    updatedAt: new Date().toISOString(),
  })
  return json(200, {
    ...view({ ...existing, customDomain: domain, domainStatus: 'pending_validation', domainValidation: validation }),
    message: validation
      ? 'Add this CNAME record at your DNS provider, then check back - issuing usually takes a few minutes after that.'
      : 'Certificate requested. Check back in a minute for the DNS record to add.',
  })
}

/** ACM publishes the validation CNAME a moment after the request; poll briefly. */
async function validationRecord(certArn: string): Promise<{ name: string; value: string } | undefined> {
  for (let i = 0; i < 5; i++) {
    const d = await acm.send(new DescribeCertificateCommand({ CertificateArn: certArn }))
    const rr = d.Certificate?.DomainValidationOptions?.[0]?.ResourceRecord
    if (rr?.Name && rr.Value) return { name: rr.Name, value: rr.Value }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return undefined
}

export async function getDomain(tenantId: string): Promise<APIGatewayProxyResultV2> {
  const config = await getPresenceConfig(tenantId)
  if (!config.customDomain || !config.domainCertArn) {
    // Reads are never gated, but the card needs to know whether a PUT would
    // be - so the upgrade ask appears before typing, not after submitting.
    const pro = !(await requirePro(tenantId))
    return json(200, { domain: null, pro })
  }

  // Fill in the validation record if the PUT could not see it yet.
  if (config.domainStatus === 'pending_validation' && !config.domainValidation) {
    config.domainValidation = await validationRecord(config.domainCertArn)
    if (config.domainValidation) await putPresenceConfig(config)
  }

  const cert = await acm.send(new DescribeCertificateCommand({ CertificateArn: config.domainCertArn }))
  const certStatus = cert.Certificate?.Status

  if (certStatus === 'ISSUED' && !config.distributionId) {
    try {
      const dist = await createDistribution(tenantId, config.customDomain, config.domainCertArn)
      config.distributionId = dist.id
      config.distributionDomain = dist.domainName
      config.domainStatus = 'pending_dns'
      config.updatedAt = new Date().toISOString()
      await putPresenceConfig(config)
    } catch (err) {
      // One CNAME per distribution, globally. A recently removed setup can
      // still hold the alias until its disable deploys (a few minutes).
      if (/^CNAMEAlreadyExists/.test((err as { name?: string }).name ?? '')) {
        return json(409, {
          ...view(config),
          certStatus,
          error: 'alias_busy',
          message: 'This domain is still attached to a previous setup here. Wait a few minutes and press Check status again.',
        })
      }
      throw err
    }
  }

  if (config.domainStatus === 'pending_dns' && config.distributionId) {
    const d = await cf.send(new GetDistributionCommand({ Id: config.distributionId }))
    if (d.Distribution?.Status === 'Deployed') {
      config.domainStatus = 'active'
      config.updatedAt = new Date().toISOString()
      await putPresenceConfig(config)
    }
  }

  const messages: Record<string, string> = {
    pending_validation: 'Waiting for the validation CNAME below to appear at your DNS provider.',
    pending_dns: `Certificate issued. Point ${config.customDomain} at ${config.distributionDomain ?? 'the address below'} with a CNAME, and give it a few minutes.`,
    active: `Live. ${config.customDomain} serves your page (make sure the CNAME points at ${config.distributionDomain}).`,
  }
  return json(200, {
    ...view(config),
    certStatus,
    message: messages[config.domainStatus ?? ''] ?? '',
  })
}

async function createDistribution(
  tenantId: string,
  domain: string,
  certArn: string,
): Promise<{ id: string; domainName: string }> {
  const r = await cf.send(
    new CreateDistributionCommand({
      DistributionConfig: {
        // Unique per creation: a static reference would forbid ever
        // re-creating a distribution for the same tenant after a remove.
        CallerReference: `makerbay-presence-${tenantId}-${Date.now()}`,
        Comment: `MakerBay presence page for ${domain}`,
        Enabled: true,
        Aliases: { Quantity: 1, Items: [domain] },
        // AU is the target market and lives outside the cheaper price classes.
        PriceClass: 'PriceClass_All',
        Origins: {
          Quantity: 1,
          Items: [
            {
              Id: 'presence-api',
              DomainName: 'api.makerbay.app',
              CustomOriginConfig: {
                HTTPPort: 80,
                HTTPSPort: 443,
                OriginProtocolPolicy: 'https-only',
                OriginSslProtocols: { Quantity: 1, Items: ['TLSv1.2'] },
              },
            },
          ],
        },
        DefaultCacheBehavior: {
          TargetOriginId: 'presence-api',
          ViewerProtocolPolicy: 'redirect-to-https',
          Compress: true,
          CachePolicyId: process.env.PRESENCE_CACHE_POLICY_ID!,
          AllowedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] },
          FunctionAssociations: {
            Quantity: 1,
            Items: [
              { EventType: 'viewer-request', FunctionARN: process.env.DOMAIN_REWRITE_FN_ARN! },
            ],
          },
        },
        ViewerCertificate: {
          ACMCertificateArn: certArn,
          SSLSupportMethod: 'sni-only',
          MinimumProtocolVersion: 'TLSv1.2_2021',
        },
      },
    }),
  )
  return { id: r.Distribution!.Id!, domainName: r.Distribution!.DomainName! }
}

export async function deleteDomain(tenantId: string): Promise<APIGatewayProxyResultV2> {
  const config = await getPresenceConfig(tenantId)
  if (!config.customDomain) return json(200, { domain: null })

  // Disable the distribution so the domain stops serving, and RELEASE its
  // alias - CloudFront enforces one distribution per CNAME globally, so a
  // disabled distribution still holding the alias would block the domain
  // from ever being connected again. Full deletion needs the disable to
  // deploy first; the disabled, alias-free distribution costs nothing and
  // can be cleaned up by hand later.
  if (config.distributionId) {
    try {
      const current = await cf.send(new GetDistributionConfigCommand({ Id: config.distributionId }))
      const cfg = current.DistributionConfig
      if (cfg && (cfg.Enabled || (cfg.Aliases?.Quantity ?? 0) > 0)) {
        await cf.send(
          new UpdateDistributionCommand({
            Id: config.distributionId,
            IfMatch: current.ETag,
            DistributionConfig: { ...cfg, Enabled: false, Aliases: { Quantity: 0, Items: [] } },
          }),
        )
      }
    } catch (err) {
      console.warn('distribution disable failed', { tenantId, err })
    }
  } else if (config.domainCertArn) {
    // No distribution yet - the certificate is unused and can go now.
    try {
      await acm.send(new DeleteCertificateCommand({ CertificateArn: config.domainCertArn }))
    } catch (err) {
      console.warn('certificate delete failed', { tenantId, err })
    }
  }

  await putPresenceConfig({
    ...config,
    tenantId,
    customDomain: undefined,
    domainCertArn: undefined,
    domainStatus: undefined,
    domainValidation: undefined,
    distributionId: undefined,
    distributionDomain: undefined,
    updatedAt: new Date().toISOString(),
  })
  return json(200, { domain: null, message: 'Removed. Your makerbay.app page is unaffected.' })
}
