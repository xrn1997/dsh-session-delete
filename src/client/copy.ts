/**
 * 可见文案（界面标签与提示）＋接上宿主 Client locale 服务的那一步。
 *
 * **例外：渠道错误原文。** `src/client/receipt.ts` 的 missing-id、`src/client/remote.ts` 的
 * 幂等空值与取数通道错误是协议诊断原文，固定中文、不随 locale；它们不进本字典。
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
import { relativeTime, type RelativeTimeUnit } from './ui/format.js'
import type { ClientContextLike } from './context.js'

/** 本插件的文案命名空间（第三方必须自带前缀；官方占用的是 `common` / `settings` / `sidebar` 这些）。 */
const COPY_NS = 'xrn1997-session-delete'

/** zh 是真源；`en` 必须逐键齐全（宿主的对象形式注册会整体校验）。 */
const ZH = {
  'common.untitled': '(无标题会话)',
  'common.cancel': '取消',
  'common.close': '关闭',
  'common.justNow': '刚刚',
  'common.ago': '{n}{unit}前',
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
  'trash.row.subagents': '含 {n} 个子会话',
  'trash.row.strandedSubagents': '盘上还剩 {n} 个子会话',
  // 删除时记下的工作区已经不在账本里（宿主的「删除工作区」只删注册、保留日志）：
  // 恢复照常回盘，但会落在「未分组」——行上先说，别等它从清单里消失才发现换了地方。
  'trash.row.workspaceGone': '原工作区已不存在，恢复后归入未分组',
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

  // 清单那一排的视图开关（2026-10-15：组折叠 / 拖分栏）。「折叠」管组内（项目名那一行以下）。
  'trash.toolbar.collapseAll': '全部折叠',
  'trash.toolbar.expandAll': '全部展开',
  'trash.divider.label': '调整左右分栏宽度',
  'trash.select.group': '勾选「{project}」这 {count} 条会话',

  // 多选与批量动作（2026-10-15 开的口子先只有"批量彻底删除"；2026-10-17 按用户裁定加上"批量恢复"：
  // 恢复是加法，但一批条目多、去向是各自的旧项目目录，点之前也要过一道确认框——**批量**走框，
  // 单行那颗仍然直接执行）。
  'trash.toolbar.select': '多选',
  'trash.toolbar.selectExit': '退出多选',
  'trash.select.count': '已选 {count} 条',
  'trash.select.purge': '彻底删除 {count} 条',
  'trash.select.restore': '恢复 {count} 条',
  'trash.select.needOne': '先勾选要处理的会话',
  'trash.select.row': '勾选「{title}」',
  'trash.confirm.bulk': '彻底删除 {count} 个会话？',
  'trash.confirm.restore': '恢复 {count} 个会话？',
  'trash.confirm.restore.body': '这一批会回到它们各自的原项目目录，恢复到会话列表里。',
  'trash.confirm.restoreNow': '恢复',

  // 回收站之外的无主子会话（2026-10-19 那条维护入口）。父会话既不在宿主语料也不在清册里，它的孩子
  // 就没人再列、也没人能删——宿主客户端把 `origin:"subagent"` 整排藏掉了，所以这一格
  // 只能由我们报出来。**清理走 `/apply` 的 `orphan-clean`**，回执按组：`not-found` 单列「已不在了」，
  // 真失败可能带部分回执（已删目录数/字节）；这里不写"整组已清完"这种服务端没说的话。
  'trash.orphans.banner': '回收站之外发现 {count} 个无主子会话',
  'trash.orphans.meta': '共 {size}，来自 {parents} 个失踪的父会话',
  'trash.orphans.open': '查看并清理',
  'trash.orphans.confirm': '清理 {count} 个无主子会话？',
  'trash.orphans.body': '这些子会话的父会话已经不在会话列表或回收站里，清理后不可恢复。正在运行的子会话会被拒绝，不会被删除。',
  'trash.orphans.group': '{project} · {count} 个 · {size}',
  'trash.orphans.cacheNote': '本次只清理会话目录，不包含宿主投影缓存和附件。',
  'trash.orphans.clean': '清理',
  'trash.orphans.failure': '残留检查/清理失败：{message}',
  'trash.orphans.cleanFailed': '{count} 组未清理：{message}',
  'trash.orphans.cleanPartial': '已先删掉 {removed} 个会话目录（{size}）',
  'trash.orphans.cleanGone': '有 {count} 组已不在了（可能已被别处清理，或父会话已恢复）',

  // 详情那一层（docs/ui-spec.md）。键前缀与 `trash.` 分开：那是清单的，这是单条的。
  'detail.notSelected': '选中一条会话，看它讲了什么',
  'detail.loading': '正在读这条会话…',
  'detail.readFailed': '这条会话的正文读不出来',
  'detail.noBody': '这条会话没有可显示的文字',
  'detail.field.created': '创建',
  'detail.field.lastActivity': '最后活动',
  'detail.field.deletedAt': '删除于',
  'detail.field.span': '活跃跨度',
  'detail.field.size': '大小',
  'detail.field.turns': '轮数',
  'detail.field.userMessages': '提问',
  'detail.field.assistantMessages': '回复',
  'detail.field.toolCalls': '工具调用',
  'detail.field.models': '模型',
  'detail.field.project': '项目',
  'detail.field.sessionId': '会话 id',
  'detail.field.trashDir': '回收站目录',
  'detail.field.wasArchived': '原本归档',
  'detail.value.yes': '是',
  'detail.value.no': '否',
  'detail.value.spanHours': '{n} 小时',
  'detail.value.spanDays': '{n} 天',
  'detail.messages.hidden': '另有 {count} 条宿主注入的上下文未显示',
  'detail.messages.omitted': '还有 {count} 条未显示',
  'detail.back': '← 返回清单',
  'detail.list.label': '回收站清单',
  'detail.role.user': '你',
  'detail.role.assistant': '助手',

  'menu.delete': '删除',
  'menu.live': '会话正在运行，先停止再删除',

  'dialog.title': '删除这个会话？',
  'dialog.subagents': '含 {n} 个子会话，将一起移入回收站。',
  'dialog.hint': '会话会移入回收站，之后可以随时恢复。彻底删除是回收站里的另一个动作。',
  'dialog.confirm': '移入回收站',

  // 宿主列表批量删除（2026-10-17）。子会话那两句**复用** `trash.row.subagents`（行内 chip）与
  // `dialog.subagents`（汇总），n=1 的标题复用 `dialog.title`，运行中原因复用 `menu.live`，
  // 「多选/退出多选」复用回收站工具栏的 `trash.toolbar.select` / `selectExit`——不造第二句。
  'batch.row.pick': '勾选「{title}」以批量删除',
  'batch.bar.count': '已选 {n} 条',
  'batch.bar.pickHint': '点击会话行选择',
  'batch.bar.kids': '含 {k} 个子会话，跟着整组走',
  'batch.bar.review': '查看已选',
  'batch.bar.reviewClose': '收起已选',
  'batch.bar.remove': '取消勾选「{title}」',
  'batch.bar.selectAll': '全选',
  'batch.bar.selectNone': '取消全选',
  'batch.run': '移入回收站 {n} 条',
  'dialog.batch.title': '删除这些 {n} 个会话？',
  'dialog.batch.retry': '重试这 {n} 条',
  'undo.movedBatch': '{n} 条会话已移入回收站',

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
  'common.justNow': 'just now',
  'common.ago': '{n}{unit} ago',
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
  'trash.row.subagents': 'has {n} subagent sessions',
  'trash.row.strandedSubagents': '{n} subagent sessions still on disk',
  'trash.row.workspaceGone': 'Its workspace no longer exists; it will be restored under “Ungrouped”',
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

  'trash.toolbar.collapseAll': 'Collapse all',
  'trash.toolbar.expandAll': 'Expand all',
  'trash.divider.label': 'Adjust the width of the list column',
  'trash.select.group': 'Select all {count} sessions under “{project}”',

  'trash.toolbar.select': 'Select',
  'trash.toolbar.selectExit': 'Done selecting',
  'trash.select.count': '{count} selected',
  'trash.select.purge': 'Delete {count} permanently',
  'trash.select.restore': 'Restore {count}',
  'trash.select.needOne': 'Pick the sessions to work on first',
  'trash.select.row': 'Select “{title}”',
  'trash.confirm.bulk': 'Delete these {count} sessions permanently?',
  'trash.confirm.restore': 'Restore these {count} sessions?',
  'trash.confirm.restore.body': 'They go back to their original project folders and reappear in the session list.',
  'trash.confirm.restoreNow': 'Restore',

  // 与 zh 逐键同序。漏一个键由 `Record<CopyKey, string>` 直接编译不过，这段注释只负责两块读得对齐。
  'trash.orphans.banner': 'Found {count} orphan subagent sessions outside the trash',
  'trash.orphans.meta': '{size} total, from {parents} missing parent sessions',
  'trash.orphans.open': 'Review and clean',
  'trash.orphans.confirm': 'Clean {count} orphan subagent sessions?',
  'trash.orphans.body': 'Their parent sessions are no longer in the session list or the trash; this cannot be undone. Running sessions are refused and left untouched.',
  'trash.orphans.group': '{project} · {count} sessions · {size}',
  'trash.orphans.cacheNote': 'This cleans session directories only; host projection caches and attachments are not included.',
  'trash.orphans.clean': 'Clean',
  'trash.orphans.failure': 'Orphan check/cleanup failed: {message}',
  'trash.orphans.cleanFailed': '{count} groups were not cleaned: {message}',
  'trash.orphans.cleanPartial': 'Removed {removed} session directories first ({size})',
  'trash.orphans.cleanGone': '{count} groups were already gone (cleaned elsewhere or their parent was restored)',

  'detail.notSelected': 'Select a session to see what it was about',
  'detail.loading': 'Reading this session…',
  'detail.readFailed': 'Could not read this session’s log',
  'detail.noBody': 'This session has no readable text',
  'detail.field.created': 'Created',
  'detail.field.lastActivity': 'Last activity',
  'detail.field.deletedAt': 'Deleted',
  'detail.field.span': 'Active for',
  'detail.field.size': 'Size',
  'detail.field.turns': 'Turns',
  'detail.field.userMessages': 'Prompts',
  'detail.field.assistantMessages': 'Replies',
  'detail.field.toolCalls': 'Tool calls',
  'detail.field.models': 'Model',
  'detail.field.project': 'Project',
  'detail.field.sessionId': 'Session id',
  'detail.field.trashDir': 'Trash folder',
  'detail.field.wasArchived': 'Was archived',
  'detail.value.yes': 'Yes',
  'detail.value.no': 'No',
  'detail.value.spanHours': '{n} h',
  'detail.value.spanDays': '{n} d',
  'detail.messages.hidden': '{count} injected context records not shown',
  'detail.messages.omitted': '{count} more messages not shown',
  'detail.back': '← Back to list',
  'detail.list.label': 'Trash list',
  'detail.role.user': 'You',
  'detail.role.assistant': 'Assistant',

  'menu.delete': 'Delete',
  'menu.live': 'This session is running. Stop it first.',

  'dialog.title': 'Delete this session?',
  'dialog.subagents': 'It also moves {n} subagent sessions to the trash.',
  'dialog.hint':
    'The session moves to the trash and can be restored at any time. Permanent deletion is a separate action in the trash.',
  'dialog.confirm': 'Move to trash',

  'batch.row.pick': 'Select “{title}” for batch delete',
  'batch.bar.count': '{n} selected',
  'batch.bar.pickHint': 'Click a session row to select',
  'batch.bar.kids': '{k} subagent sessions come along',
  'batch.bar.review': 'Review selected',
  'batch.bar.reviewClose': 'Hide list',
  'batch.bar.remove': 'Unselect “{title}”',
  'batch.bar.selectAll': 'Select all',
  'batch.bar.selectNone': 'Deselect all',
  'batch.run': 'Move {n} to trash',
  'dialog.batch.title': 'Delete these {n} sessions?',
  'dialog.batch.retry': 'Retry these {n}',
  'undo.movedBatch': '{n} sessions were moved to the trash',

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

/**
 * 绝对时间那一句串。清单行的 `title`、确认框里的meta、详情的元信息三处要的是同一个写法，
 * 各自 `new Date(...).toLocaleString()` 一遍迟早会漂成两种样子。
 */
export function absoluteText(at: number): string {
  return new Date(at).toLocaleString()
}

/**
 * 单位词的键（`relativeTime` 只交回桶与量 `{unit, n}`，措辞按它自己的约定留在字典里；
 * 数字与单位之间不空格是它的写法）。清单行与详情共用这一张表，别再各抄一份。
 */
const UNIT_KEY: Record<Exclude<RelativeTimeUnit, 'now'>, CopyKey> = {
  minutes: 'trash.unit.minutes',
  hours: 'trash.unit.hours',
  days: 'trash.unit.days',
  months: 'trash.unit.months',
  years: 'trash.unit.years',
}

/** 单位词本身（调用方把它填进各自语言的整句模板里，语序由各语言自己钉）。 */
export function unitWord(unit: RelativeTimeUnit, t: Translate): string {
  return unit === 'now' ? t('common.justNow') : t(UNIT_KEY[unit])
}

/** 「7分钟前」这类**不带谓语**的相对短语；`now` 桶不套模板——"刚刚前"不是话。 */
export function agoText(at: number, now: number, t: Translate): string {
  const { unit, n } = relativeTime(at, now)
  return unit === 'now' ? t('common.justNow') : t('common.ago', { n, unit: unitWord(unit, t) })
}
