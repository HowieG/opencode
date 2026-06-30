import { Component, createMemo, createResource, createSignal, For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog } from "@opencode-ai/ui/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useServerSDK } from "@/context/server-sdk"
import { useServer } from "@/context/server"
import { showToast } from "@/utils/toast"
import type { ClaudeImportSessionStatus } from "@opencode-ai/sdk/v2/client"

/** Per-row status. Initially "idle" for imported, "queued" for new, then progresses. */
type RowStatus =
  | { kind: "idle" }
  | { kind: "queued" }
  | { kind: "importing" }
  | { kind: "done" }
  | { kind: "error"; message: string }

/** SDK quirk: numeric fields can come through as NaN/Infinity sentinels. Treat as 0. */
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

/** Strip the "[claude] " prefix used in the title. */
const stripPrefix = (t: string) => t.replace(/^\[claude\]\s*/, "")

type Group = {
  directory: string
  rows: ClaudeImportSessionStatus[]
}

function groupByProject(rows: ClaudeImportSessionStatus[]): Group[] {
  const map = new Map<string, ClaudeImportSessionStatus[]>()
  for (const row of rows) {
    const key = row.projectWorktree ?? row.directory
    const list = map.get(key) ?? []
    list.push(row)
    map.set(key, list)
  }
  return Array.from(map.entries())
    .map(([directory, rows]) => ({ directory, rows }))
    .sort((a, b) => a.directory.localeCompare(b.directory))
}

