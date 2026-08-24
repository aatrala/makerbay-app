/**
 * Answers the phone when the tradie could not. This Lambda is invoked by a
 * Chime SDK SIP media application for every event on the call.
 *
 * The whole design constraint from docs/analysis-voice-market.md Part 4: the
 * AI never speaks with the caller. The caller hears a recorded greeting in
 * the business's name, leaves a message, and hangs up. Latency, accents and
 * hallucination cannot embarrass anyone, because there is no conversation.
 *
 * Everything time-sensitive ends here; understanding the message happens
 * asynchronously in processor.ts where latency does not exist.
 */

import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, ulid } from '@makerbay/core'

const Tables = {
  numbers: () => process.env.TABLE_RESCUENUMBERS!,
  events: () => process.env.TABLE_RESCUEEVENTS!,
}
const AUDIO_BUCKET = () => process.env.RESCUE_AUDIO_BUCKET!

interface SipEvent {
  InvocationEventType: string
  CallDetails: {
    TransactionId: string
    Participants: Array<{ CallId: string; From: string; To: string; Direction: string }>
    TransactionAttributes?: Record<string, string>
  }
  ActionData?: { Type: string; Parameters?: Record<string, unknown> }
}

interface SipResponse {
  SchemaVersion: '1.0'
  Actions: Array<Record<string, unknown>>
  TransactionAttributes?: Record<string, string>
}

const respond = (
  actions: Array<Record<string, unknown>>,
  attrs?: Record<string, string>,
): SipResponse => ({ SchemaVersion: '1.0', Actions: actions, ...(attrs ? { TransactionAttributes: attrs } : {}) })

const hangup = (callId: string) => ({ Type: 'Hangup', Parameters: { CallId: callId, SipResponseCode: '0' } })

export const handler = async (event: SipEvent): Promise<SipResponse> => {
  const call = event.CallDetails.Participants.find((p) => p.Direction === 'Inbound')
  const callId = call?.CallId ?? ''

  switch (event.InvocationEventType) {
    case 'NEW_INBOUND_CALL': {
      if (!call) return respond([])
      // The dialled number identifies the tenant - one rescue number each.
      const mapping = await ddb.send(
        new GetCommand({ TableName: Tables.numbers(), Key: { phoneNumber: call.To } }),
      )
      const tenantId = mapping.Item?.tenantId as string | undefined
      const greetingKey = mapping.Item?.greetingKey as string | undefined
      if (!tenantId || !greetingKey) {
        console.warn('call to unmapped number', { to: call.To })
        return respond([hangup(callId)])
      }

      const rescueId = ulid()
      // The row exists before anything else happens, so even a caller who
      // hangs up mid-greeting is a visible missed call, not a mystery.
      await ddb.send(
        new PutCommand({
          TableName: Tables.events(),
          Item: {
            tenantId,
            rescueId,
            caller: call.From,
            calledNumber: call.To,
            status: 'answered',
            at: new Date().toISOString(),
          },
        }),
      )

      return respond(
        [
          {
            Type: 'PlayAudio',
            Parameters: {
              CallId: callId,
              AudioSource: { Type: 'S3', BucketName: AUDIO_BUCKET(), Key: greetingKey },
            },
          },
          {
            Type: 'RecordAudio',
            Parameters: {
              CallId: callId,
              DurationInSeconds: 120,
              SilenceDurationInSeconds: 4,
              SilenceThreshold: 100,
              RecordingTerminators: ['#'],
              RecordingDestination: {
                Type: 'S3',
                BucketName: AUDIO_BUCKET(),
                // The processor parses tenant and rescue ids back out of the key.
                Prefix: `recordings/${tenantId}/${rescueId}`,
              },
            },
          },
        ],
        { tenantId, rescueId },
      )
    }

    case 'ACTION_SUCCESSFUL': {
      if (event.ActionData?.Type === 'RecordAudio') {
        const attrs = event.CallDetails.TransactionAttributes ?? {}
        const dest = (event.ActionData.Parameters?.RecordingDestination ?? {}) as Record<string, string>
        if (attrs.tenantId && attrs.rescueId) {
          await ddb.send(
            new UpdateCommand({
              TableName: Tables.events(),
              Key: { tenantId: attrs.tenantId, rescueId: attrs.rescueId },
              UpdateExpression: 'SET recordingKey = :k, recordedAt = :at',
              ExpressionAttributeValues: { ':k': dest.Key, ':at': new Date().toISOString() },
            }),
          )
        }
        return respond([hangup(callId)])
      }
      return respond([])
    }

    // A caller who hangs up during the greeting or the beep still counts:
    // the 'answered' row already exists and the processor's S3 trigger simply
    // never fires. HANGUP itself needs no action.
    case 'HANGUP':
    case 'ACTION_FAILED':
    default:
      return respond([])
  }
}
