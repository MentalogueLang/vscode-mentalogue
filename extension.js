const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs/promises");
const path = require("path");

const KEYWORDS = [
  "fn",
  "struct",
  "enum",
  "const",
  "let",
  "if",
  "else",
  "while",
  "for",
  "in",
  "return",
  "import",
  "pub",
  "priv",
  "comptime",
  "true",
  "false",
];

const BUILTIN_TYPES = ["int", "bool", "byte", "string", "float", "void"];

function isMtl(uri) {
  return uri && uri.scheme === "file" && uri.fsPath.toLowerCase().endsWith(".mtl");
}

function isMlib(uri) {
  return uri && uri.scheme === "file" && uri.fsPath.toLowerCase().endsWith(".mlib");
}

function toRange(line, start, end) {
  const safeStart = Math.max(0, start);
  const safeEnd = Math.max(safeStart + 1, end);
  return new vscode.Range(
    new vscode.Position(line, safeStart),
    new vscode.Position(line, safeEnd)
  );
}

class SymbolIndex {
  constructor(output) {
    this.output = output;
    this.byFile = new Map();
    this.byName = new Map();
    this.modulePaths = new Set();
    this.moduleToFileKeys = new Map();
  }

  clear() {
    this.byFile.clear();
    this.byName.clear();
    this.modulePaths.clear();
    this.moduleToFileKeys.clear();
  }

  removeUri(uri) {
    const key = uri.toString();
    const symbols = this.byFile.get(key);
    if (!symbols) {
      return;
    }
    this.byFile.delete(key);
    for (const symbol of symbols) {
      const list = this.byName.get(symbol.name);
      if (!list) {
        continue;
      }
      const next = list.filter((entry) => entry.fileKey !== key);
      if (next.length === 0) {
        this.byName.delete(symbol.name);
      } else {
        this.byName.set(symbol.name, next);
      }
    }
    this.rebuildModulePaths();
  }

  addSymbols(uri, symbols) {
    const key = uri.toString();
    this.removeUri(uri);
    this.byFile.set(key, symbols);
    for (const symbol of symbols) {
      const list = this.byName.get(symbol.name) || [];
      list.push(symbol);
      this.byName.set(symbol.name, list);
    }
    this.rebuildModulePaths();
  }

