import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly'
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { type CallerContext, ddb, getTenant, getUser, json } from '@makerbay/core'

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

const s3 = new S3Client({})
const polly = new PollyClient({})

const Tables = {
  config: () => process.env.TABLE_RESCUECONFIG!,
  numbers: () => process.env.TABLE_RESCUENUMBERS!,
  events: () => process.env.TABLE_RESCUEEVENTS!,
}
const AUDIO_BUCKET = () => process.env.RESCUE_AUDIO_BUCKET!

interface RescueConfigRow {
  tenantId: string
  phoneNumber?: string
  greetingText: string
  notifyEmail: string
  updatedAt?: string
}

const DEFAULT_GREETING = (business: string) =>
  `Hi, you have reached ${business}. We can't get to the phone right now - ` +
  `we are texting you a booking link as you listen. You can also leave a message after the tone, ` +
  `and we will call you back.`

export const handler = async (event: Event): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method
  const path = event.rawPath
  try {
    const ctx = event.requestContext.authorizer.lambda
    const tenantId = await resolveTenantId(ctx)
    if (!tenantId) return json(401, { error: 'unauthorized' })

    if (method === 'GET' && path === '/v1/voice/config') return await readConfig(tenantId)
    if (method === 'PUT' && path === '/v1/voice/config') return await writeConfig(tenantId, event)
    if (method === 'GET' && path === '/v1/voice/rescues') return await rescues(tenantId)

    return json(404, { error: 'not_found' })
  } catch (err) {
    console.error('rescue error', { path, method, err })
    return json(500, { error: 'internal_error' })
  }
}

async function resolveTenantId(ctx: CallerContext): Promise<string> {
  if (ctx.keyId) return ctx.tenantId
  if (!ctx.userId) return ''
  return (await getUser(ctx.userId))?.tenantId ?? ''
}

async function getConfig(tenantId: string): Promise<RescueConfigRow> {
  const r = await ddb.send(new GetCommand({ TableName: Tables.config(), Key: { tenantId } }))
  const tenant = r.Item ? undefined : await getTenant(tenantId)
  return {
    tenantId,
    greetingText: DEFAULT_GREETING(tenant?.name ?? 'us'),
    notifyEmail: '',
    ...(r.Item ?? {}),
  } as RescueConfigRow
}

async function readConfig(tenantId: string): Promise<APIGatewayProxyResultV2> {
  const config = await getConfig(tenantId)
  return json(200, {
    config,
    // Forwarding is a native phone feature: no app, works on every handset.
    forwarding: config.phoneNumber
      ? {
          number: config.phoneNumber,
          enableOnNoAnswer: `**61*${config.phoneNumber.replace('+', '')}**11*20#`,
          enableWhenBusy: `**67*${config.phoneNumber.replace('+', '')}#`,
          disable: '##002#',
          note: 'Dial the enable code once from the phone whose calls should be rescued. 20 is the seconds before forwarding; most carriers allow 5 to 30.',
        }
      : null,
  })
}

const body = (event: Event): Record<string, unknown> => {
  try {
    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

async function writeConfig(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const existing = await getConfig(tenantId)
  const config: RescueConfigRow = {
    ...existing,
    tenantId,
    greetingText: String(b.greetingText ?? existing.greetingText).slice(0, 400),
    notifyEmail: String(b.notifyEmail ?? existing.notifyEmail).slice(0, 200),
    updatedAt: new Date().toISOString(),
  }
  await ddb.send(new PutCommand({ TableName: Tables.config(), Item: config }))

  // The greeting the caller hears is this text, synthesized once on save.
  // Chime PlayAudio wants 8kHz mono PCM WAV; Polly emits headerless PCM.
  const greetingKey = `greetings/${tenantId}.wav`
  const speech = await polly.send(
    new SynthesizeSpeechCommand({
      Text: config.greetingText,
      VoiceId: 'Olivia',
      Engine: 'neural',
      OutputFormat: 'pcm',
      SampleRate: '8000',
    }),
  )
  const pcm = Buffer.from((await speech.AudioStream?.transformToByteArray()) ?? [])
  await s3.send(
    new PutObjectCommand({
      Bucket: AUDIO_BUCKET(),
      Key: greetingKey,
      Body: wavFromPcm(pcm, 8000),
      ContentType: 'audio/wav',
    }),
  )

  // Keep the number -> tenant mapping's greeting pointer current.
  if (config.phoneNumber) {
    await ddb.send(
      new PutCommand({
        TableName: Tables.numbers(),
        Item: { phoneNumber: config.phoneNumber, tenantId, greetingKey },
      }),
    )
  }
  return readConfig(tenantId)
}

/** Wrap raw 16-bit mono PCM in a WAV header. 44 bytes, no dependencies. */
export function wavFromPcm(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // PCM chunk size
  header.writeUInt16LE(1, 20) // PCM format
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate: 16-bit mono
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

async function rescues(tenantId: string): Promise<APIGatewayProxyResultV2> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.events(),
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
      ScanIndexForward: false,
      Limit: 100,
    }),
  )
  return json(200, { rescues: r.Items ?? [] })
}
