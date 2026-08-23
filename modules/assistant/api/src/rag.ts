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
  fallback: boolean
  inputTokens: number
  outputTokens: number
}

/**
 * Decide whether a reply is really a fallback. The model occasionally leads
 * with the fallback sentence and then answers anyway; when there is a real
 * answer behind it we keep the answer and drop the disclaimer, and only treat
 * it as unanswered when nothing substantial follows.
 */
export function classifyAnswer(raw: string, fallbackMessage: string): { text: string; fallback: boolean } {
  const text = raw.trim()
  const fb = fallbackMessage.trim()
  if (!text) return { text: fb, fallback: true }
  if (!fb || !text.startsWith(fb)) return { text, fallback: false }
  const rest = text.slice(fb.length).replace(/^[\s—–\-:,.]+/, '').trim()
  return rest.length > 40 ? { text: rest, fallback: false } : { text: fb, fallback: true }
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

  // The decision procedure is spelled out because a vaguer "reply with the
  // fallback if you can't answer" gets applied halfway: the model leads with
  // the fallback sentence and then answers anyway.
  const system = [
    `You are "${config.name}", answering customers on behalf of this business.`,
    config.instructions ? `The business asks you to: ${config.instructions}` : '',
    [
      'How to answer:',
      '1. If the context below contains the answer, give it directly and concisely. Never preface it with a disclaimer.',
      '2. If the context covers only part of the question, answer that part and say plainly which part you do not have. Do not use the exact fallback sentence in this case.',
      `3. Only if the context contains nothing relevant at all, reply with exactly this sentence and nothing else: ${config.fallbackMessage}`,
      'Never combine rule 3 with an actual answer — either you can help or you cannot.',
      'Never invent facts, figures, policies or availability that are not in the context.',
      'Write in plain language, a few sentences at most, as a helpful colleague would.',
    ].join('\n'),
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

  const raw =
    r.output?.message?.content
      ?.map((c) => c.text ?? '')
      .join('')
      .trim() ?? ''
  const { text, fallback } = classifyAnswer(raw, config.fallbackMessage)
  return {
    text,
    fallback,
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
