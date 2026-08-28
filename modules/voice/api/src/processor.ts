/**
 * The asynchronous half of missed-call rescue. Three triggers, one file:
 *
 *  1. DynamoDB stream: a call was answered -> text the caller a booking link
 *     immediately, upsert the Contact, open a Request. This fires even when
 *     the caller hangs up during the greeting - their number is still a lead.
 *  2. S3 recordings/ prefix: a voicemail landed -> start transcription.
 *  3. S3 transcripts/ prefix: transcription finished -> extract the job
 *     details with Bedrock and attach them to the Request.
 *
 * Latency does not exist here, which is the whole point: the model reads a
 * transcript for our user; it never speaks to their customer.
 */

import type { DynamoDBStreamEvent, S3Event } from 'aws-lambda'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { StartTranscriptionJobCommand, TranscribeClient } from '@aws-sdk/client-transcribe'
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import {
  appendContactEvent,
  ddb,
  emitUsage,
  explainSmsError,
  getTenant,
  sendEmail,
  sendSms,
  ulid,
  upsertContact,
} from '@makerbay/core'

const s3 = new S3Client({})
const transcribe = new TranscribeClient({})
const bedrock = new BedrockRuntimeClient({})

const Tables = {
  events: () => process.env.TABLE_RESCUEEVENTS!,
  config: () => process.env.TABLE_RESCUECONFIG!,
  requests: () => process.env.TABLE_REQUESTS!,
}
const AUDIO_BUCKET = () => process.env.RESCUE_AUDIO_BUCKET!
const MODEL_ID = () => process.env.CHAT_MODEL_ID!
const APP = 'https://app.makerbay.app'

export const handler = async (event: DynamoDBStreamEvent | S3Event): Promise<void> => {
  if ('Records' in event && event.Records[0] && 'dynamodb' in event.Records[0]) {
    for (const record of (event as DynamoDBStreamEvent).Records) {
      const img = record.dynamodb?.NewImage
      if (record.eventName === 'INSERT' && img?.status?.S === 'answered') {
        await rescue(img.tenantId!.S!, img.rescueId!.S!, img.caller?.S ?? '')
      }
    }
    return
  }
  for (const record of (event as S3Event).Records ?? []) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '))
    if (key.startsWith('recordings/')) await startTranscription(key)
    else if (key.startsWith('transcripts/')) await finishTranscription(key)
  }
}

// ── 1. The rescue itself: speed is the mechanism ─────────────────────────

