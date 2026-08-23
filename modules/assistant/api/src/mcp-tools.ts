import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { emitUsage, getEffectiveEntitlement, getMonthUsage, ulid } from '@makerbay/core'
import { getConfig, getSessionMessages, listSources, putMessage, putSource, updateSourceStatus } from './db'
import { generateAnswer, retrieveChunks, startIngestion } from './rag'

/**
 * The assistant module's MCP tools. Agents reach the same knowledge, limits
 * and metering as the dashboard and widget — an agent asking a question is
 * billed exactly like a customer asking one.
 */

const s3 = new S3Client({})
const BUCKET = () => process.env.KNOWLEDGE_BUCKET!

export interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  /** Write tools are refused for read-only callers. */
  write?: boolean
  run: (tenantId: string, args: Record<string, any>) => Promise<string>
}

const text = (s: string) => s

export const assistantTools: McpTool[] = [
  {
    name: 'ask_assistant',
    title: 'Ask the business assistant',
    description:
      'Ask a question and get an answer grounded in this workspace\'s own documents, with the sources used. Returns the configured fallback message when the documents do not cover the question — it never invents an answer. Counts as one assistant message against the plan.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask, in plain language.' },
        sessionId: {
          type: 'string',
          description: 'Optional. Pass the sessionId from a previous call to ask a follow-up in the same conversation.',
        },
      },
      required: ['question'],
    },
    async run(tenantId, args) {
      const question = String(args.question ?? '').trim()
      if (!question) throw new Error('question is required')

      const entitlement = await getEffectiveEntitlement(tenantId, 'assistant')
      const limit = entitlement.limits.messagesPerMonth ?? 200
      const used = (await getMonthUsage(tenantId, new Date().toISOString().slice(0, 7)))['assistant.message'] ?? 0
      if (used >= limit) throw new Error(`Monthly message limit reached (${used}/${limit}).`)

      const sessionId = /^[A-Z0-9]{10,32}$/.test(String(args.sessionId ?? '')) ? String(args.sessionId) : ulid()
      const config = await getConfig(tenantId)
      const history = await getSessionMessages(tenantId, sessionId, 10)
      const chunks = await retrieveChunks(tenantId, question)

      let answer = config.fallbackMessage
      let fallback = true
      let tokens = 0
      if (chunks.length > 0) {
        const generated = await generateAnswer(config, chunks, history, question)
        answer = generated.text
        fallback = generated.fallback
        tokens = generated.inputTokens + generated.outputTokens
      }

      const sources = fallback
        ? []
        : [...new Set(chunks.map((c) => c.sourceName))]

      const now = new Date().toISOString()
      const common = { pk: `${tenantId}#${sessionId}`, tenantId, sessionId }
      await putMessage({ ...common, sk: `${now}#0${ulid()}`, role: 'user', text: question })
      await putMessage({
        ...common,
        sk: `${now}#${ulid()}`,
        role: 'assistant',
        text: answer,
        fallback,
        citations: sources.map((name) => ({ sourceId: '', name, excerpt: '' })),
      })

      await emitUsage({ tenantId, moduleId: 'assistant', metric: 'message', quantity: 1 })
      if (tokens > 0) await emitUsage({ tenantId, moduleId: 'assistant', metric: 'tokens', quantity: tokens })

      return text(
        [
          answer,
          sources.length ? `\nSources: ${sources.join(', ')}` : '',
          fallback ? '\n(This question is not covered by the workspace documents.)' : '',
          `\nsessionId: ${sessionId} — pass this back to ask a follow-up.`,
        ]
          .filter(Boolean)
          .join('\n'),
      )
    },
  },

  {
    name: 'search_knowledge',
    title: 'Search the knowledge base',
    description:
      'Retrieve raw passages from this workspace\'s documents without generating an answer. Cheaper and faster than ask_assistant, and useful when you want the source material to reason over yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
      },
      required: ['query'],
    },
    async run(tenantId, args) {
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('query is required')
      const chunks = await retrieveChunks(tenantId, query)
      if (chunks.length === 0) return text('No matching passages in this workspace.')
      await emitUsage({ tenantId, moduleId: 'assistant', metric: 'search', quantity: 1 })
      return text(
        chunks
          .map((c, i) => `[${i + 1}] ${c.sourceName} (score ${c.score.toFixed(3)})\n${c.text}`)
          .join('\n\n'),
      )
    },
  },

  {
    name: 'list_knowledge_sources',
    title: 'List knowledge sources',
    description:
      'List the documents this workspace has given the assistant, with their processing status. Use it to check whether something you added is ready to be answered from.',
    inputSchema: { type: 'object', properties: {} },
    async run(tenantId) {
      const sources = await listSources(tenantId)
      if (sources.length === 0) return text('This workspace has no knowledge sources yet.')
      return text(
        sources
          .map((s) => `- ${s.name} — ${s.status}${s.sizeBytes ? ` (${s.sizeBytes} bytes)` : ''}`)
          .join('\n'),
      )
    },
  },

  {
    name: 'add_knowledge',
    title: 'Add knowledge',
    description:
      'Add a note to this workspace\'s knowledge so the assistant can answer from it in future. Use it to record an answer the assistant did not know. Processing takes a minute or two before the content is answerable.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short name for this note, e.g. "Refund policy".' },
        content: { type: 'string', description: 'The text to add. Write it as you would want a customer to read it.' },
      },
      required: ['title', 'content'],
    },
    async run(tenantId, args) {
      const title = String(args.title ?? '').trim().slice(0, 120)
      const content = String(args.content ?? '').trim()
      if (!title || !content) throw new Error('title and content are required')
      if (content.length > 500_000) throw new Error('content is too large')

      const entitlement = await getEffectiveEntitlement(tenantId, 'assistant')
      const existing = await listSources(tenantId)
      const maxSources = entitlement.limits.sources ?? 20
      if (existing.length >= maxSources) throw new Error(`Source limit reached (${existing.length}/${maxSources}).`)

      const sourceId = ulid()
      const safe = title.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'note'
      const key = `knowledge/${tenantId}/${sourceId}/${safe}`
      const now = new Date().toISOString()

      await s3.send(new PutObjectCommand({ Bucket: BUCKET(), Key: key, Body: content, ContentType: 'text/plain' }))
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET(),
          Key: `${key}.metadata.json`,
          Body: JSON.stringify({ metadataAttributes: { tenantId, sourceId, sourceName: title } }),
          ContentType: 'application/json',
        }),
      )
      await putSource({
        tenantId, sourceId, name: title, type: 'text', s3Key: key,
        status: 'processing', sizeBytes: content.length, createdAt: now, updatedAt: now,
      })
      try {
        const jobId = await startIngestion()
        await updateSourceStatus(tenantId, sourceId, 'processing', jobId)
      } catch {
        // Another ingestion job is already running; it will pick this up.
      }
      await emitUsage({ tenantId, moduleId: 'assistant', metric: 'ingest.documents', quantity: 1 })
      return text(`Added "${title}" to the knowledge base. It will be answerable once processing finishes.`)
    },
  },
]
