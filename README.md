# Mentalogue VS Code Extension

This extension adds:

- Mentalogue syntax highlighting for `.mtl` and `.mlib`
- IntelliSense (keyword + symbol completion, hover, and go-to-definition)
- Background diagnostics by running `inscribe check` on the active `.mtl` file
- Optional `Suture Pull` command for workspace packages

## Requirements

- `inscribe` installed and available on `PATH`, or set `mentalogue.inscribePath`
- Optional: `suture` installed for package pull command

## Features

- Symbol indexing includes:
  - Workspace `.mtl` files
  - `.suture/sources/**/*.mtl`
  - `.mlib` files (enabled by default with `mentalogue.indexMlib`)
- Frequent checks:
  - Periodic checks (`mentalogue.enablePeriodicCheck`, `mentalogue.checkIntervalMs`)
  - Check on save (`mentalogue.checkOnSave`)
  - Unsaved buffer snapshots while typing (`mentalogue.checkUnsavedChanges`)

## Commands

- `Mentalogue: Refresh IntelliSense Index`
- `Mentalogue: Run Inscribe Check`
- `Mentalogue: Suture Pull In Workspace`