async function rescue(tenantId: string, rescueId: string, caller: string): Promise<void> {
  // Streams deliver at least once. A duplicate here would text the customer
  // twice, so the row's own status is the idempotency guard: only the first
  // delivery finds it still 'answered'.
  const existing = await ddb.send(
    new GetCommand({ TableName: Tables.events(), Key: { tenantId, rescueId } }),
  )
  if (existing.Item?.status !== 'answered') return

  const [tenant, cfgRow] = await Promise.all([
    getTenant(tenantId),
    ddb.send(new GetCommand({ TableName: Tables.config(), Key: { tenantId } })),
  ])
  if (!tenant) return
  const notifyEmail = String(cfgRow.Item?.notifyEmail ?? '')

  // Withheld numbers can only alert the owner; everything else gets the text.
  const anonymous = !caller || /anonymous|restricted|unavailable/i.test(caller)
  const contact = anonymous
    ? undefined
    : await upsertContact(tenantId, { phone: caller, source: 'rescue' })

  const pageUrl = `https://makerbay.app/p/${tenant.slug}`
  const sms = anonymous
    ? { sent: false, error: 'no_recipient' as const }
    : await sendSms(
        caller,
        `Sorry we missed your call - ${tenant.name}. Book a time or see prices here: ${pageUrl}. You can also just call back.`,
      )

  // The request is the durable lead; the SMS and email are best-effort.
  const requestId = ulid()
  const now = new Date().toISOString()
  if (contact) {
    await ddb.send(
      new PutCommand({
        TableName: Tables.requests(),
        // Mirrors modules/requests RequestRow. A shared writer would couple
        // the two Lambdas' bundles; the shape is asserted by the inbox tests.
        Item: {
          tenantId,
          requestId,
          kind: 'missedcall',
          status: 'new',
          contactId: contact.contactId,
          phone: contact.phone,
          subject: `Missed call from ${caller}`,
          message: 'The caller had not left a message when this was created. A voicemail transcript is attached if they did.',
          source: 'rescue',
          createdAt: now,
          updatedAt: now,
        },
      }),
    )
    await appendContactEvent(tenantId, contact.contactId, {
      moduleId: 'voice',
      title: sms.sent ? 'Missed call rescued - booking link texted' : 'Missed call logged',
      href: `/requests/${requestId}`,
    })
  }

  await ddb.send(
    new UpdateCommand({
      TableName: Tables.events(),
      Key: { tenantId, rescueId },
      ConditionExpression: '#st = :answered',
      UpdateExpression: 'SET #st = :st, smsSent = :sms, smsError = :err, requestId = :rid, contactId = :cid',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':answered': 'answered',
        ':st': 'rescued',
        ':sms': sms.sent,
        ':err': sms.error ?? null,
        ':rid': contact ? requestId : null,
        ':cid': contact?.contactId ?? null,
      },
    }),
  )

  await sendEmail({
    to: notifyEmail,
    audience: 'owner' as const,
    ref: { tenantId, moduleId: 'voice', refType: 'request', refId: rescueId },
    subject: `Missed call from ${anonymous ? 'a withheld number' : caller}`,
    text: [
      `Someone called ${tenant.name} and nobody could answer.`,
      anonymous ? 'The number was withheld, so no text could be sent.' :
        sms.sent
          ? `They have been texted a booking link at ${caller}.`
          : `${explainSmsError(sms.error) ?? ''} Call them back on ${caller}.`,
      '',
      contact ? `The lead: ${APP}/requests/${requestId}` : '',
    ].join('\n'),
  })

  await emitUsage({ tenantId, moduleId: 'voice', metric: 'missedcall.rescued', quantity: 1 })
  if (sms.sent) await emitUsage({ tenantId, moduleId: 'voice', metric: 'sms.sent', quantity: 1 })
}

// ── 2 & 3. The voicemail, understood at leisure ──────────────────────────

const keyParts = (key: string) => {
  // recordings/{tenantId}/{rescueId}...  |  transcripts/{tenantId}/{rescueId}.json
  const m = key.match(/^[a-z]+\/([0-9A-Z]{26})\/([0-9A-Z]{26})/)
  return m ? { tenantId: m[1], rescueId: m[2] } : undefined
}

async function startTranscription(key: string): Promise<void> {
  const ids = keyParts(key)
  if (!ids) return
  await transcribe.send(
    new StartTranscriptionJobCommand({
      TranscriptionJobName: `rescue-${ids.rescueId}-${ulid().slice(-6)}`,
      Media: { MediaFileUri: `s3://${AUDIO_BUCKET()}/${key}` },
      IdentifyLanguage: true,
      LanguageOptions: ['en-AU', 'en-IN', 'en-US', 'en-GB', 'hi-IN'],
      OutputBucketName: AUDIO_BUCKET(),
      OutputKey: `transcripts/${ids.tenantId}/${ids.rescueId}.json`,
    }),
  )
}

