import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 宿主数据根。官方解析器在 asar `dsh/node_modules/@deepseek-ai/dsh-home-paths/lib/index.js`：
 * `resolveDshHome(configured, env)` 的优先级 = 显式配置 > `$DSH_HOME`（**空白视为未设**）> `~/.dsh`，
 * 并 `resolve()` 规范化、展开 `~/`。本仓**只镜像后两级**，且与平台同款设施等价：「显式配置」那一级对插件不可得——
 * ① 平台自己的 helper `dshHomePath(...segments)` 逐字就是 `join(resolveDshHome(), ...segments)`，同样不传 `configured`；
 * ② `ctx.profileContext` 按 launcher 原文只装「profile 位置 / 启动 bundle 名 / 调用覆盖 / 遥测开关」，里面没有数据根；
 * ③ 宿主自己的服务也不是「问出来」的——它们各自声明 `Config.dshHome`，由装配那一行的人填。
 * 后果：显式配置过的 profile 上我们算出的根与宿主不一致 ⇒ 文件探测落空 ⇒ 移入回收站/恢复**响亮拒绝、零副作用**；不会动到别的树
 * （sessions 与回收站同源 ⇒ 同卷）。`homeDir` 只用于测试注入假主目录。
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env, homeDir: string = homedir()): string {
  const fromEnv = env.DSH_HOME
  const raw = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homeDir, '.dsh')
  if (raw === '~') return homeDir
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return resolve(join(homeDir, raw.slice(2)))
  return resolve(raw)
}
