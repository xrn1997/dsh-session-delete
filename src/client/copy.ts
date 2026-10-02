/**
 * 可见文案（**全部**住在这里）＋接上宿主 Client locale 服务的那一步。
 *
 * ## 为什么不是散在各组件里的中文字面量
 *
 * 官方给第三方 UI 插件的规则是「Route visible UI text through the Client locale service」
 * （宿主技能 `cordis-plugin-development/references/ui-plugin.md`）。宿主自己那套就是这么做的：
 * `ui-sidebar` 声明 `inject = ['slots','layout','uiWorkspace','locale','shortcuts']`，并在
 * `ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar: dictionaries')` 里注册字典
 * （真产物原文）。所以本插件也把文案收成一份带**命名空间**的字典，`zh` 是完整真源、`en` 逐键镜像
 * ——宿主 `register` 的**对象形式要求两套内置语言都齐**（缺一个键就是运行期报错）。
 *
 * ## 服务是**可选读**的，不进 `inject`
 *
 * `ctx.get('locale')` 而不是把 `locale` 写进 `inject`。理由是本仓那条硬约束的另一面：**客户端半的
 * 条目激活失败 = 宿主进程死**（前端启动自检 `web boot: N entry did not activate` ⇒ 桌面壳
 * `reportFatal('web-boot')`）。宿主自己的 `ui-sidebar` 敢硬注入 `locale`（它是宿主的一部分，知道
 * 那一行一定在），而本插件要跨宿主代数活着 ⇒ 服务缺席时**降级到内置 zh 文案继续工作**，
 * 好过整个进程死。这与宿主对可选服务的官方写法同形（`ctx.get('…')?.…`）。
 *
 * 取数面：[`dsh-client-locale`] 的 `LocaleRuntime.register(ns, { zh, en })` 返回一个 disposer
 * （必须挂进 `ctx.effect`，否则卸载后字典留在注册表里，下次挂载会撞 "already has locale"），
 * `bind(ns)` 交回一个**按命名空间记忆化**的 `t(key, params)`（官方明说它"retain stable identity …
 * so they can ride inject surfaces without breaking memoization"——所以我们把它塞进槽位的
 * `inject` 载荷是正当用法）。
 *
 * ## 面板行那一行字为什么要用 thunk
 *
 * `sidebar.panellist` 的行名字由宿主 `syncPanels` 逐字 `label: resolveSlotLabel(options.label) ?? id`
 * 解析，而 `resolveSlotLabel` 的实现是 `typeof label === 'function' ? label() : label`，
 * 其 JSDoc 原文即 "thunks follow the active locale"；宿主自己还挂了
 * `ctx.effect(() => ctx.locale.subscribe(syncPanels), 'ui-sidebar: panel labels')` 在语言切换时重读。
 * ⇒ 面板名传 `() => t('trash.title')` 就随语言走；**换成活计数就会 stale**（只在条目或语言变化时重读）。
 */
import type { ClientContextLike } from './context.js'

/** 本插件的文案命名空间（第三方必须自带前缀；官方占用的是 `common` / `settings` / `sidebar` 这些）。 */
const COPY_NS = 'xrn1997-session-delete'

/** zh 是真源；`en` 必须逐键齐全（宿主的对象形式注册会整体校验）。 */
const ZH = {
  'common.untitled': '(无标题会话)',
  'common.cancel': '取消',
  'common.close': '关闭',
  'common.refresh': '刷新',
  'common.retry': '重试',

  'trash.title': '回收站',
  'trash.loading': '正在读回收站…',
  'trash.readFailed': '回收站读不到',
  'trash.empty.title': '回收站是空的',
  'trash.empty.hint': '在会话条目的「…」菜单里选「删除」，会话会先进到这里，随时可以恢复。',
  'trash.summary': '{count} 个会话 · 共 {size}',
  'trash.group.count': '{count} 个会话',
  'trash.project.unknown': '未记录项目',
  'trash.row.deletedNow': '刚刚删除',
  'trash.row.deletedAgo': '删除于 {n}{unit}前',
  'trash.unit.minutes': '分钟',
  'trash.unit.hours': '小时',
  'trash.unit.days': '天',
  'trash.unit.months': '个月',
  'trash.unit.years': '年',
  'trash.row.restore': '恢复',
  'trash.row.purge': '彻底删除…',
  'trash.footer.note': '回收站本体在宿主数据根下的 {dir} 里，不自动过期；清空后不可恢复。',
  'trash.emptyAll': '清空回收站…',
  'trash.confirm.all': '清空回收站？',
  'trash.confirm.one': '彻底删除 1 个会话？',
  'trash.confirm.one.meta': '{project} · 删除于 {at} · {size}',
  'trash.confirm.body': '这会从回收站移除文件，{strong}。',
  'trash.confirm.body.strong': '之后没有任何副本可以恢复',
  'trash.confirm.purge': '彻底删除',

  'menu.delete': '删除',
  'menu.live': '会话正在运行，先停止再删除',

  'dialog.title': '删除这个会话？',
  'dialog.hint': '会话会移入回收站，之后可以随时恢复。彻底删除是回收站里的另一个动作。',
  'dialog.confirm': '移入回收站',

  'undo.moved': '{title} 已移入回收站',
  'undo.session': '会话',
  'undo.undo': '撤销',
} as const

