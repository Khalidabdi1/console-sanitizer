#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import { performance } from "perf_hooks";
import { Command } from "commander";
import fg from "fast-glob";
import MagicString from "magic-string";
import pc from "picocolors";
import prompts from "prompts";
import { parse } from "@swc/core";
import Visitor from "@swc/core/Visitor";

const PACKAGE_NAME = "clear-console";
const BRAND_NAME = "Console Sanitizer";

type ConsoleType = "log" | "debug" | "info" | "warn" | "error";

type Environment = "development" | "production";

type Directive = "keep" | "remove" | null;

interface ConfigFile {
  environment?: Environment;
  remove?: ConsoleType[];
  keep?: ConsoleType[];
  dryRun?: boolean;
  respectComments?: boolean;
  backup?: boolean;
}

interface CliOptions {
  ci: boolean;
  yes: boolean;
  prod: boolean;
  dev: boolean;
  dryRun?: boolean;
  apply?: boolean;
  file?: string;
  dir?: string;
  all?: boolean;
  remove?: string;
  keep?: string;
  backup?: boolean;
  respectComments?: boolean;
  config?: string;
}

interface ScanHit {
  type: ConsoleType;
  span: { lo: number; hi: number };
  directive: Directive;
  shouldRemove: boolean;
}

interface FileScanResult {
  filePath: string;
  counts: Record<ConsoleType, number>;
  removableCounts: Record<ConsoleType, number>;
  hits: ScanHit[];
}

const ALL_TYPES: ConsoleType[] = ["log", "debug", "info", "warn", "error"];

const EXTENSIONS = [".js", ".jsx", ".ts", ".tsx"];

