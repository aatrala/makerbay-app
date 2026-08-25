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
  facts = '',
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
    // The workspace's own settings are first-class context: services, prices,
    // hours and areas should be answerable before any document is uploaded.
    facts ? `Facts from the business's own settings (treat as context):\n${facts}` : '',
    [
      'How to answer:',
      '1. If the context or business facts below contain the answer, give it directly and concisely. Never preface it with a disclaimer.',
      '2. If they cover only part of the question, answer that part and say plainly which part you do not have. Do not use the exact fallback sentence in this case.',
      `3. Only if neither contains anything relevant at all, reply with exactly this sentence and nothing else: ${config.fallbackMessage}`,
      'Never combine rule 3 with an actual answer — either you can help or you cannot.',
      'Never invent facts, figures, policies or availability that are not in the context or business facts.',
      'If someone wants to book, tell them they can pick a time with the Book a time button on this page.',
      'Write in plain language, a few sentences at most, as a helpful colleague would.',
    ].join('\n'),
    context ? `Context:\n${context}` : 'Context: (no documents matched this question)',
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
  facts = '',
): Promise<GeneratedAnswer> {
  const { system, messages } = buildPrompt(config, chunks, history, userMessage, facts)

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
  facts = '',
): Promise<GeneratedAnswer> {
  const { system, messages } = buildPrompt(config, chunks, history, userMessage, facts)

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

export interface HelpMeta {
  title: string
  description: string
  category: string
}

export const HELP_CATEGORIES = [
  'Getting started',
  'Services & pricing',
  'Bookings & appointments',
  'Policies & guarantees',
  'Troubleshooting',
  'General',
] as const

/**
 * A customer-facing title, one-line description and category for a published
 * help article, generated once at publish time. A filename is not a headline
 * and a raw excerpt is not a description; one cheap model call fixes both
 * and gives the index real structure to group by.
 */
/**
 * A readable article body, generated once at publish time. Extraction
 * flattens documents into run-on text; one cheap model call restores the
 * structure a reader needs (headings, steps, lists) as markdown-lite the
 * help renderer understands. Best-effort: publishing never fails on it.
 */
export async function generateHelpBody(
  businessName: string,
  sourceName: string,
  text: string,
): Promise<string | undefined> {
  try {
    const r = await runtimeClient.send(
      new ConverseCommand({
        modelId: MODEL_ID(),
        system: [{
          text: [
            `You format help-centre articles for ${businessName}, a local service business.`,
            'Rewrite the document as a clean, readable article using ONLY this markdown subset:',
            '"## " section headings (use "## 1. Step name" numbering when the content is a sequence of steps),',
            '"- " bullet lists, "**bold**", and lines starting "Tip:", "Note:" or "Warning:" for asides.',
            'Keep every fact; never invent one. Remove navigation crumbs, cookie notices and site chrome.',
            'Do not add a title heading - the page renders the title separately.',
            'Reply with ONLY the article body.',
          ].join('\n'),
        }],
        messages: [{
          role: 'user',
          content: [{ text: `Document name: ${sourceName}\n\nDocument content:\n${text.slice(0, 12000)}` }],
        }],
        inferenceConfig: { maxTokens: 2500, temperature: 0.2 },
      }),
    )
    const body = (r.output?.message?.content?.map((c) => c.text ?? '').join('') ?? '').trim()
    // A body shorter than a sentence means the model refused or the source
    // was junk - better to fall back to the raw text than publish a stub.
    return body.length > 80 ? body.slice(0, 40000) : undefined
  } catch (err) {
    console.warn('help body generation failed', { sourceName, err: String(err) })
    return undefined
  }
}

export async function generateHelpMeta(
  businessName: string,
  sourceName: string,
  text: string,
): Promise<HelpMeta | undefined> {
  try {
    const r = await runtimeClient.send(
      new ConverseCommand({
        modelId: MODEL_ID(),
        system: [{
          text: [
            `You title help-centre articles for ${businessName}, a local service business.`,
            'Reply with ONLY a JSON object: {"title": string, "description": string, "category": string}.',
            'title: at most 60 characters, written for the business\'s customers, no filename artifacts.',
            'description: one plain sentence, at most 140 characters, saying what a reader will learn.',
            `category: exactly one of ${JSON.stringify(HELP_CATEGORIES)}.`,
            'Never invent facts not present in the document.',
          ].join('\n'),
        }],
        messages: [{
          role: 'user',
          content: [{ text: `Document name: ${sourceName}\n\nDocument content:\n${text.slice(0, 6000)}` }],
        }],
        inferenceConfig: { maxTokens: 300, temperature: 0.2 },
      }),
    )
    const raw = r.output?.message?.content?.map((c) => c.text ?? '').join('') ?? ''
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return undefined
    const parsed = JSON.parse(match[0]) as Partial<HelpMeta>
    if (!parsed.title || !parsed.description) return undefined
    return {
      title: String(parsed.title).slice(0, 80),
      description: String(parsed.description).slice(0, 180),
      category: (HELP_CATEGORIES as readonly string[]).includes(String(parsed.category))
        ? String(parsed.category)
        : 'General',
    }
  } catch (err) {
    // Metadata is an enhancement - publishing must not fail on it.
    console.warn('help meta generation failed', { sourceName, err: String(err) })
    return undefined
  }
}
