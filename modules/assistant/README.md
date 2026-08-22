# Module: Assistant

RAG chatbot an SMB trains on its own documents. Delivery surfaces: dashboard
playground, embeddable widget, hosted chat page, REST API. See SPEC.md §4.

```
api/   Lambda handlers: sources/ingestion, chat (streaming), config, conversations
web/   Dashboard screens: Knowledge, Behavior, Playground, Deploy, Conversations, Insights, Usage
```

Routes are namespaced under `/v1/assistant/*`. Usage metrics emitted:
`assistant.message`, `assistant.tokens`, `assistant.ingest.pages`.
