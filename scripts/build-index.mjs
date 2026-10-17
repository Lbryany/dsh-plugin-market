#!/usr/bin/env node
// 生成 dist/index.json。
//   node scripts/build-index.mjs [--repo owner/name] [--dry-run] [--out dist/index.json]
// 环境变量：GITHUB_TOKEN（可选，提高 API 限额）、INDEX_URL（默认 https://lbryany.github.io/dsh-plugin-market/index.json）

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHub } from './lib/github.mjs';
import { buildIndex } from './lib/build.mjs';
import { loadMarketIndexLib } from './lib/market-index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INDEX_URL = 'https://lbryany.github.io/dsh-plugin-market/index.json';

function parseArgs(argv) {
  const args = { dryRun: false, out: 'dist/index.json' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo') args.repo = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('用法：node scripts/build-index.mjs [--repo owner/name] [--dry-run] [--out dist/index.json]');
      process.exit(0);
    } else throw new Error(`未知参数 ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plugins = JSON.parse(await readFile(resolve(ROOT, 'plugins.json'), 'utf8'));
  const meta = JSON.parse(await readFile(resolve(ROOT, 'index.meta.json'), 'utf8'));
  const lib = await loadMarketIndexLib();
  console.error(`校验器：@deepseek-ai/dsh-plugin-market-index 来自 ${lib.source}`);
  const github = createGitHub({ token: process.env.GITHUB_TOKEN || undefined });
  const indexUrl = process.env.INDEX_URL || DEFAULT_INDEX_URL;
  const { index, report } = await buildIndex({
    plugins,
    meta,
    github,
    lib,
    indexUrl,
    onlyRepo: args.repo,
    warn: (line) => console.error(`警告：${line}`),
  });
  for (const r of report) {
    const reasons = r.skipped.map((s) => `${s.tag}：${s.reason}`).join('；');
    console.error(`${r.repo}：收录 ${r.included.length} 个版本${r.included.length ? `（${r.included.join('、')}）` : ''}，跳过 ${r.skipped.length} 个${reasons ? `（${reasons}）` : ''}`);
  }
  const text = `${JSON.stringify(index, null, 2)}\n`;
  if (args.dryRun) {
    process.stdout.write(text);
    return;
  }
  const out = resolve(ROOT, args.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, text);
  console.error(`已写入 ${out}：${index.plugins.length} 个插件`);
}

main().catch((error) => {
  console.error(`生成失败：${error?.path ? `${error.path} ${error.reason}` : error?.message ?? error}`);
  process.exit(1);
});