async function finishTranscription(key: string): Promise<void> {
  const ids = keyParts(key)
  if (!ids) return
  const obj = await s3.send(new GetObjectCommand({ Bucket: AUDIO_BUCKET(), Key: key }))
  const doc = JSON.parse((await obj.Body?.transformToString()) ?? '{}')
  const transcript: string = doc.results?.transcripts?.[0]?.transcript ?? ''
  if (!transcript.trim()) return

  const extracted = await extract(transcript)

  const row = await ddb.send(
    new GetCommand({ TableName: Tables.events(), Key: { tenantId: ids.tenantId, rescueId: ids.rescueId } }),
  )
  const requestId = row.Item?.requestId as string | undefined
  const contactId = row.Item?.contactId as string | undefined

  await ddb.send(
    new UpdateCommand({
      TableName: Tables.events(),
      Key: { tenantId: ids.tenantId, rescueId: ids.rescueId },
      UpdateExpression: 'SET transcript = :t, extracted = :e, #st = :st',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':t': transcript.slice(0, 4000),
        ':e': extracted,
        ':st': 'transcribed',
      },
    }),
  )

  if (requestId) {
    // The extracted summary becomes the request the tradie actually reads.
    const subject = extracted.job
      ? `${extracted.urgent ? 'URGENT - ' : ''}${extracted.job.slice(0, 100)}`
      : undefined
    await ddb.send(
      new UpdateCommand({
        TableName: Tables.requests(),
        Key: { tenantId: ids.tenantId, requestId },
        UpdateExpression: subject
          ? 'SET message = :m, subject = :s, updatedAt = :now'
          : 'SET message = :m, updatedAt = :now',
        ExpressionAttributeValues: {
          ':m': voicemailBody(transcript, extracted),
          ...(subject ? { ':s': subject } : {}),
          ':now': new Date().toISOString(),
        },
      }),
    )
  }

  // Contact details heard in the voicemail fill blanks, never overwrite.
  if (contactId && (extracted.name || extracted.address)) {
    await appendContactEvent(ids.tenantId, contactId, {
      moduleId: 'voice',
      title: 'Left a voicemail',
      body: transcript.slice(0, 280),
    })
  }
}

interface Extracted {
  name?: string
  job?: string
  address?: string
  urgent: boolean
  callback?: string
}

const voicemailBody = (transcript: string, e: Extracted): string =>
  [
    e.job ? `Job: ${e.job}` : '',
    e.name ? `Name: ${e.name}` : '',
    e.address ? `Address: ${e.address}` : '',
    e.callback ? `Best time to call back: ${e.callback}` : '',
    e.urgent ? 'They described it as urgent.' : '',
    '',
    `What they said: "${transcript.slice(0, 2000)}"`,
  ]
    .filter((l, i, a) => l !== '' || i === a.length - 2)
    .join('\n')

/**
 * Pull structure out of the voicemail. The raw transcript is always kept and
 * always shown - the extraction is a convenience on top, never a replacement,
 * so a wrong extraction is an inconvenience rather than a lost address.
 */
async function extract(transcript: string): Promise<Extracted> {
  try {
    const r = await bedrock.send(
      new ConverseCommand({
        modelId: MODEL_ID(),
        messages: [
          {
            role: 'user',
            content: [
              {
                text:
                  'A customer left this voicemail for a trade business. Extract what is actually said - never guess or invent. ' +
                  'Reply with only JSON: {"name": string|null, "job": string|null (one line, what they need done), ' +
                  '"address": string|null, "callback": string|null (when to ring back), "urgent": boolean ' +
                  '(true only for words like emergency, flooding, gas, no power, urgent)}.\n\nVoicemail:\n' +
                  transcript.slice(0, 3000),
              },
            ],
          },
        ],
        inferenceConfig: { maxTokens: 300, temperature: 0 },
      }),
    )
    const text = r.output?.message?.content?.[0]?.text ?? '{}'
    const parsed = JSON.parse(text.replace(/^[^{]*/, '').replace(/[^}]*$/, ''))
    return {
      name: parsed.name || undefined,
      job: parsed.job || undefined,
      address: parsed.address || undefined,
      callback: parsed.callback || undefined,
      urgent: parsed.urgent === true,
    }
  } catch (err) {
    console.warn('voicemail extraction failed; transcript still attached', err)
    return { urgent: false }
  }
}
