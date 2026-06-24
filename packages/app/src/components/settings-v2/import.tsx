import { Component } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

export const SettingsImport: Component = () => {
  const dialog = useDialog()

  const openClaudeImport = () => {
    void import("@/components/dialog-import-claude").then((x) => {
      dialog.show(() => <x.DialogImportClaude />)
    })
  }

  return (
    <SettingsListV2>
      <SettingsRowV2
        title="Claude Code"
        description="Import conversation history from ~/.claude/projects. Each session is filed under the opencode project for its recorded working directory."
      >
        <ButtonV2 variant="neutral" onClick={openClaudeImport}>
          Import Claude sessions…
        </ButtonV2>
      </SettingsRowV2>
    </SettingsListV2>
  )
}
