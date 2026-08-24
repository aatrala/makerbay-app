import { BedrockAgentClient, GetIngestionJobCommand, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent'
import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime'
import type { Citation } from './db'
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type Message,
} from '@aws-sdk/client-bedrock-runtime'
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
  /** Where the chunk came from, when the source was a web page. */
  sourceUrl?: string
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
      sourceUrl: res.metadata?.sourceUrl ? String(res.metadata.sourceUrl) : undefined,
    }))
}

/**
 * One citation per source, carrying the passage the answer actually came
 * from. Keeping the best-scoring chunk rather than the first means the
 * excerpt shown is the one that earned the answer.
 */
export function buildCitations(chunks: RetrievedChunk[]): Citation[] {
  const best = new Map<string, RetrievedChunk>()
  for (const c of chunks) {
    const existing = best.get(c.sourceId)
    if (!existing || c.score > existing.score) best.set(c.sourceId, c)
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .map((c) => ({
      sourceId: c.sourceId,
      name: c.sourceName,
      // Long enough to be checkable, short enough not to republish the file.
      excerpt: trimToSentence(c.text, 320),
      sourceUrl: c.sourceUrl,
    }))
}

/** Cut at a sentence boundary so an excerpt does not end mid-word. */
function trimToSentence(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s\S*$/, '')) + '…'
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

/** One prompt definition shared by the streaming and non-streaming paths. */
function buildPrompt(
  config: AssistantConfigRow,
  chunks: RetrievedChunk[],
  history: MessageRow[],
  userMessage: string,
): { system: string; messages: Message[] } {
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
  return { system, messages }
}

export async function generateAnswer(
  config: AssistantConfigRow,
  chunks: RetrievedChunk[],
  history: MessageRow[],
  userMessage: string,
): Promise<GeneratedAnswer> {
  const { system, messages } = buildPrompt(config, chunks, history, userMessage)

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

/**
 * Same prompt and model as generateAnswer, but yields tokens as they arrive.
 * Callers decide what to do with partial text; the accumulated text is
 * returned so it can be classified and stored once complete.
 */
export async function streamAnswer(
  config: AssistantConfigRow,
  chunks: RetrievedChunk[],
  history: MessageRow[],
  userMessage: string,
  onDelta: (text: string) => void,
): Promise<GeneratedAnswer> {
  const { system, messages } = buildPrompt(config, chunks, history, userMessage)

  const r = await runtimeClient.send(
    new ConverseStreamCommand({
      modelId: MODEL_ID(),
      system: [{ text: system }],
      messages,
      inferenceConfig: { maxTokens: 1024, temperature: 0.4 },
    }),
  )

  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  for await (const chunk of r.stream ?? []) {
    const delta = chunk.contentBlockDelta?.delta?.text
    if (delta) {
      text += delta
      onDelta(delta)
    }
    if (chunk.metadata?.usage) {
      inputTokens = chunk.metadata.usage.inputTokens ?? 0
      outputTokens = chunk.metadata.usage.outputTokens ?? 0
    }
  }

  const decided = classifyAnswer(text, config.fallbackMessage)
  return { text: decided.text, fallback: decided.fallback, inputTokens, outputTokens }
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
