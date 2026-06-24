import { createMemo, createResource, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { Spinner } from "./spinner"
import type { ClaudeImportSessionStatus } from "@opencode-ai/sdk/v2/client"

type RowStatus =
  | { kind: "idle" }
  | { kind: "queued" }
  | { kind: "importing" }
  | { kind: "done"; opencodeSessionID?: string }
  | { kind: "error"; message: string }

const num = (v: ClaudeImportSessionStatus["lineCount"]): number => (typeof v === "number" ? v : 0)

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const stripPrefix = (t: string) => t.replace(/^\[claude\]\s*/, "")

type Kind = { kind: "header"; directory: string } | { kind: "row"; row: ClaudeImportSessionStatus }

export function DialogImportClaude() {
  const dialog = useDialog()
  const route = useRoute()
  const sdk = useSDK()
  const toast = useToast()

  // Widen the dialog past the default ~60-col palette; long directory paths + titles
  // are unreadable otherwise. xlarge = 116 cols, the widest preset opencode supports.
  dialog.setSize("xlarge")

  const [status, setStatus] = createStore<Record<string, RowStatus>>({})
  const [expanded, setExpanded] = createStore<Record<string, boolean>>({})

  const [rowsResource] = createResource(async (): Promise<ClaudeImportSessionStatus[]> => {
    const res = await sdk.client.claudeImport.list({})
    const data = res.data ?? []
    const initial: Record<string, RowStatus> = {}
    for (const row of data) {
      initial[row.claudeSessionID] = row.imported
        ? { kind: "done", opencodeSessionID: row.imported.opencodeSessionID }
        : { kind: "queued" }
    }
    setStatus(initial)
    return data
  })

  const rows = createMemo(() => rowsResource() ?? [])

  // Auto-import everything on open.
  onMount(() => {
    void (async () => {
      while (rowsResource.loading) await new Promise((r) => setTimeout(r, 50))
      const queue = rows().filter((r) => !r.imported)
      if (!queue.length) return
      let done = 0
      let failed = 0
      for (const row of queue) {
        setStatus(row.claudeSessionID, { kind: "importing" })
        try {
          const res = await sdk.client.claudeImport.import({ claudeSessionID: row.claudeSessionID })
          if (!res.data) throw new Error("empty response from import")
          setStatus(row.claudeSessionID, { kind: "done", opencodeSessionID: res.data.opencodeSessionID })
          done++
        } catch (err) {
          const message = errorMessage(err)
          setStatus(row.claudeSessionID, { kind: "error", message })
          failed++
        }
      }
      if (failed) toast.error(`Imported ${done} · ${failed} failed`)
      else if (done) toast.show?.({ message: `Imported ${done} session${done === 1 ? "" : "s"}`, variant: "info" })
    })()
  })

  // Group by directory, sorted.
  const groups = createMemo(() => {
    const map = new Map<string, ClaudeImportSessionStatus[]>()
    for (const r of rows()) {
      const list = map.get(r.directory) ?? []
      list.push(r)
      map.set(r.directory, list)
    }
    return Array.from(map.entries())
      .map(([directory, items]) => ({ directory, items }))
      .sort((a, b) => a.directory.localeCompare(b.directory))
  })

  function groupSummary(items: ClaudeImportSessionStatus[]): string {
    let done = 0,
      importing = 0,
      queued = 0,
      error = 0
    for (const r of items) {
      const s = status[r.claudeSessionID]
      if (s?.kind === "done") done++
      else if (s?.kind === "importing") importing++
      else if (s?.kind === "queued") queued++
      else if (s?.kind === "error") error++
    }
    const total = items.length
    if (importing > 0 || queued > 0) return `importing ${done + importing} of ${total}…`
    if (error > 0 && error === total) return `${error} failed`
    if (error > 0) return `${done} imported · ${error} failed`
    if (done === total) return `✓ ${done} imported`
    return `${done} of ${total} imported`
  }

  function rowBadge(s: RowStatus | undefined): string {
    if (!s || s.kind === "idle") return ""
    if (s.kind === "queued") return "queued"
    if (s.kind === "importing") return "importing…"
    if (s.kind === "done") return "✓"
    return `✗ ${s.message}`
  }

  // Build the flat option list: project headers, with their child rows interleaved when expanded.
  const options = createMemo(() => {
    const out: Array<{
      title: string
      value: Kind
      description?: string
      footer?: string
      onSelect: () => void
    }> = []

    for (const g of groups()) {
      const isOpen = !!expanded[g.directory]
      out.push({
        title: `${isOpen ? "▼" : "▶"} ${g.directory}`,
        value: { kind: "header", directory: g.directory },
        description: `${g.items.length} session${g.items.length === 1 ? "" : "s"}`,
        footer: groupSummary(g.items),
        onSelect: () => setExpanded(g.directory, !isOpen),
      })
      if (!isOpen) continue
      for (const row of g.items) {
        const s = status[row.claudeSessionID]
        const navigable = s?.kind === "done" && s.opencodeSessionID
        out.push({
          title: `    ${stripPrefix(row.title)}`,
          value: { kind: "row", row },
          description: `${num(row.lineCount)} lines · ${relativeTime(num(row.mtime))}`,
          footer: rowBadge(s),
          onSelect: navigable
            ? () => {
                dialog.clear()
                route.navigate({ type: "session", sessionID: s!.opencodeSessionID! })
              }
            : () => {},
        })
      }
    }
    return out
  })

  return (
    <DialogSelect
      title="Import Claude Code sessions"
      placeholder="Search by directory or title…"
      options={options()}
      emptyView={rowsResource.loading ? <Spinner /> : undefined}
    />
  )
}
