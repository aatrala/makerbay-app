import { BedrockAgentClient, GetIngestionJobCommand, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent'
import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime'
import { BedrockRuntimeClient, ConverseCommand, type Message } from '@aws-sdk/client-bedrock-runtime'
import type { AssistantConfigRow, MessageRow } from './db'

const agentClient = new BedrockAgentClient({})
const retrieveClient = new BedrockAgentRuntimeClient({})
const runtimeClient = new BedrockRuntimeClient({})

const KB_ID = () => process.env.KB_ID!
const DS_ID = () => process.env.DS_ID!
const MODEL_ID = () => process.env.CHAT_MODEL_ID!

export interface RetrievedChunk {
  text: string
  score: number
  sourceId: string
  sourceName: string
}

// Tenant isolation lives here: every retrieval carries a server-side
// equals-filter on tenantId. Never accept this value from client input.
export async function retrieveChunks(tenantId: string, query: string): Promise<RetrievedChunk[]> {
  const r = await retrieveClient.send(
    new RetrieveCommand({
      knowledgeBaseId: KB_ID(),
      retrievalQuery: { text: query.slice(0, 19000) },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: 6,
          filter: { equals: { key: 'tenantId', value: tenantId } },
        },
      },
    }),
  )
  return (r.retrievalResults ?? [])
    .filter((res) => res.content?.text)
    .map((res) => ({
      text: res.content!.text!,
      score: res.score ?? 0,
      sourceId: String(res.metadata?.sourceId ?? ''),
      sourceName: String(res.metadata?.sourceName ?? 'document'),
    }))
}

export interface GeneratedAnswer {
  text: string
  inputTokens: number
  outputTokens: number
}

export async function generateAnswer(
  config: AssistantConfigRow,
  chunks: RetrievedChunk[],
  history: MessageRow[],
  userMessage: string,
): Promise<GeneratedAnswer> {
  const context = chunks
    .map((c, i) => `[${i + 1}] (source: ${c.sourceName})\n${c.text}`)
    .join('\n\n')

  const system = [
    `You are "${config.name}", a helpful assistant for this business. Answer customer questions using ONLY the provided context.`,
    config.instructions ? `Follow these instructions from the business: ${config.instructions}` : '',
    `Rules: Be concise and friendly. If the context does not contain the answer, reply exactly with: ${config.fallbackMessage}`,
    `Context:\n${context}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  const messages: Message[] = [
    ...history.map((m) => ({
      role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
      content: [{ text: m.text }],
    })),
    { role: 'user' as const, content: [{ text: userMessage }] },
  ]

  const r = await runtimeClient.send(
    new ConverseCommand({
      modelId: MODEL_ID(),
      system: [{ text: system }],
      messages,
      inferenceConfig: { maxTokens: 1024, temperature: 0.4 },
    }),
  )

  const text =
    r.output?.message?.content
      ?.map((c) => c.text ?? '')
      .join('')
      .trim() ?? ''
  return {
    text,
    inputTokens: r.usage?.inputTokens ?? 0,
    outputTokens: r.usage?.outputTokens ?? 0,
  }
}

export async function startIngestion(): Promise<string> {
  const r = await agentClient.send(
    new StartIngestionJobCommand({ knowledgeBaseId: KB_ID(), dataSourceId: DS_ID() }),
  )
  return r.ingestionJob!.ingestionJobId!
}

export async function getIngestionStatus(jobId: string): Promise<string> {
  const r = await agentClient.send(
    new GetIngestionJobCommand({ knowledgeBaseId: KB_ID(), dataSourceId: DS_ID(), ingestionJobId: jobId }),
  )
  return r.ingestionJob?.status ?? 'UNKNOWN'
}
