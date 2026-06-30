// Handler implementation for the claude-import HttpApi group.
//
// The writer is invoked with the *current* InstanceRef (via InstanceContextMiddleware),
// so imports land under the project the caller currently has opencode open in. This
// matches the shipped cli/cmd/import.ts semantics — the source .jsonl's recorded cwd
// is informational only at this surface (the UI is expected to warn when it differs).

import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { ClaudeDiscovery, ClaudeParser, ClaudeWriter } from "@/import/claude"
import { Project } from "@/project/project"
import { InstanceHttpApi } from "../api"
import { notFound } from "../errors"

export const claudeImportHandlers = HttpApiBuilder.group(InstanceHttpApi, "claude-import", (handlers) =>
  Effect.gen(function* () {
    const project = yield* Project.Service

    const list = Effect.fn("ClaudeImportHttpApi.list")(function* () {
      const rows = yield* Effect.sync(() => ClaudeDiscovery.listSessions())
      // Per-cwd cache so we don't git-resolve the same dir twice in a single request.
      const worktreeCache = new Map<string, string>()
      const enriched = yield* Effect.forEach(
        rows,
        (row) =>
          Effect.gen(function* () {
            let projectWorktree = worktreeCache.get(row.directory)
            if (!projectWorktree) {
              const resolved = yield* project.fromDirectory(row.directory).pipe(
                Effect.map((r) => (r.project.vcs ? r.project.worktree : row.directory)),
                Effect.catch(() => Effect.succeed(row.directory)),
              )
              projectWorktree = resolved
              worktreeCache.set(row.directory, projectWorktree)
            }
            return { ...row, projectWorktree }
          }),
        { concurrency: 8 },
      )
      return enriched
    })

    const importOne = Effect.fn("ClaudeImportHttpApi.import")(function* (ctx: {
      params: { claudeSessionID: string }
    }) {
      const sourcePath = ClaudeDiscovery.findSessionPath(ctx.params.claudeSessionID)
      if (!sourcePath) return yield* notFound(`Claude session not found: ${ctx.params.claudeSessionID}`)

      const parsed = yield* Effect.try({
        try: () => ClaudeParser.parseSessionFile(sourcePath),
        catch: () => new HttpApiError.BadRequest({}),
      })

      const result = yield* ClaudeWriter.importSession(parsed)
      if ("skipped" in result) {
        const out: {
          status: "already-imported"
          opencodeSessionID: string
          lineCount: number
          sourceLineCount: number
        } = {
          status: "already-imported",
          opencodeSessionID: String(result.opencodeSessionID),
          lineCount: result.lineCount as number,
          sourceLineCount: result.sourceLineCount as number,
        }
        return out
      }
      const out: {
        status: "imported"
        opencodeSessionID: string
        title: string
        directory: string
        projectWorktree: string
        importedTurns: number
        skippedToolOnly: number
      } = {
        status: "imported",
        opencodeSessionID: String(result.opencodeSessionID),
        title: result.title,
        directory: result.directory,
        projectWorktree: (result as { projectWorktree: string }).projectWorktree,
        importedTurns: result.importedTurns,
        skippedToolOnly: result.skippedToolOnly,
      }
      return out
    })

    const teardown = Effect.fn("ClaudeImportHttpApi.teardown")(function* (ctx: {
      params: { claudeSessionID: string }
    }) {
      const result = yield* ClaudeWriter.teardownSession(ctx.params.claudeSessionID)
      if (!result.removed && result.reason === "not-in-ledger")
        return yield* notFound(`Not in ledger: ${ctx.params.claudeSessionID}`)
      return result
    })

    return handlers.handle("list", list).handle("import", importOne).handle("teardown", teardown)
  }),
)