export type CopyKey = keyof typeof ZH

/** en：与 `ZH` 逐键镜像（键集合由 `Record<CopyKey, string>` 盯住，漏一个就编译不过）。
 *  单位词与宿主 en 侧 `relativeTime` 的写法对齐（宿主 en 的桶就是 `5min` / `3h` / `2d` / `4mo` / `1y`）。 */
const EN: Record<CopyKey, string> = {
  'common.untitled': '(Untitled session)',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.refresh': 'Refresh',
  'common.retry': 'Retry',

  'trash.title': 'Trash',
  'trash.loading': 'Reading the trash…',
  'trash.readFailed': 'Could not read the trash',
  'trash.empty.title': 'The trash is empty',
  'trash.empty.hint':
    'Pick Delete in a session’s “…” menu; the session lands here first and can be restored at any time.',
  'trash.summary': '{count} sessions · {size} total',
  'trash.group.count': '{count} sessions',
  'trash.project.unknown': 'Unrecorded project',
  'trash.row.deletedNow': 'Deleted just now',
  'trash.row.deletedAgo': 'Deleted {n}{unit} ago',
  'trash.unit.minutes': 'min',
  'trash.unit.hours': 'h',
  'trash.unit.days': 'd',
  'trash.unit.months': 'mo',
  'trash.unit.years': 'y',
  'trash.row.restore': 'Restore',
  'trash.row.purge': 'Delete permanently…',
  'trash.footer.note':
    'The trash itself lives under the host data root in {dir}; it never expires on its own, and emptying it cannot be undone.',
  'trash.emptyAll': 'Empty the trash…',
  'trash.confirm.all': 'Empty the trash?',
  'trash.confirm.one': 'Delete this session permanently?',
  'trash.confirm.one.meta': '{project} · deleted {at} · {size}',
  'trash.confirm.body': 'This removes the files from the trash; {strong}.',
  'trash.confirm.body.strong': 'no copy remains to restore it',
  'trash.confirm.purge': 'Delete permanently',

  'menu.delete': 'Delete',
  'menu.live': 'This session is running. Stop it first.',

  'dialog.title': 'Delete this session?',
  'dialog.hint':
    'The session moves to the trash and can be restored at any time. Permanent deletion is a separate action in the trash.',
  'dialog.confirm': 'Move to trash',

  'undo.moved': '{title} was moved to the trash',
  'undo.session': 'the session',
  'undo.undo': 'Undo',
}

export type CopyParams = Readonly<Record<string, string | number>>
export type Translate = (key: CopyKey, params?: CopyParams) => string

/** 与宿主 `translate` 同一条替换规则（`{name}`，参数缺席时原样留下占位符）。 */
function interpolate(template: string, params?: CopyParams): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

/** 服务缺席时的缺省：字典里那套 zh。**也是组件 prop 的缺省值**——它表达的是"这次没有 locale 服务"，
 *  与运行期 `createTranslate` 的降级分支是同一件事，不是"忘了传"。 */
export const zhTranslate: Translate = (key, params) => interpolate(ZH[key], params)

/** 宿主 locale 服务的窄镜像（只声明本插件用到的两个方法 + 一次强转；不装宿主类型包）。 */
interface LocaleServiceLike {
  register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void
  bind(ns: string): (key: string, params?: CopyParams) => string
}

/**
 * 注册字典并交回本插件的 `t`。服务不在时返回 `zhTranslate`（不抛、不 pending）。
 *
 * 注册必须挂在 `ctx.effect` 上：`register` 返回的 disposer 是**官方契约**（卸载时要把字典摘掉），
 * 而且同一命名空间的同一语言**只能注册一次**——effect 没挂，HMR 重挂就撞 "already has locale"。
 */
export function createTranslate(ctx: ClientContextLike): Translate {
  const service = ctx.get?.('locale') as LocaleServiceLike | undefined
  if (service === undefined) return zhTranslate
  ctx.effect(() => service.register(COPY_NS, { zh: ZH, en: EN }), 'session-delete: copy dictionaries')
  const bound = service.bind(COPY_NS)
  return (key, params) => bound(key, params)
}

/**
 * 把一句话里内嵌的那一段拆出来：`'…文件，之后没有任何副本可以恢复。'` 交给调用面用 `<b>` 包中间那段。
 *
 * 为什么不留成"前段 / 内嵌段 / 后段"三个键：那等于把英文和中文的语序各钉一次，两段翻译各自
 * 成立、拼起来未必成立。整句一个键 + 一个占位符，语言自己决定那一段落在哪里。
 */
export function splitOn(sentence: string, inner: string): [string, string, string] {
  const at = sentence.indexOf(inner)
  if (at < 0) return [sentence, '', '']
  return [sentence.slice(0, at), inner, sentence.slice(at + inner.length)]
}
