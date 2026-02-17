# Console Sanitizer

A safe, interactive CLI that detects, reports, and removes `console.*` statements from JavaScript and TypeScript projects before shipping.

## Why This Tool Exists

Every team ships with a few stray `console.log`s. This CLI makes cleanup fast, safe, and explicit, without reformatting entire files or relying on brittle regexes.

## Features

- Interactive, guided cleanup flow
- AST-based detection (no regex)
- Environment-aware defaults
- Inline directives: `// @keep` and `// @remove`
- Dry-run by default with explicit confirmation
- Optional backups in `.clearconsole-backup/`
- Works with JS, TS, JSX, TSX

## Install And Run

```bash
npm i console-sanitizer

```

Add a script in your project:

```json
{
  "scripts": {
    "clear": "clear-console"
  }
}
```

Then run:

```bash
npm run clear
```

## Example CLI Flow

- Welcome message
- Project type detection (JS / TS / React / Next / Vite)
- Scope selection (file, folder, project)
- Environment selection (development / production)
- Console types selection
- Dry-run analysis and summary
- Confirmation before changes

## Environment Behavior

- Development
  - Keep `console.log`
  - Remove `console.debug`, `console.info`
- Production
  - Remove `console.log`, `console.debug`, `console.info`
  - Keep `console.warn`, `console.error`

You can always customize the removal list in the prompt or config.

## Inline Directives

- Keep a line:

```ts
console.log("keep this") // @keep
```

- Force remove:

```ts
console.log("remove this") // @remove
```

## Config File (Optional)

Create `clearconsole.config.json` in your project root:

```json
{
  "environment": "production",
  "remove": ["log", "debug", "info"],
  "keep": ["warn", "error"],
  "dryRun": true,
  "respectComments": true,
  "backup": false
}
```

## CLI Flags

- `--ci`: no prompts (use config/defaults)
- `--yes`: auto-confirm changes
- `--prod` / `--dev`: set environment
- `--dry-run`: scan without changes
- `--apply`: apply changes without a dry run
- `--file <path>`: target a single file
- `--dir <path>`: target a folder
- `--all`: target entire project
- `--remove log,debug`: set removal list
- `--keep warn,error`: set keep list
- `--backup`: write `.clearconsole-backup/`
- `--no-respect-comments`: ignore `@keep` and `@remove`

## Safety Features

- Dry-run by default
- Explicit confirmation before modifying files
- Optional backups of changed files
- Ignores `node_modules`, build folders, and `.clearconsole-backup/`

## ESLint / Babel Comparison

- ESLint rules like `no-console` help prevent new logs, but they do not remove existing ones.
- Babel or SWC plugins can remove logs during bundling, but they do not clean the source itself.
- This tool is for fast, explicit cleanup of your project source when you decide to ship.