export const DialogImportClaude: Component = () => {
  const serverSDK = useServerSDK()
  const server = useServer()
  const dialog = useDialog()

  const [status, setStatus] = createStore<Record<string, RowStatus>>({})
  const [expanded, setExpanded] = createStore<Record<string, boolean>>({})

  const [rowsResource] = createResource(async (): Promise<ClaudeImportSessionStatus[]> => {
    const res = await serverSDK().client.claudeImport.list({})
    const data = res.data ?? []
    const initial: Record<string, RowStatus> = {}
    for (const row of data) initial[row.claudeSessionID] = row.imported ? { kind: "done" } : { kind: "queued" }
    setStatus(initial)
    return data
  })

  const rows = createMemo(() => rowsResource() ?? [])
  const groups = createMemo(() => groupByProject(rows()))

  // Auto-run imports on mount once the row list is loaded.
  onMount(() => {
    void (async () => {
      // wait for the first non-loading resource value
      while (rowsResource.loading) await new Promise((r) => setTimeout(r, 50))
      const queue = rows().filter((r) => !r.imported)
      // Each session's *project worktree* (post-git-resolution) is what the sidebar opens.
      // For already-imported rows we don't have it from the list endpoint, so we approximate
      // by using row.directory — fine for non-git cwds (the writer files them per-cwd anyway).
      const worktreesToRegister = new Set<string>()
      for (const r of rows()) if (r.imported) worktreesToRegister.add(r.directory)
      if (!queue.length) {
        worktreesToRegister.forEach((dir) => server.projects.open(dir))
        return
      }
      let done = 0
      let failed = 0
      for (const row of queue) {
        setStatus(row.claudeSessionID, { kind: "importing" })
        try {
          const res = await serverSDK().client.claudeImport.import({ claudeSessionID: row.claudeSessionID })
          const result = res.data
          if (!result) throw new Error("empty response from import")
          setStatus(row.claudeSessionID, { kind: "done" })
          // Use the resolved project worktree from the import response (git-collapsed when applicable).
          if (result.status === "imported") worktreesToRegister.add(result.projectWorktree)
          else worktreesToRegister.add(row.directory) // already-imported fallback
          done++
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setStatus(row.claudeSessionID, { kind: "error", message })
          failed++
        }
      }
      worktreesToRegister.forEach((dir) => server.projects.open(dir))
      if (failed) showToast({ title: `Imported ${done} · ${failed} failed` })
      else if (done) showToast({ title: `Imported ${done} session${done === 1 ? "" : "s"}` })
    })()
  })

  // Aggregates
  const totals = createMemo(() => {
    const list = rows()
    let done = 0,
      importing = 0,
      queued = 0,
      error = 0
    for (const r of list) {
      const s = status[r.claudeSessionID]
      if (s?.kind === "done") done++
      else if (s?.kind === "importing") importing++
      else if (s?.kind === "queued") queued++
      else if (s?.kind === "error") error++
    }
    return { total: list.length, done, importing, queued, error }
  })

  function groupSummary(g: Group): { label: string; tone: "idle" | "running" | "done" | "error" } {
    let done = 0,
      importing = 0,
      queued = 0,
      error = 0
    for (const r of g.rows) {
      const s = status[r.claudeSessionID]
      if (s?.kind === "done") done++
      else if (s?.kind === "importing") importing++
      else if (s?.kind === "queued") queued++
      else if (s?.kind === "error") error++
    }
    const total = g.rows.length
    if (error > 0 && error === total) return { label: `${error} failed`, tone: "error" }
    if (importing > 0 || queued > 0) {
      const progress = done + importing
      return { label: `importing ${progress} of ${total}…`, tone: "running" }
    }
    if (error > 0) return { label: `${done} imported · ${error} failed`, tone: "error" }
    if (done === total) return { label: `✓ ${done} imported`, tone: "done" }
    return { label: `${done} of ${total} imported`, tone: "idle" }
  }

  function rowBadge(s: RowStatus | undefined): { label: string; tone: "running" | "done" | "error" | "queued" } {
    if (!s || s.kind === "idle") return { label: "•", tone: "queued" }
    if (s.kind === "queued") return { label: "queued", tone: "queued" }
    if (s.kind === "importing") return { label: "importing…", tone: "running" }
    if (s.kind === "done") return { label: "✓", tone: "done" }
    return { label: `✗ ${s.message}`, tone: "error" }
  }

  const toneColor = (tone: "idle" | "running" | "done" | "error" | "queued") =>
    tone === "done"
      ? "var(--ui-green, #10b981)"
      : tone === "error"
        ? "var(--ui-red, #ef4444)"
        : tone === "running"
          ? "var(--ui-text)"
          : "var(--ui-text-weak)"

  return (
    <Dialog title="Import Claude Code sessions" size="large">
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          gap: "8px",
          padding: "0 12px",
          "min-height": "0",
          flex: 1,
        }}
      >
        <Show when={!rowsResource.loading} fallback={<div style={{ padding: "16px", color: "var(--ui-text-weak)" }}>Scanning ~/.claude/projects…</div>}>
          <Show
            when={rows().length > 0}
            fallback={
              <div style={{ padding: "16px", color: "var(--ui-text-weak)" }}>
                No Claude sessions found in ~/.claude/projects.
              </div>
            }
          >
            <div
              style={{
                flex: 1,
                "min-height": "0",
                "overflow-y": "auto",
                border: "1px solid var(--ui-border, #e5e7eb)",
                "border-radius": "8px",
              }}
            >
              <For each={groups()}>
                {(g) => {
                  const isOpen = () => !!expanded[g.directory]
                  const toggle = () => setExpanded(g.directory, !isOpen())
                  const summary = createMemo(() => groupSummary(g))
                  return (
                    <div>
                      <div
                        onClick={toggle}
                        style={{
                          display: "flex",
                          "align-items": "center",
                          gap: "8px",
                          padding: "10px 12px",
                          "border-bottom": "1px solid var(--ui-border, #e5e7eb)",
                          cursor: "pointer",
                          "background-color": isOpen() ? "var(--ui-background-weak, transparent)" : "transparent",
                        }}
                      >
                        <span style={{ width: "16px", display: "inline-flex", "align-items": "center", color: "var(--ui-text-weak)" }}>
                          <Icon name={isOpen() ? "chevron-down" : "chevron-right"} />
                        </span>
                        <span style={{ flex: 1, "overflow-wrap": "anywhere", "font-weight": 500 }}>{g.directory}</span>
                        <span style={{ "font-size": "12px", color: toneColor(summary().tone), "white-space": "nowrap" }}>
                          {summary().label}
                        </span>
                      </div>
                      <Show when={isOpen()}>
                        <div style={{ "background-color": "var(--ui-background-weak, rgba(0,0,0,0.02))" }}>
                          <For each={g.rows}>
                            {(row) => {
                              const badge = createMemo(() => rowBadge(status[row.claudeSessionID]))
                              // Only surface the raw cwd inside the row when it differs from the group's
                              // resolved project worktree — i.e. for git worktrees or monorepo subdirs.
                              const cwdSuffix = row.directory !== g.directory ? ` · ${row.directory}` : ""
                              return (
                                <div
                                  style={{
                                    display: "flex",
                                    "align-items": "flex-start",
                                    gap: "12px",
                                    padding: "8px 12px 8px 36px",
                                    "border-bottom": "1px solid var(--ui-border, #e5e7eb)",
                                  }}
                                >
                                  <div style={{ flex: 1, "min-width": 0 }}>
                                    <div style={{ "font-size": "13px", "overflow-wrap": "anywhere" }}>{stripPrefix(row.title)}</div>
                                    <div
                                      style={{
                                        "font-size": "11px",
                                        color: "var(--ui-text-weak)",
                                        "margin-top": "2px",
                                        "overflow-wrap": "anywhere",
                                      }}
                                    >
                                      {num(row.lineCount)} lines · {relativeTime(num(row.mtime))}{cwdSuffix}
                                    </div>
                                  </div>
                                  <span
                                    style={{
                                      "font-size": "12px",
                                      color: toneColor(badge().tone),
                                      "white-space": "nowrap",
                                    }}
                                  >
                                    {badge().label}
                                  </span>
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </Show>

        <div
          style={{
            display: "flex",
            "justify-content": "space-between",
            "align-items": "center",
            padding: "8px 0 12px",
          }}
        >
          <span style={{ color: "var(--ui-text-weak)", "font-size": "12px" }}>
            <Show when={!rowsResource.loading}>
              {totals().done} of {totals().total} imported
              <Show when={totals().importing + totals().queued > 0}>
                {" "}· {totals().importing + totals().queued} pending
              </Show>
              <Show when={totals().error > 0}> · {totals().error} failed</Show>
            </Show>
          </span>
          <ButtonV2 variant="contrast" onClick={() => dialog.close()}>
            Close
          </ButtonV2>
        </div>
      </div>
    </Dialog>
  )
}