  allSymbols() {
    const seen = new Set();
    const out = [];
    for (const list of this.byName.values()) {
      for (const symbol of list) {
        const key = `${symbol.name}|${symbol.signature}|${symbol.uri.toString()}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.push(symbol);
      }
    }
    return out;
  }

  find(name) {
    const list = this.byName.get(name) || [];
    return list.slice().sort((a, b) => {
      if (a.sourceKind !== b.sourceKind) {
        return a.sourceKind === "mtl" ? -1 : 1;
      }
      return a.uri.fsPath.localeCompare(b.uri.fsPath);
    });
  }

  async rebuild() {
    this.clear();
    const config = vscode.workspace.getConfiguration("mentalogue");
    const indexMlib = config.get("indexMlib", true);
    const include = indexMlib ? "**/*.{mtl,mlib}" : "**/*.mtl";
    const exclude = "**/{.git,node_modules,target,dist,.inscribe,bin,obj}/**";
    const files = await vscode.workspace.findFiles(include, exclude);
    await Promise.all(files.map((uri) => this.updateUri(uri)));
  }

  async updateUri(uri) {
    try {
      if (isMtl(uri)) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder("utf-8").decode(bytes);
        const symbols = this.parseMtl(uri, text);
        this.addSymbols(uri, symbols);
        return;
      }
      if (isMlib(uri)) {
        const config = vscode.workspace.getConfiguration("mentalogue");
        const indexMlib = config.get("indexMlib", true);
        if (!indexMlib) {
          this.removeUri(uri);
          return;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        const symbols = this.parseMlib(uri, bytes);
        this.addSymbols(uri, symbols);
        return;
      }
      this.removeUri(uri);
    } catch (error) {
      this.output.appendLine(
        `[index] failed to parse ${uri.fsPath}: ${error && error.message ? error.message : String(error)}`
      );
      this.removeUri(uri);
    }
  }

  parseMtl(uri, text) {
    const symbols = [];
    const lines = text.split(/\r?\n/);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) {
        continue;
      }
      const visibility = /^\s*priv\b/.test(line) ? "private" : "public";
      const declaration = line.replace(/^\s*(?:pub|priv)\s+/, "").trimStart();

      let match = declaration.match(/^fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (match) {
        const name = match[1];
        let signature = declaration;
        const brace = signature.indexOf("{");
        if (brace >= 0) {
          signature = signature.slice(0, brace).trim();
        }
        const start = line.indexOf(name);
        symbols.push({
          name,
          kind: "fn",
          signature,
          uri,
          range: toRange(lineIndex, start, start + name.length),
          sourceKind: "mtl",
          visibility,
          fileKey: uri.toString(),
        });
        continue;
      }

      match = declaration.match(/^struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
      if (match) {
        const name = match[1];
        const start = line.indexOf(name);
        symbols.push({
          name,
          kind: "struct",
          signature: `struct ${name}`,
          uri,
          range: toRange(lineIndex, start, start + name.length),
          sourceKind: "mtl",
          visibility,
          fileKey: uri.toString(),
        });
        continue;
      }

      match = declaration.match(/^enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
      if (match) {
        const name = match[1];
        const start = line.indexOf(name);
        symbols.push({
          name,
          kind: "enum",
          signature: `enum ${name}`,
          uri,
          range: toRange(lineIndex, start, start + name.length),
          sourceKind: "mtl",
          visibility,
          fileKey: uri.toString(),
        });
        continue;
      }

      match = declaration.match(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
      if (match) {
        const name = match[1];
        const start = line.indexOf(name);
        symbols.push({
          name,
          kind: "const",
          signature: declaration,
          uri,
          range: toRange(lineIndex, start, start + name.length),
          sourceKind: "mtl",
          visibility,
          fileKey: uri.toString(),
        });
      }
    }

    return symbols;
  }

  parseMlib(uri, bytes) {
    const symbols = [];
    const raw = Buffer.from(bytes).toString("latin1");
    const chunks = raw
      .split("\x00")
      .map((entry) => entry.replace(/[^\x20-\x7E]/g, "").trim())
      .filter((entry) => entry.length > 0);

    const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (let i = 0; i < chunks.length - 1; i += 1) {
      const name = chunks[i];
      const next = chunks[i + 1];
      if (!ident.test(name)) {
        continue;
      }
      if (!/^(fn\(|struct\s+\{|enum\s+\{)/.test(next)) {
        continue;
      }
      let kind = "symbol";
      if (next.startsWith("fn(")) {
        kind = "fn";
      } else if (next.startsWith("struct")) {
        kind = "struct";
      } else if (next.startsWith("enum")) {
        kind = "enum";
      }
      symbols.push({
        name,
        kind,
        signature: `${name} ${next}`,
        uri,
        range: toRange(0, 0, Math.max(1, name.length)),
        sourceKind: "mlib",
        visibility: "public",
        fileKey: uri.toString(),
      });
      i += 1;
    }

    return symbols;
  }

  rebuildModulePaths() {
    this.modulePaths.clear();
    this.moduleToFileKeys.clear();
    const byFileKeys = Array.from(this.byFile.keys());
    for (const key of byFileKeys) {
      const uri = vscode.Uri.parse(key);
      const candidates = this.modulePathsForUri(uri);
      for (const modulePath of candidates) {
        this.modulePaths.add(modulePath);
        const fileKeys = this.moduleToFileKeys.get(modulePath) || new Set();
        fileKeys.add(key);
        this.moduleToFileKeys.set(modulePath, fileKeys);
      }
    }
  }

  modulePathsForUri(uri) {
    const out = new Set();
    if (isMtl(uri)) {
      const folders = vscode.workspace.workspaceFolders || [];
      for (const folder of folders) {
        const root = folder.uri.fsPath;
        const relative = path.relative(root, uri.fsPath);
        if (relative.startsWith("..")) {
          continue;
        }
        const normalized = relative.replace(/\\/g, "/");
        if (!normalized.endsWith(".mtl")) {
          continue;
        }
        const withoutExt = normalized.slice(0, -4);
        if (withoutExt) {
          out.add(withoutExt.replace(/\//g, "."));
        }
      }
    } else if (isMlib(uri)) {
      const base = path.basename(uri.fsPath, ".mlib");
      if (base) {
        out.add(base);
      }
    }
    return Array.from(out);
  }

  symbolsForDocument(document) {
    const visible = [];
    const seen = new Set();
    const localKey = document.uri.toString();
    const localSymbols = this.byFile.get(localKey) || [];
    for (const symbol of localSymbols) {
      const id = `${symbol.name}|${symbol.signature}|${symbol.fileKey}`;
      if (!seen.has(id)) {
        seen.add(id);
        visible.push(symbol);
      }
    }

    const imports = parseImports(document.getText());
    for (const imported of imports) {
      const fileKeys = this.moduleToFileKeys.get(imported);
      if (!fileKeys) {
        continue;
      }
      for (const fileKey of fileKeys) {
        if (fileKey === localKey) {
          continue;
        }
        const symbols = this.byFile.get(fileKey) || [];
        for (const symbol of symbols) {
          if (symbol.visibility === "private") {
            continue;
          }
          const id = `${symbol.name}|${symbol.signature}|${symbol.fileKey}`;
          if (!seen.has(id)) {
            seen.add(id);
            visible.push(symbol);
          }
        }
      }
    }

    return visible;
  }

  matchesForDocument(document, name) {
    return this.symbolsForDocument(document).filter((symbol) => symbol.name === name);
  }
}

function parseImports(text) {
  const imports = new Set();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)\s*$/);
    if (match) {
      imports.add(match[1]);
    }
  }
  return imports;
}

function symbolToCompletion(symbol) {
  let kind = vscode.CompletionItemKind.Variable;
  if (symbol.kind === "fn") {
    kind = vscode.CompletionItemKind.Function;
  } else if (symbol.kind === "struct" || symbol.kind === "enum") {
    kind = vscode.CompletionItemKind.Struct;
  } else if (symbol.kind === "const") {
    kind = vscode.CompletionItemKind.Constant;
  }
  const item = new vscode.CompletionItem(symbol.name, kind);
  item.detail = symbol.signature;
  item.sortText = `z_${symbol.name}`;
  item.documentation = new vscode.MarkdownString(
    `Defined in \`${path.basename(symbol.uri.fsPath)}\``
  );
  return item;
}

function parseDiagnostics(output, document) {
  const diagnostics = [];
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const pattern = /^(.*?)(?: at line (\d+), column (\d+))(?:;.*)?$/i;

  for (const line of lines) {
    if (!line) {
      continue;
    }
    if (
      line.startsWith("Finished `") ||
      line.startsWith("Running `") ||
      line.startsWith("error: process didn't exit successfully")
    ) {
      continue;
    }
    const match = line.match(pattern);
    if (match) {
      const message = match[1].trim();
      const lineNumber = Math.max(0, Number.parseInt(match[2], 10) - 1);
      const colNumber = Math.max(0, Number.parseInt(match[3], 10) - 1);
      const safeLine = Math.min(lineNumber, Math.max(0, document.lineCount - 1));
      const lineEnd = document.lineAt(safeLine).range.end.character;
      const safeCol = Math.min(colNumber, Math.max(0, lineEnd));
      const endCol = Math.min(safeCol + 1, lineEnd);
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(
            new vscode.Position(safeLine, safeCol),
            new vscode.Position(safeLine, Math.max(safeCol + 1, endCol))
          ),
          message,
          vscode.DiagnosticSeverity.Error
        )
      );
      continue;
    }
    if (line.includes("error")) {
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)),
          line,
          vscode.DiagnosticSeverity.Error
        )
      );
      break;
    }
  }

  return diagnostics;
}

