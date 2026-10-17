// 索引校验器的来源：优先本仓库 node_modules 里的 @deepseek-ai/dsh-plugin-market-index（npm 上有 0.2.1-rc.2），
// 没装依赖时回落到本机全局安装的 dsh（npm root -g 下 @deepseek-ai/dsh 的 node_modules）。
// semver 跟着同一来源走，保证范围判定与 dsh 运行时一致。

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** @returns {Promise<{ parseMarketIndex, MarketIndexError, marketInstallTarget, MAX_INLINE_ICON_BYTES, semver, source: string }>} */
export async function loadMarketIndexLib() {
  const candidates = [];
  try {
    candidates.push({ source: 'node_modules', path: require.resolve('@deepseek-ai/dsh-plugin-market-index') });
  } catch {
    /* 没装依赖 */
  }
  if (process.env.DSH_INSTALL_DIR) {
    candidates.push({
      source: `DSH_INSTALL_DIR=${process.env.DSH_INSTALL_DIR}`,
      path: join(process.env.DSH_INSTALL_DIR, 'node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js'),
    });
  }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    candidates.push({
      source: `全局 dsh（${root}）`,
      path: join(root, '@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js'),
    });
  } catch {
    /* 没有 npm */
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    const lib = await import(pathToFileURL(candidate.path).href);
    const localRequire = createRequire(candidate.path);
    const semver = localRequire('semver');
    return { ...lib, semver, source: candidate.source };
  }
  throw new Error(
    '找不到 @deepseek-ai/dsh-plugin-market-index：先 npm ci，或设置 DSH_INSTALL_DIR 指向 dsh 安装目录',
  );
}
