import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Local-only source/build boundary check. Never logs environment values or matched text. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(root, 'apps/web/src');
const buildRoot = join(root, 'apps/web/.next');
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}
async function localImport(from: string, specifier: string): Promise<string | undefined> {
  const base = specifier.startsWith('@/') ? join(sourceRoot, specifier.slice(2)) : specifier.startsWith('.') ? resolve(dirname(from), specifier) : undefined;
  if (!base) return undefined;
  for (const path of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    try { if ((await stat(path)).isFile()) return path; } catch { /* Try the next extension. */ }
  }
  throw new Error(`Unresolved local runtime dependency in ${relative(root, from)}.`);
}
function typeOnly(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  return !clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings)
    && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(item => item.isTypeOnly);
}
function runtimeDependencies(source: ts.SourceFile): string[] {
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !typeOnly(node.importClause) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      && (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some(item => !item.isTypeOnly))) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      assert(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]), 'Non-static client import requires explicit boundary review.');
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

const sourceFiles = (await files(sourceRoot)).filter(file => /\.[jt]sx?$/.test(file));
const parsed = new Map(await Promise.all(sourceFiles.map(async file => [file, ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true)] as const)));
const nonProduct = /(?:^|\/)(?:fixtures|test|dev|mocks)(?:\/|$)|\.test\.|\.dev\./;
const clients = [...parsed.entries()].filter(([file, source]) => !nonProduct.test(relative(sourceRoot, file))
  && source.statements.some(node => ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'use client')).map(([file]) => file);
assert(clients.length > 0, 'No client entry points found.');
const visited = new Set<string>();
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
async function visit(file: string): Promise<void> {
  if (visited.has(file)) return;
  visited.add(file);
  const name = relative(sourceRoot, file);
  assert(!name.startsWith('..') && !/(?:^|\/)(?:fixtures|test|dev|mocks)(?:\/|$)|\.test\.|\.dev\./.test(name), `Non-product module reachable by a client: ${name}`);
  assert(!name.startsWith('app/api/') && name !== 'lib/api/proxy.ts', 'Server transport reachable by a client.');
  const source = parsed.get(file);
  if (!source) return; // Local CSS/assets carry no JS runtime imports.
  for (const dependency of runtimeDependencies(source)) {
    assert(!dependency.startsWith('node:') && !builtins.has(dependency) && dependency !== '@tastecase/contracts'
      && !['pg', 'fastify', 'server-only'].includes(dependency), `Node/server contract runtime reachable by a client: ${name}`);
    const local = await localImport(file, dependency);
    if (local) await visit(local);
  }
}
for (const client of clients) await visit(client);

const manifest = JSON.parse(await readFile(join(buildRoot, 'server/app-paths-manifest.json'), 'utf8')) as Record<string, string>;
assert(Object.keys(manifest).length > 0, 'Empty production route manifest.');
assert(Object.keys(manifest).every(route => !/(?:^|\/)dev(?:\/|$)/.test(route)), 'Development fixture route present in production.');
assert('/api/tastecase/[...path]/route' in manifest, 'Production proxy route missing.');
const browserFiles = (await files(join(buildRoot, 'static'))).filter(file => /\.(?:js|map|css)$/.test(file));
assert(browserFiles.some(file => file.endsWith('.js')), 'No browser JavaScript generated.');
const privateValues = Object.entries(process.env).flatMap(([name, value]) => {
  if (name.startsWith('NEXT_PUBLIC_') || !/(?:SECRET|TOKEN|PASSWORD|KEY|CREDENTIAL|DATABASE_URL)/i.test(name) || !value || value.length < 8) return [];
  return [value, JSON.stringify(value).slice(1, -1)];
});
for (const file of browserFiles) {
  const text = await readFile(file, 'utf8');
  assert(!privateValues.some(secret => text.includes(secret)), 'Runtime private environment value leaked into a browser asset.');
  assert(!/tc_runner_[A-Za-z0-9_-]{43}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|["']node:crypto["']|["']node:fs(?:\/promises)?["']|["']@tastecase\/contracts["']|tastecase_verify_runner_handshake/.test(text), 'Credential/server-contract marker present in a browser asset.');
}
console.info(`Web production boundaries passed: ${clients.length} client roots, ${visited.size} local modules, ${Object.keys(manifest).length} routes, ${browserFiles.length} browser assets; no /dev routes, runtime Node contracts or configured private values found.`);
