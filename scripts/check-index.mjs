#!/usr/bin/env node
// 线上自检：node scripts/check-index.mjs <url>
// 用 fetch 拉取该 URL（redirect: 'manual'，dsh 的市场服务同样拒绝重定向），断言 200、content-type 含 application/json、
// 没有 location 头，再交 parseMarketIndex 校验。任一项不过非零退出。

import { loadMarketIndexLib } from './lib/market-index.mjs';

async function main() {
  const url = process.argv[2];
  if (!url || !URL.canParse(url)) {
    console.error('用法：node scripts/check-index.mjs <index-url>');
    process.exit(2);
  }
  const lib = await loadMarketIndexLib();
  const response = await fetch(url, { redirect: 'manual', headers: { accept: 'application/json' } });
  const problems = [];
  if (response.status !== 200) problems.push(`状态码 ${response.status}，要 200`);
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) problems.push(`content-type 是 ${JSON.stringify(type)}，要含 application/json`);
  const location = response.headers.get('location');
  if (location) problems.push(`带 location 头（${location}），dsh 拒绝重定向`);
  let index;
  try {
    index = lib.parseMarketIndex(JSON.parse(await response.text()), url);
  } catch (error) {
    problems.push(`索引校验失败：${error?.path ? `${error.path} ${error.reason}` : error?.message ?? error}`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`不通过：${p}`);
    process.exit(1);
  }
  const versions = index.plugins.reduce((n, p) => n + p.versions.length, 0);
  console.log(`通过：${url} 200 application/json 无重定向；${index.plugins.length} 个插件、${versions} 个版本（校验器来自 ${lib.source}）`);
  for (const p of index.plugins) console.log(`  ${p.name}：${p.versions.map((v) => `${v.version}${v.engines.dsh ? `（dsh ${v.engines.dsh}）` : ''}`).join('、')}`);
}

main().catch((error) => {
  console.error(`自检失败：${error?.message ?? error}`);
  process.exit(1);
});