const DEFAULT_IGNORES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.git/**",
  "**/.clearconsole-backup/**",
  "**/coverage/**",
  "**/out/**"
];

class ConsoleScanVisitor extends Visitor {
  private readonly removeSet: Set<ConsoleType>;
  private readonly respectComments: boolean;
  private readonly source: string;
  private readonly lineStarts: number[];
  public readonly hits: ScanHit[] = [];
  public readonly counts: Record<ConsoleType, number> = initCounts();
  public readonly removableCounts: Record<ConsoleType, number> = initCounts();

  constructor(source: string, removeSet: Set<ConsoleType>, respectComments: boolean) {
    super();
    this.source = source;
    this.removeSet = removeSet;
    this.respectComments = respectComments;
    this.lineStarts = buildLineStarts(source);
  }

  visitTsType(n: any): any {
    return n;
  }

  visitExpressionStatement(statement: any): any {
    const method = getConsoleMethod(statement.expression);
    if (method) {
      const directive = this.respectComments ? findInlineDirective(this.source, this.lineStarts, statement.span) : null;
      const shouldRemove = shouldRemoveConsole(method, directive, this.removeSet);

      this.counts[method] += 1;
      if (shouldRemove) {
        this.removableCounts[method] += 1;
      }

      this.hits.push({
        type: method,
        span: { lo: statement.span.lo, hi: statement.span.hi },
        directive,
        shouldRemove
      });
    }

    return super.visitExpressionStatement(statement);
  }
}

async function run(): Promise<void> {
  const program = new Command();

  program
    .name(PACKAGE_NAME)
    .description("Detect, report, and remove console.* statements from JS/TS projects")
    .option("--ci", "Run without prompts (use defaults/config)")
    .option("-y, --yes", "Auto-confirm changes")
    .option("--prod", "Production mode")
    .option("--dev", "Development mode")
    .option("--dry-run", "Scan without modifying files")
    .option("--apply", "Apply changes (override dry run)")
    .option("--file <path>", "Target a single file")
    .option("--dir <path>", "Target a directory")
    .option("--all", "Target the entire project")
    .option("--remove <types>", "Comma-separated console types to remove")
    .option("--keep <types>", "Comma-separated console types to keep")
    .option("--backup", "Create .clearconsole-backup before writing")
    .option("--no-respect-comments", "Ignore @keep/@remove inline comments")
    .option("--config <path>", "Path to a clearconsole.config.json file")
    .parse(process.argv);

  const options = program.opts<CliOptions>();
  const cwd = process.cwd();

  if (options.prod && options.dev) {
    console.error(pc.red("Error: Choose only one of --prod or --dev."));
    process.exit(1);
  }

  const config = await loadConfig(cwd, options.config);
  const configEnvironment = normalizeEnvironment(config.environment);
  const configRemove = normalizeConsoleArray(config.remove);
  const configKeep = normalizeConsoleArray(config.keep);

  const welcome = `${pc.bold(pc.cyan(BRAND_NAME))} — Safe console cleanup for JS/TS projects`;
  console.log(welcome);

  const projectType = await detectProjectType(cwd);
  if (projectType) {
    console.log(`${pc.dim("Detected project:")} ${projectType}`);
  }

  let environment: Environment | undefined = options.prod ? "production" : options.dev ? "development" : configEnvironment;

  let dryRun: boolean = typeof options.dryRun === "boolean" ? options.dryRun : config.dryRun ?? true;
  if (options.apply) {
    dryRun = false;
  }

  let respectComments: boolean = typeof options.respectComments === "boolean" ? options.respectComments : config.respectComments ?? true;
  const backup: boolean = options.backup ?? config.backup ?? false;

  const allFiles = await getAllCandidateFiles(cwd);
  if (allFiles.length === 0) {
    console.log(pc.yellow("No eligible JS/TS files found."));
    return;
  }

  let scope: "file" | "folder" | "project" | undefined;
  let selectedFile: string | undefined;
  let selectedFolder: string | undefined;

  if (options.file) {
    scope = "file";
    selectedFile = path.resolve(cwd, options.file);
  } else if (options.dir) {
    scope = "folder";
    selectedFolder = path.resolve(cwd, options.dir);
  } else if (options.all) {
    scope = "project";
  }

  if (!options.ci && !scope) {
    scope = await promptScope();
  }

  if (!scope) {
    scope = "project";
  }

  if (!options.ci && scope === "file" && !selectedFile) {
    const choice = await promptFileSelection(allFiles, cwd);
    selectedFile = path.resolve(cwd, choice);
  }

  if (!options.ci && scope === "folder" && !selectedFolder) {
    const choice = await promptFolderSelection(allFiles, cwd);
    selectedFolder = path.resolve(cwd, choice);
  }

  if (scope === "file" && selectedFile && !(await fileExists(selectedFile))) {
    console.log(pc.red(`File not found: ${selectedFile}`));
    return;
  }
  if (scope === "folder" && selectedFolder && !(await fileExists(selectedFolder))) {
    console.log(pc.red(`Folder not found: ${selectedFolder}`));
    return;
  }

  const scopedFiles = filterFilesByScope(allFiles, scope, selectedFile, selectedFolder);
  if (scopedFiles.length === 0) {
    console.log(pc.yellow("No files matched the selected scope."));
    return;
  }

  if (!environment && !options.ci) {
    environment = await promptEnvironment();
  }
  if (!environment) {
    environment = "production";
  }

  const defaultRemove: ConsoleType[] = environment === "production" ? ["log", "debug", "info"] : ["debug", "info"];

  const removeList = parseConsoleList(options.remove) ?? configRemove ?? defaultRemove;
  const keepList = parseConsoleList(options.keep) ?? configKeep ?? ALL_TYPES.filter((t) => !removeList.includes(t));

  const removeSet = new Set<ConsoleType>(removeList);
  for (const type of keepList) {
    if (removeSet.has(type)) {
      removeSet.delete(type);
    }
  }

  let finalRemoveSet = removeSet;

  if (!options.ci) {
    const removeSelection = await promptRemoveSelection(finalRemoveSet);
    finalRemoveSet = new Set<ConsoleType>(removeSelection);
  }

  console.log(pc.dim("\nScanning files..."));
  const scanResults = await scanFiles(scopedFiles, finalRemoveSet, respectComments);

  const totalCounts = sumCounts(scanResults.map((r) => r.counts));
  const removableTotals = sumCounts(scanResults.map((r) => r.removableCounts));

  const totalFound = sumCountValues(totalCounts);
  if (totalFound === 0) {
    console.log(pc.green("No console statements found."));
    return;
  }

  printScanReport(scanResults, totalCounts, removableTotals);

  const totalRemovable = sumCountValues(removableTotals);
  if (totalRemovable === 0) {
    console.log(pc.green("No console statements match the current removal rules."));
    return;
  }

  let proceed = !dryRun;
  if (!options.ci && !options.yes) {
    proceed = await promptProceed();
  } else if (options.yes) {
    proceed = true;
  }

  if (!proceed) {
    console.log(pc.yellow("No changes were made."));
    return;
  }

  const start = performance.now();
  const executionResults = await applyRemovals(scanResults, finalRemoveSet, respectComments, backup, cwd);
  const duration = Math.round(performance.now() - start);

  printFinalReport(executionResults, duration);
}

function initCounts(): Record<ConsoleType, number> {
  return {
    log: 0,
    debug: 0,
    info: 0,
    warn: 0,
    error: 0
  };
}

async function loadConfig(cwd: string, configPath?: string): Promise<ConfigFile> {
  const resolvedPath = configPath ? path.resolve(cwd, configPath) : path.join(cwd, "clearconsole.config.json");
  try {
    const content = await fs.readFile(resolvedPath, "utf8");
    const parsed = JSON.parse(content) as ConfigFile;
    return parsed ?? {};
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return {};
    }
    console.log(pc.yellow(`Warning: Failed to read config file (${resolvedPath}). Using defaults.`));
    return {};
  }
}

async function detectProjectType(cwd: string): Promise<string | null> {
  const tsconfig = await fileExists(path.join(cwd, "tsconfig.json"));
  const packageJsonPath = path.join(cwd, "package.json");

  let deps: Record<string, string> = {};
  if (await fileExists(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    } catch {
      deps = {};
    }
  }

  const tags: string[] = [];
  if (deps.react) tags.push("React");
  if (deps.next) tags.push("Next.js");
  if (deps.vite) tags.push("Vite");
  if (tsconfig) tags.push("TypeScript");
  if (tags.length === 0) {
    return "JavaScript";
  }
  return tags.join(" + ");
}

async function getAllCandidateFiles(cwd: string): Promise<string[]> {
  const patterns = EXTENSIONS.map((ext) => `**/*${ext}`);
  const files = await fg(patterns, {
    cwd,
    absolute: true,
    onlyFiles: true,
    ignore: DEFAULT_IGNORES,
    dot: false
  });

  return files.sort((a, b) => a.localeCompare(b));
}

function filterFilesByScope(
  files: string[],
  scope: "file" | "folder" | "project",
  selectedFile?: string,
  selectedFolder?: string
): string[] {
  if (scope === "project") {
    return files;
  }
  if (scope === "file") {
    if (!selectedFile) return [];
    return files.filter((file) => path.resolve(file) === path.resolve(selectedFile));
  }
  if (scope === "folder") {
    if (!selectedFolder) return [];
    return files.filter((file) => isWithinFolder(file, selectedFolder));
  }
  return files;
}

function isWithinFolder(filePath: string, folderPath: string): boolean {
  const relative = path.relative(folderPath, filePath);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parseConsoleList(value?: string): ConsoleType[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => ALL_TYPES.includes(item as ConsoleType)) as ConsoleType[];
  return items.length > 0 ? items : undefined;
}

function normalizeConsoleArray(value?: unknown): ConsoleType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item) => ALL_TYPES.includes(item as ConsoleType)) as ConsoleType[];
  return items.length > 0 ? items : undefined;
}

function normalizeEnvironment(value?: string): Environment | undefined {
  if (value === "development" || value === "production") return value;
  return undefined;
}

async function promptScope(): Promise<"file" | "folder" | "project"> {
  const response = await prompts({
    type: "select",
    name: "scope",
    message: "How would you like to clean console statements?",
    choices: [
      { title: "A single file", value: "file" },
      { title: "A specific folder", value: "folder" },
      { title: "The entire project", value: "project" }
    ],
    initial: 2
  });

  return response.scope;
}

async function promptFileSelection(files: string[], cwd: string): Promise<string> {
  const choices = files.map((file) => ({
    title: path.relative(cwd, file),
    value: path.relative(cwd, file)
  }));

  const response = await prompts({
    type: "select",
    name: "file",
    message: "Select the file to clean:",
    choices
  });

  return response.file;
}

async function promptFolderSelection(files: string[], cwd: string): Promise<string> {
  const directories = Array.from(
    new Set(
      files.map((file) => {
        const relative = path.relative(cwd, file);
        return path.dirname(relative);
      })
    )
  )
    .filter((dir) => dir && dir !== ".")
    .sort((a, b) => a.localeCompare(b));

  const choices = directories.map((dir) => ({ title: dir, value: dir }));

  if (choices.length === 0) {
    return ".";
  }

  const response = await prompts({
    type: "select",
    name: "folder",
    message: "Select the folder to clean:",
    choices
  });

  return response.folder ?? ".";
}

async function promptEnvironment(): Promise<Environment> {
  const response = await prompts({
    type: "select",
    name: "environment",
    message: "Which environment is this cleanup for?",
    choices: [
      { title: "Development", value: "development" },
      { title: "Production", value: "production" }
    ],
    initial: 1
  });

  return response.environment;
}

async function promptRemoveSelection(defaultRemoveSet: Set<ConsoleType>): Promise<ConsoleType[]> {
  const response = await prompts({
    type: "multiselect",
    name: "remove",
    message: "Select console types to remove:",
    choices: ALL_TYPES.map((type) => ({
      title: type,
      value: type,
      selected: defaultRemoveSet.has(type)
    }))
  });

  return response.remove ?? [];
}

async function promptProceed(): Promise<boolean> {
  const response = await prompts({
    type: "confirm",
    name: "proceed",
    message: "Do you want to proceed with removing these console statements?",
    initial: false
  });

  return response.proceed ?? false;
}

async function scanFiles(files: string[], removeSet: Set<ConsoleType>, respectComments: boolean): Promise<FileScanResult[]> {
  const results: FileScanResult[] = [];

  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8");
    let ast: any;
    try {
      ast = await parse(content, buildParseOptions(filePath));
    } catch (error) {
      console.log(pc.yellow(`Skipping ${path.relative(process.cwd(), filePath)} (parse error).`));
      continue;
    }
    const visitor = new ConsoleScanVisitor(content, removeSet, respectComments);
    visitor.visitProgram(ast as any);

    results.push({
      filePath,
      counts: visitor.counts,
      removableCounts: visitor.removableCounts,
      hits: visitor.hits
    });
  }

  return results;
}

async function applyRemovals(
  scanResults: FileScanResult[],
  removeSet: Set<ConsoleType>,
  respectComments: boolean,
  backup: boolean,
  cwd: string
): Promise<{ removed: Record<ConsoleType, number>; kept: Record<ConsoleType, number>; filesChanged: number }> {
  const removedTotals = initCounts();
  const keptTotals = initCounts();
  let filesChanged = 0;

  for (const result of scanResults) {
    const filePath = result.filePath;
    const content = await fs.readFile(filePath, "utf8");
    let ast: any;
    try {
      ast = await parse(content, buildParseOptions(filePath));
    } catch (error) {
      console.log(pc.yellow(`Skipping ${path.relative(process.cwd(), filePath)} (parse error).`));
      continue;
    }
    const visitor = new ConsoleScanVisitor(content, removeSet, respectComments);
    visitor.visitProgram(ast as any);

    const ranges = visitor.hits.filter((hit) => hit.shouldRemove).map((hit) => ({ start: hit.span.lo, end: hit.span.hi, type: hit.type }));

    if (ranges.length === 0) {
      for (const type of ALL_TYPES) {
        keptTotals[type] += visitor.counts[type];
      }
      continue;
    }

    if (backup) {
      await writeBackup(filePath, content, cwd);
    }

    const ms = new MagicString(content);
    const sortedRanges = ranges.sort((a, b) => b.start - a.start);

    for (const range of sortedRanges) {
      ms.remove(range.start, range.end);
      removedTotals[range.type] += 1;
    }

    for (const type of ALL_TYPES) {
      const removedCount = ranges.filter((r) => r.type === type).length;
      keptTotals[type] += visitor.counts[type] - removedCount;
    }

    const updated = ms.toString();
    if (updated !== content) {
      await fs.writeFile(filePath, updated, "utf8");
      filesChanged += 1;
    }
  }

  return { removed: removedTotals, kept: keptTotals, filesChanged };
}

async function writeBackup(filePath: string, content: string, cwd: string): Promise<void> {
  const relative = path.relative(cwd, filePath);
  const backupPath = path.join(cwd, ".clearconsole-backup", relative);
  const backupDir = path.dirname(backupPath);
  await fs.mkdir(backupDir, { recursive: true });
  await fs.writeFile(backupPath, content, "utf8");
}

function printScanReport(
  scanResults: FileScanResult[],
  totalCounts: Record<ConsoleType, number>,
  removableTotals: Record<ConsoleType, number>
): void {
  console.log(pc.bold("\nScan results:"));

  for (const result of scanResults) {
    const hasAny = sumCountValues(result.counts) > 0;
    if (!hasAny) continue;

    console.log(pc.dim(path.relative(process.cwd(), result.filePath)));
    for (const type of ALL_TYPES) {
      const count = result.counts[type];
      if (count > 0) {
        console.log(`  console.${type}: ${count}`);
      }
    }
  }

  console.log(pc.bold("\nTotal (found):"));
  for (const type of ALL_TYPES) {
    const count = totalCounts[type];
    if (count > 0) {
      console.log(`  console.${type}: ${count}`);
    }
  }

  console.log(pc.bold("\nPotential removals:"));
  for (const type of ALL_TYPES) {
    const count = removableTotals[type];
    if (count > 0) {
      console.log(`  console.${type}: ${count}`);
    }
  }
}

function printFinalReport(
  results: { removed: Record<ConsoleType, number>; kept: Record<ConsoleType, number>; filesChanged: number },
  durationMs: number
): void {
  console.log(pc.green("\nCleanup completed successfully"));

  console.log(pc.bold("\nRemoved:"));
  for (const type of ALL_TYPES) {
    const count = results.removed[type];
    if (count > 0) {
      console.log(`  console.${type}: ${count}`);
    }
  }

  console.log(pc.bold("\nKept:"));
  for (const type of ALL_TYPES) {
    const count = results.kept[type];
    if (count > 0) {
      console.log(`  console.${type}: ${count}`);
    }
  }

  console.log(`\nFiles affected: ${results.filesChanged}`);
  console.log(`Time: ${durationMs}ms`);
}

function sumCounts(countsList: Record<ConsoleType, number>[]): Record<ConsoleType, number> {
  const totals = initCounts();
  for (const counts of countsList) {
    for (const type of ALL_TYPES) {
      totals[type] += counts[type] ?? 0;
    }
  }
  return totals;
}

function sumCountValues(counts: Record<ConsoleType, number>): number {
  return ALL_TYPES.reduce((sum, type) => sum + (counts[type] ?? 0), 0);
}

function buildParseOptions(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const isTypeScript = ext === ".ts" || ext === ".tsx";
  const isJsx = ext === ".jsx" || ext === ".tsx";

  return {
    syntax: isTypeScript ? "typescript" : "ecmascript",
    tsx: isTypeScript && isJsx,
    jsx: !isTypeScript && isJsx,
    decorators: true,
    dynamicImport: true
  } as const;
}

function getConsoleMethod(expression: any): ConsoleType | null {
  if (!expression || expression.type !== "CallExpression") {
    return null;
  }

  const callee = expression.callee;
  if (!callee || callee.type !== "MemberExpression") {
    return null;
  }

  if (!callee.object || callee.object.type !== "Identifier" || callee.object.value !== "console") {
    return null;
  }

  if (!callee.computed && callee.property?.type === "Identifier") {
    const name = callee.property.value as ConsoleType;
    return ALL_TYPES.includes(name) ? name : null;
  }

  if (callee.computed && callee.property?.type === "StringLiteral") {
    const name = callee.property.value as ConsoleType;
    return ALL_TYPES.includes(name) ? name : null;
  }

  return null;
}

function shouldRemoveConsole(method: ConsoleType, directive: Directive, removeSet: Set<ConsoleType>): boolean {
  if (directive === "remove") return true;
  if (directive === "keep") return false;
  return removeSet.has(method);
}

function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

function findInlineDirective(source: string, lineStarts: number[], span: { hi: number }): Directive {
  const lineInfo = getLineInfo(source, lineStarts, span.hi);
  const line = source.slice(lineInfo.lineStart, lineInfo.lineEnd);
  const col = Math.max(0, span.hi - lineInfo.lineStart);
  const trailing = line.slice(col);

  const commentStart = findCommentStart(trailing);
  if (commentStart === -1) {
    return null;
  }

  const commentText = trailing.slice(commentStart);
  if (commentText.includes("@remove")) return "remove";
  if (commentText.includes("@keep")) return "keep";
  return null;
}

function findCommentStart(text: string): number {
  const lineComment = text.indexOf("//");
  const blockComment = text.indexOf("/*");

  if (lineComment === -1) return blockComment;
  if (blockComment === -1) return lineComment;
  return Math.min(lineComment, blockComment);
}

function getLineInfo(source: string, lineStarts: number[], index: number): { lineStart: number; lineEnd: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  let line = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = lineStarts[mid];
    if (start <= index) {
      line = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const lineStart = lineStarts[line];
  const nextStart = lineStarts[line + 1] ?? source.length;
  const lineEnd = nextStart > 0 && source[nextStart - 1] === "\n" ? nextStart - 1 : nextStart;

  return { lineStart, lineEnd };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

run().catch((error) => {
  console.error(pc.red("\nUnexpected error:"), error);
  process.exit(1);
});
