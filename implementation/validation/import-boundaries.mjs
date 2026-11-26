import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shared = ['src/core/', 'src/contracts/'];
const clean = file => file.replaceAll('\\', '/').replace(/^\.\//, '');
const hostGlobals = new Set(['window', 'document', 'navigator', 'Worker', 'SharedWorker', 'fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts']);

// Bind a single source without resolving imports or loading host libraries. Local
// symbols still have lexical scopes (parameters, blocks, destructuring, etc.).
// Unbound value references can then be distinguished from local data names.
function sourceChecker(file, ast) {
  const host = {
    getSourceFile: name => name === file ? ast : undefined,
    getDefaultLibFileName: () => '', writeFile: () => {},
    getCurrentDirectory: () => '', getDirectories: () => [],
    fileExists: name => name === file, readFile: () => undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n'
  };
  return ts.createProgram([file], { noLib: true, noResolve: true }, host).getTypeChecker();
}
function isInertName(node) {
  const parent = node.parent;
  return (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)
      || ts.isPropertyDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node && !ts.isShorthandPropertyAssignment(parent))
    || (ts.isBindingElement(parent) && parent.propertyName === node)
    || ((ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node);
}
export function checkSource(file, text) {
  file = clean(file);
  const errors = [];
  const core = shared.some(prefix => file.startsWith(prefix));
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const checker = sourceChecker(file, ast);
  const unbound = node => {
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    // TypeScript supplies a synthetic globalThis symbol even with noLib.
    return !symbol?.declarations?.some(declaration => declaration.getSourceFile() === ast);
  };
  function check(specifier) {
    const target = specifier.startsWith('.') ? clean(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))) : specifier;
    if (specifier.startsWith('.')) {
      if (!target.startsWith('src/core/') && !target.startsWith('src/contracts/') && !(file.startsWith('src/cli/') && (target.startsWith('src/cli/') || target.startsWith('src/hosts/node/'))) && !(file.startsWith('src/hosts/node/') && target.startsWith('src/hosts/node/')) && !(file.startsWith('src/contracts/') && /^design\/contracts\/v1\/[^/]+\.json$/.test(target))) errors.push(`${file}: forbidden import ${specifier}`);
    } else if (core ? !/^ajv(?:\/|$)/.test(specifier) : file.startsWith('src/hosts/node/') ? !/^node:/.test(specifier) : !/^(?:node:|ajv(?:\/|$))/.test(specifier)) errors.push(`${file}: forbidden dependency ${specifier}`);
  }
  function visit(node) {
    // Property/type names are not runtime global reads. Import types below
    // still need dependency checks, so do not prune the entire type subtree.
    let inType = false;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isTypeNode(parent)) { inType = true; break; }
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) check(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) check(node.argument.literal.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const arg = node.arguments[0];
      if (!arg || !ts.isStringLiteral(arg)) errors.push(`${file}: nonliteral module loading forbidden`); else check(arg.text);
    }
    if (!inType && ts.isIdentifier(node) && hostGlobals.has(node.text) && !isInertName(node) && unbound(node)) errors.push(`${file}: host/UI global ${node.text} forbidden`);
    // Explicit global namespace access must not hide a host dependency. Local
    // objects named globalThis/self remain ordinary data; computed static keys
    // are covered too. This guard is not an adversarial dynamic-code sandbox.
    if (!inType && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const base = node.expression;
      const key = ts.isPropertyAccessExpression(node) ? node.name.text
        : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
      if (ts.isIdentifier(base) && ['globalThis', 'self'].includes(base.text) && unbound(base) && hostGlobals.has(key)) errors.push(`${file}: host/UI global ${base.text}.${key} forbidden`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return errors;
}
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path.join(dir, entry.name)] : []);
}
export function checkRepository() {
  return ['src/core', 'src/contracts', 'src/cli', 'src/hosts/node'].flatMap(dir => walk(path.join(root, dir))).flatMap(file => checkSource(clean(path.relative(root, file)), fs.readFileSync(file, 'utf8')));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkRepository();
  const bundleIndex = process.argv.indexOf('--bundle');
  if (bundleIndex !== -1) {
    const meta = JSON.parse(fs.readFileSync(process.argv[bundleIndex + 1], 'utf8'));
    for (const file of Object.keys(meta.inputs)) {
      if (/(?:^|\/)(?:ui|browser|worker|workers|react|react-dom)(?:\/|$)|\.(?:svg|css|tsx)$/.test(file)) errors.push(`CLI bundle contains forbidden input ${file}`);
    }
  }
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Import boundaries passed (core/contracts/CLI/Node-host source and requested bundle).');
}