function runCommand(exe, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const useShell = process.platform === "win32";
    cp.execFile(
      exe,
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        shell: useShell,
      },
      (error, stdout, stderr) => {
        const output = `${stdout || ""}\n${stderr || ""}`;
        resolve({ error, output });
      }
    );
  });
}

async function withCheckPathForDocument(document, useUnsaved, fn) {
  if (!useUnsaved || !document.isDirty) {
    return fn(document.uri.fsPath);
  }

  const sourcePath = document.uri.fsPath;
  const dir = path.dirname(sourcePath);
  const base = path.basename(sourcePath, ".mtl");
  const tempPath = path.join(
    dir,
    `.${base}.mentalogue-check-${process.pid}-${Date.now()}.mtl`
  );

  try {
    await fs.writeFile(tempPath, document.getText(), "utf8");
    return await fn(tempPath);
  } finally {
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors for temp diagnostics files.
    }
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel("Mentalogue");
  const diagnostics = vscode.languages.createDiagnosticCollection("mentalogue");
  const index = new SymbolIndex(output);
  const pendingChecks = new Map();
  const runningChecks = new Set();
  let inscribeMissingWarningShown = false;
  let intervalHandle = null;

  context.subscriptions.push(output, diagnostics);

  const selector = [
    { language: "mentalogue", scheme: "file" },
    { language: "mentalogue-mlib", scheme: "file" },
  ];

  const completionProvider = vscode.languages.registerCompletionItemProvider(
    selector,
    {
      provideCompletionItems(document, position) {
        if (!isMtl(document.uri)) {
          return [];
        }
        const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
        const items = [];

        if (/^\s*import\s+[A-Za-z0-9_.]*$/.test(linePrefix)) {
          for (const modulePath of index.modulePaths) {
            const item = new vscode.CompletionItem(modulePath, vscode.CompletionItemKind.Module);
            item.sortText = `a_${modulePath}`;
            items.push(item);
          }
          return items;
        }

        for (const keyword of KEYWORDS) {
          const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
          item.sortText = `k_${keyword}`;
          items.push(item);
        }
        for (const ty of BUILTIN_TYPES) {
          const item = new vscode.CompletionItem(ty, vscode.CompletionItemKind.TypeParameter);
          item.sortText = `t_${ty}`;
          items.push(item);
        }
        for (const symbol of index.symbolsForDocument(document)) {
          items.push(symbolToCompletion(symbol));
        }
        return items;
      },
    },
    "."
  );

  const hoverProvider = vscode.languages.registerHoverProvider(selector, {
    provideHover(document, position) {
      const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
      if (!range) {
        return null;
      }
      const name = document.getText(range);
      const matches = index.matchesForDocument(document, name);
      if (matches.length === 0) {
        return null;
      }
      const symbol = matches[0];
      const markdown = new vscode.MarkdownString();
      markdown.appendCodeblock(symbol.signature, "mentalogue");
      markdown.appendMarkdown(`\n\nDefined in \`${symbol.uri.fsPath}\``);
      return new vscode.Hover(markdown, range);
    },
  });

  const definitionProvider = vscode.languages.registerDefinitionProvider(selector, {
    provideDefinition(document, position) {
      const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
      if (!range) {
        return null;
      }
      const name = document.getText(range);
      const matches = index.matchesForDocument(document, name);
      if (matches.length === 0) {
        return null;
      }
      return matches.map(
        (symbol) => new vscode.Location(symbol.uri, symbol.range || new vscode.Position(0, 0))
      );
    },
  });

  context.subscriptions.push(completionProvider, hoverProvider, definitionProvider);

  async function rebuildIndex() {
    output.appendLine("[index] rebuilding symbol index...");
    await index.rebuild();
    output.appendLine(`[index] indexed ${index.allSymbols().length} symbols`);
  }

  async function runCheckForDocument(document) {
    if (!document || !isMtl(document.uri)) {
      return;
    }
    const key = document.uri.toString();
    if (runningChecks.has(key)) {
      return;
    }

    runningChecks.add(key);
    try {
      const config = vscode.workspace.getConfiguration("mentalogue");
      const inscribePath = config.get("inscribePath", "inscribe");
      const timeoutMs = config.get("checkTimeoutMs", 12000);
      const useUnsaved = config.get("checkUnsavedChanges", true);
      const cwd = path.dirname(document.uri.fsPath);
      const result = await withCheckPathForDocument(document, useUnsaved, async (checkPath) =>
        runCommand(inscribePath, ["check", checkPath], cwd, timeoutMs)
      );

      const maybeMissing =
        result.error &&
        (result.error.code === "ENOENT" ||
          /not recognized|not found|cannot find/i.test(result.output || ""));

      if (maybeMissing) {
        diagnostics.delete(document.uri);
        if (!inscribeMissingWarningShown) {
          inscribeMissingWarningShown = true;
          vscode.window.showWarningMessage(
            "Mentalogue extension: `inscribe` was not found. Install Inscribe or set mentalogue.inscribePath."
          );
        }
        return;
      }

      const parsed = parseDiagnostics(result.output, document);
      diagnostics.set(document.uri, parsed);
    } finally {
      runningChecks.delete(key);
    }
  }

  function scheduleCheck(uri, delayMs) {
    if (!isMtl(uri)) {
      return;
    }
    const key = uri.toString();
    const existing = pendingChecks.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const handle = setTimeout(async () => {
      pendingChecks.delete(key);
      const doc = vscode.workspace.textDocuments.find((entry) => entry.uri.toString() === key);
      if (doc) {
        await runCheckForDocument(doc);
      } else {
        try {
          const loaded = await vscode.workspace.openTextDocument(uri);
          await runCheckForDocument(loaded);
        } catch {
          diagnostics.delete(uri);
        }
      }
    }, delayMs);
    pendingChecks.set(key, handle);
  }

  function restartInterval() {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    const config = vscode.workspace.getConfiguration("mentalogue");
    const enabled = config.get("enablePeriodicCheck", true);
    const intervalMs = Math.max(300, config.get("checkIntervalMs", 1500));
    if (!enabled) {
      return;
    }
    intervalHandle = setInterval(() => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isMtl(editor.document.uri)) {
        return;
      }
      scheduleCheck(editor.document.uri, 150);
    }, intervalMs);
  }

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{mtl,mlib}");
  watcher.onDidCreate((uri) => index.updateUri(uri));
  watcher.onDidChange((uri) => index.updateUri(uri));
  watcher.onDidDelete((uri) => index.removeUri(uri));
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (isMtl(event.document.uri)) {
        index.updateUri(event.document.uri);
        scheduleCheck(event.document.uri, 500);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!isMtl(document.uri)) {
        return;
      }
      index.updateUri(document.uri);
      const config = vscode.workspace.getConfiguration("mentalogue");
      if (config.get("checkOnSave", true)) {
        scheduleCheck(document.uri, 100);
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || !isMtl(editor.document.uri)) {
        return;
      }
      scheduleCheck(editor.document.uri, 150);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mentalogue")) {
        restartInterval();
        rebuildIndex();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mentalogue.refreshIndex", async () => {
      await rebuildIndex();
      vscode.window.showInformationMessage("Mentalogue symbol index refreshed.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mentalogue.runCheck", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isMtl(editor.document.uri)) {
        vscode.window.showInformationMessage("Open an .mtl file to run inscribe check.");
        return;
      }
      await runCheckForDocument(editor.document);
      vscode.window.showInformationMessage("Mentalogue check completed.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mentalogue.suturePull", async () => {
      const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      if (!folder) {
        vscode.window.showWarningMessage("Open a workspace folder first.");
        return;
      }
      const config = vscode.workspace.getConfiguration("mentalogue");
      const suturePath = config.get("suturePath", "suture");
      const result = await runCommand(suturePath, ["pull"], folder.uri.fsPath, 120000);
      output.appendLine(result.output);
      if (result.error) {
        vscode.window.showErrorMessage("Suture pull failed. See Mentalogue output channel.");
      } else {
        vscode.window.showInformationMessage("Suture pull completed.");
      }
    })
  );

  rebuildIndex();
  restartInterval();
  context.subscriptions.push({
    dispose: () => {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    },
  });

  const active = vscode.window.activeTextEditor;
  if (active && isMtl(active.document.uri)) {
    scheduleCheck(active.document.uri, 200);
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
