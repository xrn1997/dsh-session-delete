import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 宿主数据根。官方解析器在 asar `dsh/node_modules/@deepseek-ai/dsh-home-paths/lib/index.js`：
 * `resolveDshHome(configured, env)` 的优先级 = 显式配置 > `$DSH_HOME`（**空白视为未设**，免得非法覆盖把 home
 * 解析成当前工作目录）> `~/.dsh`，并 `resolve()` 规范化、展开 `~/`。
 *
 * **只镜像后两级，且这与平台的同款设施等价**——"显式配置"那一级对插件**不可得**，三条实证：
 *  ① 平台自己的 helper `dshHomePath(...segments)` 逐字是 `join(resolveDshHome(), ...segments)`，
 *     **同样不传 `configured`**；
 *  ② `ctx.profileContext` 按 launcher 原文只装「profile 位置 / 启动 bundle 名 / 调用覆盖 / 遥测开关」，
 *     里面没有数据根；
 *  ③ 宿主自己的服务也不是"问出来"的——它们各自声明 `Config.dshHome`，由**装配那一行的人**填。
 * ⇒ 后果与边界（src/ports/host-port.ts）：显式配置过的 profile 上我们算出的根与宿主不一致 ⇒ 文件探测落空 ⇒
 * 删除/恢复以 `not-found` **响亮拒绝、零副作用**；**不会**动到别的树（sessions 与回收站同源 ⇒ 同卷）。
 * 本机两条路径都因此对得上：桌面版走 `~/.dsh`（实测 profile 在其下），隔离探针靠 `$DSH_HOME`。
 *
 * `home` 只用于测试注入假主目录；默认值仍是 `homedir()`，行为与搬家前一致。
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const fromEnv = env.DSH_HOME
  const raw = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(home, '.dsh')
  if (raw === '~') return home
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return resolve(join(home, raw.slice(2)))
  return resolve(raw)
}
