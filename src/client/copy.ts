/**
 * 界面文案与宿主 locale 服务的接入。
 *
 * - zh 是完整真源，en 逐键镜像。
 * - locale 服务通过 ctx.get('locale') 可选读，服务缺席时退回内置 zh；为什么不进 inject 见
 *   docs/architecture.md §3。
 * - 面板行名传 thunk，语言切换时宿主会重读；其余文案走 t(key, params)。
 * - 渠道错误原文（src/client/receipt.ts 的 missing-id/幂等空值、src/client/remote.ts 的取数通道错误）
 *   不在此字典，它们是协议诊断，固定中文。
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

  'panel.tabs.label': '面板档位',
  'trash.title': '回收站',
  'trash.loading': '正在读回收站…',
  'trash.readFailed': '回收站读不到',
  'trash.empty.title': '回收站是空的',
  'trash.empty.hint': '在会话条目的「…」菜单里选「删除」，会话会先进到这里，随时可以恢复。',
  'trash.summary': '{count} 个会话 · 可释放 {size}',
  'trash.project.unknown': '未记录项目',
  'trash.row.deletedNow': '刚刚删除',
  'trash.row.deletedAgo': '删除于 {n}{unit}前',
  'trash.row.subagents': '含 {n} 个子会话',
  'trash.row.strandedSubagents': '盘上还剩 {n} 个子会话',
  // 删除时记下的工作区已经不在账本里（宿主的「删除工作区」只删注册、保留日志）：
  // 恢复照常回盘，但会落在「未分组」——清单的分组本身就是去向的说明；这句话只留给批量恢复
  // 确认框逐条说，行上不再重复。
  'trash.row.workspaceGone': '原工作区已不存在，恢复后归入未分组',
  'trash.unit.minutes': '分钟',
  'trash.unit.hours': '小时',
  'trash.unit.days': '天',
  'trash.unit.months': '个月',
  'trash.unit.years': '年',
  'trash.row.restore': '恢复',
  'trash.row.purge': '彻底删除',
  // 图标按钮的可及名要带对象：清单里每一行都有一颗「彻底删除」，只报动作会与确认框那颗同名。
  'trash.row.purgeOne': '彻底删除「{title}」',
  'trash.footer.note': '回收站本体在宿主数据根下的 {dir} 里，不自动过期；清空后不可恢复。',
  'trash.emptyAll': '清空回收站…',
  'trash.confirm.all': '清空回收站？',
  'trash.confirm.one': '彻底删除 1 个会话？',
  'trash.confirm.one.meta': '{project} · 删除于 {at} · {size}',
  // 只清 `.dsh` 里的副本与这些会话自己的缓存记录：用户磁盘上的原图/原文件不进任何删除链路
  // （`src/trash/attachments.ts` 的两条红线；缓存判据住 `src/trash/projection-cache.ts`）。
  'trash.confirm.body':
    '这会从回收站移除文件，{strong}。只清理会话独占的图片附件副本（共享副本保留）；这些会话自己的投影缓存记录也会一并清理，其他会话的缓存与你磁盘上的原图不受影响。',
  'trash.confirm.body.strong': '之后没有任何副本可以恢复',
  'trash.confirm.purge': '彻底删除',

  // 两档共用的清单文案（回收站档与归档档读同一份键）：组头计数与折叠、分栏把手、整组勾选。
  // 「条目」专属的那几句仍留在 `trash.*`——共用键不许带档名（CONTEXT 的「条目」专指回收站一行）。
  'list.group.count': '{count} 个会话',
  'list.group.ungrouped': '未分组',
  'list.group.collapseAll': '全部折叠',
  'list.group.expandAll': '全部展开',
  'list.divider.label': '调整左右分栏宽度',
  'list.select.group': '勾选「{project}」这 {count} 条会话',

  // 多选态的入口与读数（两档 + 宿主侧栏的浮条与菜单共用这一份）。批量恢复与批量彻底删除
  // 那两句是回收站专属，归档档的对应两句在 `archive.select.*`。恢复是加法，但一批条目多，
  // 去向是各自的原项目目录，点之前也要过一道确认框。单行恢复仍直接执行。
  'list.select.enter': '多选',
  'list.select.exit': '退出多选',
  'list.select.count': '已选 {count} 条',
  'list.select.needOne': '先勾选要处理的会话',
  'trash.select.purge': '彻底删除 {count} 条',
  'trash.select.restore': '恢复 {count} 条',
  'trash.select.row': '勾选「{title}」',
  'trash.confirm.bulk': '彻底删除 {count} 个会话？',
  'trash.confirm.restore': '恢复 {count} 个会话？',
  'trash.confirm.restore.body': '这一批会回到它们各自的原项目目录，恢复到会话列表里。',
  'trash.confirm.restoreNow': '恢复',

  // 回收站之外的无主子会话。父会话既不在宿主语料也不在清册里，它的孩子
  // 就没人再列、也没人能删——宿主客户端把 `origin:"subagent"` 整排藏掉了，所以这一格
  // 只能由我们报出来。**清理走 `/apply` 的 `orphan-clean`**，回执按组：`not-found` 单列「已不在了」，
  // 真失败可能带部分回执（已删目录数/字节）；这里不写"整组已清完"这种服务端没说的话。
  'trash.orphans.banner': '回收站之外发现 {count} 个无主子会话',
  'trash.orphans.meta': '共 {size}，来自 {parents} 个失踪的父会话',
  'trash.orphans.open': '查看并清理',
  'trash.orphans.confirm': '清理 {count} 个无主子会话？',
  'trash.orphans.body':
    '这些子会话的父会话已经不在会话列表或回收站里，清理后不可恢复。正在运行的子会话会被拒绝，不会被删除。只清理会话独占的图片附件副本（共享副本保留）与这些会话自己的投影缓存记录；其他会话的缓存与你磁盘上的原图不受影响。若剩余引用源读不出，本次附件清理会跳过（会话目录仍会删除）。',
  'trash.orphans.group': '{project} · {count} 个 · {size}',
  'trash.orphans.cacheNote': '本次会一并清理会话独占的图片附件副本与这些会话自己的投影缓存记录；其他会话的缓存不受影响。若剩余引用源读不出，本次附件清理会跳过（会话目录仍会删除）。',
  'trash.orphans.clean': '清理',
  'trash.orphans.failure': '残留检查/清理失败：{message}',
  'trash.orphans.cleanFailed': '{count} 组未清理：{message}',
  'trash.orphans.cleanPartial': '已先删掉 {removed} 个会话目录（{size}）',
  'trash.orphans.cleanGone': '有 {count} 组已不在了（可能已被别处清理，或父会话已恢复）',
  // 删除/清空回执里的附件那半句（面板与维护卡共用同一判据，读法住 `receipt.ts`）。跳过不是失败：
  // `skipped` 说的是
  // "有候选或剩余引用源读不出，这一轮部分或整体没敢清"（原因上屏），`failed` 是逐文件真出错的那几件；
  // 两个数分开说，不合并。`skipped` 而 `removed > 0` 时说「部分」：那一轮清掉了 `removed` 件，
  // 不冒充"整轮没清"。`skipped` 与 `failed` 同时出现时，失败件数追加在跳过句尾（前缀带分隔符）。
  'trash.attachments.failed': '已删除会话，但 {count} 个附件未能清理',
  'trash.attachments.skipped': '附件未清理：{reason}',
  'trash.attachments.skippedPartial': '部分附件未清理：{reason}（已清理 {removed} 个）',
  'trash.attachments.alsoFailed': '；另有 {count} 个附件删除失败',

  // 插件设置页的「可调项」卡：读是空体 POST，写走宿主 configEditor（这一行会重启）。
  'config.title': '可调项',
  'config.hint':
    '保存后插件会重启；本页用保存回执回填，重开本页会重新读取。也可以直接改 profile 的 cordis.patch.yml。',
  'config.orphanPreviewLimit': '孤儿附件预览条数',
  'config.maxAttachmentBytes': '附件单次响应上限',
  'config.maxJsonRefBytes': '附件引用扫描的单 JSON 上限',
  'config.unit.items': '条',
  'config.unit.bytes': '字节',
  'config.loading': '正在读当前值…',
  'config.loadFailed': '读取失败：{message}',
  'config.save': '保存',
  'config.saving': '保存中…',
  'config.saved': '已保存；插件正在重启。',
  'config.saveFailed': '保存失败：{message}',
  'config.retry': '重试',
  'config.invalid': '需为 {min}–{max} 的整数',
  'config.unchanged': '没有改动',

  // 插件设置页的「维护」卡：三段都是手动触发（检查 → 预览 → 清理），没有自动扫描也没有定时器。
  // 状态行六档：尚未检查 / 检查中 / 清理中 / 检查失败 / 没有发现 / N——在飞的动作优先于一切，
  // 检查/清理失败优先于「尚未检查」（失败不是"还没查"）。孤儿会话段复用 `trash.orphans.*` 的呈现文案，
  // 清理回执里的附件读数复用 `trash.attachments.skipped*` 那对句子；孤儿附件段的确认句必须把三条
  // 边界说完（只清 `.dsh` 内无引用图片副本、源文件不动、共享引用保留）；投影缓存段只念条数。
  'maintenance.title': '维护',
  'maintenance.orphans.title': '孤儿会话',
  'maintenance.orphans.hint': '父会话已不在会话列表或回收站里的子会话。检查只读，不会自动运行。',
  'maintenance.attachments.title': '孤儿附件',
  'maintenance.attachments.hint': '在 .dsh 里没有任何引用的图片副本。检查只读，清理只动这些副本。',
  'maintenance.scan': '检查',
  'maintenance.scanning': '检查中…',
  'maintenance.cleaning': '清理中…',
  'maintenance.checkFailed': '检查失败',
  'maintenance.notScanned': '尚未检查',
  'maintenance.none': '没有发现',
  'maintenance.orphans.count': '{count} 个',
  'maintenance.attachments.count': '{count} 个',
  'maintenance.attachments.scanFailed': '检查失败：{message}',
  'maintenance.attachments.cleaned': '已清理 {count} 个（{size}）',
  'maintenance.attachments.cleanFailed': '{count} 个附件未能清理（已清理 {removed} 个）',
  // 顶层失败（没拿到回执）没有"件数"可说：本地化前缀 + 服务端原文，不把原文裸着上屏。
  'maintenance.attachments.cleanError': '附件清理失败：{message}',
  'maintenance.attachments.confirm': '查看并清理 {count} 个孤儿附件？',
  'maintenance.attachments.body': '只清理 .dsh 内无引用的图片副本；源文件不受影响；共享引用保留。',
  'maintenance.attachments.previewTruncated': '仅预览前 {shown} 个；清理会处理全部 {total} 个。',
  'maintenance.attachments.previewHint': '点图片可放大；关闭这个框不会删除任何东西。',
  'maintenance.attachments.clean': '清理这些附件',
  // 投影缓存段：宿主的派生数据，只清「已经找不到会话」的记录；会话本体、清册与附件都不动。
  'maintenance.projection.title': '投影缓存',
  'maintenance.projection.hint': '宿主 session_projcache 里已经找不到对应会话或回收站条目的记录。检查只读，清理只动这些派生记录。',
  'maintenance.projection.count': '{count} 条',
  'maintenance.projection.found': '发现 {count} 条没有对应会话的投影缓存记录',
  'maintenance.projection.scanFailed': '检查失败：{message}',
  'maintenance.projection.confirm': '清理 {count} 条投影缓存记录？',
  'maintenance.projection.body': '这些是宿主会话投影的派生缓存；清理不会动会话本体、清册或附件。',
  'maintenance.projection.clean': '清理这些记录',
  'maintenance.projection.cleaned': '已清理 {count} 条投影缓存记录',
  'maintenance.projection.cleanFailed': '{count} 条投影缓存记录未能清理（已清理 {removed} 条）',
  'maintenance.projection.cleanError': '投影缓存清理失败：{message}',

  // 详情那一层（docs/ui-spec.md）。键前缀与 `trash.` 分开：那是清单的，这是单条的。
  'detail.notSelected': '选中一条会话，看它讲了什么',
  'detail.loading': '正在读这条会话…',
  'detail.readFailed': '这条会话的正文读不出来',
  'detail.noBody': '这条会话没有可显示的内容',
  'detail.field.created': '创建',
  'detail.field.lastActivity': '最后活动',
  'detail.field.span': '活跃跨度',
  'detail.field.size': '大小',
  'detail.field.turns': '轮数',
  'detail.field.userMessages': '提问',
  'detail.field.assistantMessages': '助手消息',
  'detail.field.toolCalls': '工具调用',
  'detail.field.injections': '注入上下文',
  'detail.field.models': '模型',
  'detail.field.project': '项目',
  'detail.field.sessionId': '会话 id',
  'detail.field.trashDir': '回收站目录',
  'detail.field.wasArchived': '原本归档',
  'archive.unnamed': '未命名 · {id}',
  'archive.tab': '归档',
  'archive.summary': '{count} 个已归档会话 · 合计 {size}',
  'archive.summary.missingSize': ' · {count} 条大小缺席',
  'archive.loading': '正在读归档…',
  'archive.readFailed': '归档读不到',
  'archive.empty.title': '没有已归档的会话',
  'archive.empty.hint': '在宿主会话列表里归档的会话会出现在这里。',
  'archive.corpusMissing.title': '语料不可见',
  'archive.corpusMissing.hint': '宿主的会话查询服务不可用，归档清单读不出来。',
  'archive.row.lastActivity': '最后活动',
  'archive.row.created': '创建于',
  'archive.row.timeAbsent': '时间未知',
  'archive.row.unarchive': '解除归档',
  'archive.row.delete': '删除',
  'archive.row.subagent': '子代理',
  // 行右那颗垃圾桶画的是「删除」，可恢复这件事要说出口：与回收站档同位置的图标（彻底删除）不是一个后果。
  'archive.row.deleteHint': '删除后进入回收站，可恢复。',
  'archive.select.unarchive': '解除所选 {count} 条',
  'archive.select.delete': '删除所选 {count} 条',
  'archive.size.absent': '—',
  'archive.detail.lastEvent': '日志末条',
  'archive.detail.statusLabel': '状态',
  'archive.detail.status': '已归档',
  'archive.detail.statusChild': '随归档父会话查看',
  'archive.subagents.note': '子会话随归档父会话只读查看；它们不会随之归档或取消归档。',
  'undo.movedArchived': '{title} 已移入回收站；撤销后回到「归档」',
  'undo.movedBatchArchived': '{n} 条会话已移入回收站；其中已归档的，撤销后回到「归档」',
  'detail.value.yes': '是',
  'detail.value.no': '否',
  'detail.value.spanLessThanHour': '不足 1 小时',
  'detail.value.spanHours': '{n} 小时',
  'detail.value.spanDays': '{n} 天',
  'detail.block.reasoning': '思考',
  'detail.block.tool': '工具调用',
  'detail.block.injection': '上下文注入',
  'detail.block.system': '系统消息',
  'detail.block.compaction': '上下文已压缩',
  'detail.block.args': '参数',
  'detail.block.result': '结果',
  'detail.block.noResult': '日志在调用结束前结束，没有结果',
  'detail.block.status.ok': '成功',
  'detail.block.status.error': '失败',
  'detail.block.status.unfinished': '未完成',
  'detail.block.truncated': '已截断',
  'detail.loadOlder': '加载更早',
  'detail.loadOlder.loading': '正在加载更早…',
  /** 提问轨（详情右缘那道常驻刻度）：一句用户提问一格，点一格跳到那句。 */
  'detail.rail.label': '提问导航',
  'detail.rail.jump': '跳到第 {n} 句提问：{preview}',
  'detail.rail.jumpUntitled': '跳到第 {n} 句提问',
  'detail.rail.position': '第 {n} / {total} 句',
  'detail.rail.hint': '点一下跳到这一句',
  'detail.rail.hintPending': '点一下跳到这一句，会先补页',
  'detail.rail.tooFar': '这句离现在太远，先点更近的一条。',
  'detail.viewMode.label': '工作步骤展示',
  'detail.viewMode.compact': '简洁',
  'detail.viewMode.standard': '标准',
  'detail.viewMode.detailed': '详细',
  'detail.viewMode.verbose': '完全展开',
  'detail.compact.empty': '这段会话只有过程内容；切到「标准」可以看到。',
  'detail.compact.pageOnly': '这一页只有过程内容；点「加载更早」继续往前看。',
  'detail.process.header': '工作步骤',
  'detail.process.step': '{n} 步',
  'detail.process.steps': '{n} 步',
  'detail.injection.runtimeContext': '运行上下文',
  'detail.injection.timeContext': '时间上下文',
  'detail.injection.agentInstructions': 'Agent 指令',
  'detail.injection.skillCatalog': '技能目录',
  'detail.injection.agentMessage': '子会话消息',
  'detail.injection.subagentSettled': '子会话结束',
  'detail.injection.toolJobs': '后台任务',
  'detail.injection.skillInvocation': '技能调用',
  'detail.injection.userApproval': '用户批准',
  'detail.injection.goal': '目标',
  'detail.injection.other': '其他上下文',
  'detail.image': '[图片]',
  'detail.image.alt': '[图片 · {alt}]',
  // 附件条（`src/client/attachment-view.tsx`）：空名用「文件」兜底；放大框标题优先用文件名。
  'detail.attachment.file': '文件',
  'detail.attachment.preview': '附件预览',
  'detail.attachment.alt': '附件图片',
  'detail.attachment.open': '打开图片「{name}」',
  'detail.attachment.unavailable': '附件不可用',
  'detail.attachment.save': '另存为',
  'detail.attachment.saving': '保存中…',
  'detail.attachment.saveFailed': '保存失败：{message}',
  'detail.back': '← 返回清单',
  'detail.subagents.label': '子会话',
  'detail.subagents.note': '随本条一起恢复或删除',
  'detail.subagents.expand': '展开子会话列表',
  'detail.subagents.collapse': '收起子会话列表',
  'detail.subagents.jump': '展开并跳到子会话段',
  'detail.subagents.open': '查看子会话详情',
  'detail.subagents.truncated': '仅列出前 {shown} 条，共 {total} 条',
  'detail.backToParent': '← 返回父会话',
  'detail.list.label': '回收站清单',
  'detail.role.user': '你',
  'detail.role.assistant': '助手',

  'menu.delete': '删除',
  'menu.live': '会话正在运行，先停止再删除',
  // 0.2.2+ 数据动作没有 disabledReason：禁用时直接把这个短句当 label。
  'menu.deleteLive': '删除（运行中）',

  'dialog.title': '删除这个会话？',
  'dialog.subagents': '含 {n} 个子会话，将一起移入回收站。',
  'dialog.hint': '会话会移入回收站，之后可以随时恢复。彻底删除是回收站里的另一个动作。',
  'dialog.confirm': '移入回收站',

  // 宿主列表批量删除。子会话那两句**复用** `trash.row.subagents`（行内 chip）与
  // `dialog.subagents`（汇总），n=1 的标题复用 `dialog.title`，运行中原因复用 `menu.live`，
  // 「多选/退出多选」复用清单那两句 `list.select.enter` / `list.select.exit`——不造第二句。
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
  // 逐条失败且不止一条：条数 + 各条原因（去重后由调用方拼进 {reasons}）——只显第一条会把其余原因折没。
  'undo.failedBatch': '{n} 条会话未能撤销：{reasons}',
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

  'panel.tabs.label': 'Panel views',
  'trash.title': 'Trash',
  'trash.loading': 'Reading the trash…',
  'trash.readFailed': 'Could not read the trash',
  'trash.empty.title': 'The trash is empty',
  'trash.empty.hint':
    'Pick Delete in a session’s “…” menu; the session lands here first and can be restored at any time.',
  'trash.summary': '{count} sessions · {size} reclaimable',
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
  'trash.row.purge': 'Delete permanently',
  'trash.row.purgeOne': 'Delete “{title}” permanently',
  'trash.footer.note':
    'The trash itself lives under the host data root in {dir}; it never expires on its own, and emptying it cannot be undone.',
  'trash.emptyAll': 'Empty the trash…',
  'trash.confirm.all': 'Empty the trash?',
  'trash.confirm.one': 'Delete this session permanently?',
  'trash.confirm.one.meta': '{project} · deleted {at} · {size}',
  'trash.confirm.body':
    'This removes the files from the trash; {strong}. Only session-exclusive image attachment copies are cleaned (shared copies are kept); these sessions’ own projection-cache records are cleaned up too, while other sessions’ caches and your original files are untouched.',
  'trash.confirm.body.strong': 'no copy remains to restore it',
  'trash.confirm.purge': 'Delete permanently',

  'list.group.count': '{count} sessions',
  'list.group.ungrouped': 'Ungrouped',
  'list.group.collapseAll': 'Collapse all',
  'list.group.expandAll': 'Expand all',
  'list.divider.label': 'Adjust the width of the list column',
  'list.select.group': 'Select all {count} sessions under “{project}”',

  'list.select.enter': 'Select',
  'list.select.exit': 'Done selecting',
  'list.select.count': '{count} selected',
  'list.select.needOne': 'Pick the sessions to work on first',
  'trash.select.purge': 'Delete {count} permanently',
  'trash.select.restore': 'Restore {count}',
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
  'trash.orphans.body':
    'Their parent sessions are no longer in the session list or the trash; this cannot be undone. Running sessions are refused and left untouched. Only session-exclusive image attachment copies are cleaned (shared copies are kept), together with these sessions’ own projection-cache records; other sessions’ caches and your original files are untouched. If a remaining reference source cannot be read, attachment cleanup is skipped for that run (session directories are still deleted).',
  'trash.orphans.group': '{project} · {count} sessions · {size}',
  'trash.orphans.cacheNote':
    'Session-exclusive image attachment copies inside .dsh and these sessions’ own projection-cache records are cleaned as well; other sessions’ caches are untouched. If a remaining reference source cannot be read, attachment cleanup is skipped for that run (session directories are still deleted).',
  'trash.orphans.clean': 'Clean',
  'trash.orphans.failure': 'Orphan check/cleanup failed: {message}',
  'trash.orphans.cleanFailed': '{count} groups were not cleaned: {message}',
  'trash.orphans.cleanPartial': 'Removed {removed} session directories first ({size})',
  'trash.orphans.cleanGone': '{count} groups were already gone (cleaned elsewhere or their parent was restored)',
  'trash.attachments.failed': 'Sessions were deleted, but {count} attachments could not be cleaned',
  'trash.attachments.skipped': 'Attachments were not cleaned: {reason}',
  'trash.attachments.skippedPartial': 'Some attachments were not cleaned: {reason} ({removed} cleaned)',
  'trash.attachments.alsoFailed': '; also {count} attachment deletions failed',

  'config.title': 'Options',
  'config.hint':
    'Saving restarts the plugin. This card fills in from the save receipt; reopening this page reads the values again. You can also edit the profile cordis.patch.yml.',
  'config.orphanPreviewLimit': 'Orphan attachment preview limit',
  'config.maxAttachmentBytes': 'Attachment response limit',
  'config.maxJsonRefBytes': 'Per-JSON reference scan limit',
  'config.unit.items': 'items',
  'config.unit.bytes': 'bytes',
  'config.loading': 'Reading current values…',
  'config.loadFailed': 'Could not read: {message}',
  'config.save': 'Save',
  'config.saving': 'Saving…',
  'config.saved': 'Saved; the plugin is restarting.',
  'config.saveFailed': 'Could not save: {message}',
  'config.retry': 'Retry',
  'config.invalid': 'Must be an integer from {min} to {max}',
  'config.unchanged': 'No changes',

  'maintenance.title': 'Maintenance',
  'maintenance.orphans.title': 'Orphan sessions',
  'maintenance.orphans.hint':
    'Subagent sessions whose parent is no longer in the session list or the trash. Checking only reads; it never runs automatically.',
  'maintenance.attachments.title': 'Orphan attachments',
  'maintenance.attachments.hint':
    'Image copies inside .dsh that nothing references. Checking only reads; cleanup touches only these copies.',
  'maintenance.scan': 'Check',
  'maintenance.scanning': 'Checking…',
  'maintenance.cleaning': 'Cleaning…',
  'maintenance.checkFailed': 'Check failed',
  'maintenance.notScanned': 'Not checked yet',
  'maintenance.none': 'Nothing found',
  'maintenance.orphans.count': '{count}',
  'maintenance.attachments.count': '{count}',
  'maintenance.attachments.scanFailed': 'Check failed: {message}',
  'maintenance.attachments.cleaned': 'Cleaned {count} ({size})',
  'maintenance.attachments.cleanFailed': '{count} attachments could not be cleaned ({removed} cleaned)',
  'maintenance.attachments.cleanError': 'Attachment cleanup failed: {message}',
  'maintenance.attachments.confirm': 'Review and clean {count} orphan attachments?',
  'maintenance.attachments.body':
    'Only unreferenced image copies inside .dsh are cleaned; source files are untouched; shared references are kept.',
  'maintenance.attachments.previewTruncated':
    'Only the first {shown} are previewed; cleanup handles all {total}.',
  'maintenance.attachments.previewHint': 'Click an image to enlarge it; closing this dialog deletes nothing.',
  'maintenance.attachments.clean': 'Clean these attachments',
  'maintenance.projection.title': 'Projection cache',
  'maintenance.projection.hint':
    'Records in the host session_projcache with no matching session or trash entry. Checking only reads; cleanup touches only these derived records.',
  'maintenance.projection.count': '{count}',
  'maintenance.projection.found': 'Found {count} projection-cache records with no matching session',
  'maintenance.projection.scanFailed': 'Check failed: {message}',
  'maintenance.projection.confirm': 'Clean {count} projection-cache records?',
  'maintenance.projection.body':
    'These are derived projection caches; cleanup does not touch sessions, the trash ledger, or attachments.',
  'maintenance.projection.clean': 'Clean these records',
  'maintenance.projection.cleaned': 'Cleaned {count} projection-cache records',
  'maintenance.projection.cleanFailed': '{count} projection-cache records could not be cleaned ({removed} cleaned)',
  'maintenance.projection.cleanError': 'Projection-cache cleanup failed: {message}',

  'detail.notSelected': 'Select a session to see what it was about',
  'detail.loading': 'Reading this session…',
  'detail.readFailed': 'Could not read this session’s log',
  'detail.noBody': 'This session has nothing to show',
  'detail.field.created': 'Created',
  'detail.field.lastActivity': 'Last activity',
  'detail.field.span': 'Active for',
  'detail.field.size': 'Size',
  'detail.field.turns': 'Turns',
  'detail.field.userMessages': 'Prompts',
  'detail.field.assistantMessages': 'Assistant messages',
  'detail.field.toolCalls': 'Tool calls',
  'detail.field.injections': 'Injected contexts',
  'detail.field.models': 'Model',
  'detail.field.project': 'Project',
  'detail.field.sessionId': 'Session id',
  'detail.field.trashDir': 'Trash folder',
  'detail.field.wasArchived': 'Was archived',
  'archive.unnamed': 'Untitled · {id}',
  'archive.tab': 'Archive',
  'archive.summary': '{count} archived sessions · {size} total',
  'archive.summary.missingSize': ' · {count} without size',
  'archive.loading': 'Loading archive…',
  'archive.readFailed': 'Archive unavailable',
  'archive.empty.title': 'No archived sessions',
  'archive.empty.hint': 'Sessions archived in the host session list appear here.',
  'archive.corpusMissing.title': 'Corpus not visible',
  'archive.corpusMissing.hint': 'The host session-query service is unavailable; the archive list cannot be read.',
  'archive.row.lastActivity': 'Last active',
  'archive.row.created': 'Created',
  'archive.row.timeAbsent': 'Time unknown',
  'archive.row.unarchive': 'Unarchive',
  'archive.row.delete': 'Delete',
  'archive.row.subagent': 'Subagent',
  'archive.row.deleteHint': 'Deletion moves it to the trash; restorable.',
  'archive.select.unarchive': 'Unarchive {count} selected',
  'archive.select.delete': 'Delete {count} selected',
  'archive.size.absent': '—',
  'archive.detail.lastEvent': 'Last log event',
  'archive.detail.statusLabel': 'Status',
  'archive.detail.status': 'Archived',
  'archive.detail.statusChild': 'Read-only via archived parent',
  'archive.subagents.note': 'Subagents of an archived session open here read-only; they are not archived or unarchived with the parent.',
  'undo.movedArchived': '{title} was moved to the trash; undo returns it to Archive',
  'undo.movedBatchArchived': '{n} sessions were moved to the trash; archived ones return to Archive on undo',
  'detail.value.yes': 'Yes',
  'detail.value.no': 'No',
  'detail.value.spanLessThanHour': '< 1 h',
  'detail.value.spanHours': '{n} h',
  'detail.value.spanDays': '{n} d',
  'detail.block.reasoning': 'Thinking',
  'detail.block.tool': 'Tool call',
  'detail.block.injection': 'Context injection',
  'detail.block.system': 'System message',
  'detail.block.compaction': 'Context compacted',
  'detail.block.args': 'Arguments',
  'detail.block.result': 'Result',
  'detail.block.noResult': 'The log ended before this call returned a result',
  'detail.block.status.ok': 'OK',
  'detail.block.status.error': 'Failed',
  'detail.block.status.unfinished': 'Unfinished',
  'detail.block.truncated': 'Truncated',
  'detail.loadOlder': 'Load earlier',
  'detail.loadOlder.loading': 'Loading earlier…',
  'detail.rail.label': 'Question navigation',
  'detail.rail.jump': 'Jump to question {n}: {preview}',
  'detail.rail.jumpUntitled': 'Jump to question {n}',
  'detail.rail.position': 'Question {n} / {total}',
  'detail.rail.hint': 'Click to jump here',
  'detail.rail.hintPending': 'Click to jump here; earlier pages load first',
  'detail.rail.tooFar': 'That question is too far back. Pick a nearer one first.',
  'detail.viewMode.label': 'Work steps',
  'detail.viewMode.compact': 'Compact',
  'detail.viewMode.standard': 'Standard',
  'detail.viewMode.detailed': 'Detailed',
  'detail.viewMode.verbose': 'Verbose',
  'detail.compact.empty': 'This session has only process content; switch to “Standard” to see it.',
  'detail.compact.pageOnly': 'Only process content on this page; choose “Load earlier” to keep looking.',
  'detail.process.header': 'Work steps',
  'detail.process.step': '{n} step',
  'detail.process.steps': '{n} steps',
  'detail.injection.runtimeContext': 'Runtime context',
  'detail.injection.timeContext': 'Time context',
  'detail.injection.agentInstructions': 'Agent instructions',
  'detail.injection.skillCatalog': 'Skill catalog',
  'detail.injection.agentMessage': 'Subagent message',
  'detail.injection.subagentSettled': 'Subagent finished',
  'detail.injection.toolJobs': 'Background jobs',
  'detail.injection.skillInvocation': 'Skill invocation',
  'detail.injection.userApproval': 'User approval',
  'detail.injection.goal': 'Goal',
  'detail.injection.other': 'Other context',
  'detail.image': '[Image]',
  'detail.image.alt': '[Image · {alt}]',
  'detail.attachment.file': 'File',
  'detail.attachment.preview': 'Attachment preview',
  'detail.attachment.alt': 'Attachment image',
  'detail.attachment.open': 'Open image “{name}”',
  'detail.attachment.unavailable': 'Attachment unavailable',
  'detail.attachment.save': 'Save as',
  'detail.attachment.saving': 'Saving…',
  'detail.attachment.saveFailed': 'Save failed: {message}',
  'detail.back': '← Back to list',
  'detail.subagents.label': 'Subagent sessions',
  'detail.subagents.note': 'Restored or deleted with this session',
  'detail.subagents.expand': 'Expand subagent sessions',
  'detail.subagents.collapse': 'Collapse subagent sessions',
  'detail.subagents.jump': 'Expand and jump to subagent sessions',
  'detail.subagents.open': 'Open subagent session',
  'detail.subagents.truncated': 'Showing the first {shown} of {total} subagent sessions',
  'detail.backToParent': '← Back to parent session',
  'detail.list.label': 'Trash list',
  'detail.role.user': 'You',
  'detail.role.assistant': 'Assistant',

  'menu.delete': 'Delete',
  'menu.live': 'This session is running. Stop it first.',
  'menu.deleteLive': 'Delete (running)',

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
  'undo.failedBatch': '{n} sessions could not be undone: {reasons}',
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

/** 探测宿主 locale 服务：缺席 / `ctx.get` 抛错都回 `undefined`，不往上抛。 */
function detectLocaleService(ctx: ClientContextLike): LocaleServiceLike | undefined {
  try {
    const found = ctx.get?.('locale')
    return found == null ? undefined : (found as LocaleServiceLike)
  } catch {
    return undefined
  }
}

/**
 * 注册字典并交回本插件的 `t`。服务不在时返回 `zhTranslate`（不抛、不 pending）。
 *
 * **空值判据同时认 `undefined` 与 `null`**：宿主 `ctx.get` 可以回 null（同一条窄镜像的读法见
 * `main-view.ts` 的 `isReadyUiWorkspace`）。这里只判 `undefined` 的版本会把 null 当成"服务在"，
 * 下一句 `service.register` 抛错——而本函数跑在**任何槽位注册之前**，抛出去等于整个客户端条目
 * 从页面消失（`apply` 只打一条 warn）。注册 / 绑定自身失败同样退回内置 zh：文案降级远好过没有插件。
 * `bind` 在注册之后才跑，它失败时字典已挂上但没人用——留着无害（宿主只是多一份不用的词典），
 * 不为它补撤销路径再引入新的失败面。
 *
 * 注册必须挂在 `ctx.effect` 上：`register` 返回的 disposer 是**官方契约**（卸载时要把字典摘掉），
 * 而且同一命名空间的同一语言**只能注册一次**——effect 没挂，HMR 重挂就撞 "already has locale"。
 */
export function createTranslate(ctx: ClientContextLike): Translate {
  const service = detectLocaleService(ctx)
  if (service === undefined) return zhTranslate
  try {
    ctx.effect(() => service.register(COPY_NS, { zh: ZH, en: EN }), 'session-delete: copy dictionaries')
    const bound = service.bind(COPY_NS)
    return (key, params) => bound(key, params)
  } catch (error) {
    console.warn('[dsh-session-delete] locale 服务不可用，退回内置中文：', error)
    return zhTranslate
  }
}

/**
 * `MarkdownBody`（`markdown.tsx`）memo comparator 的**语言探针**：借一句固定键的译文，当
 * 「当前是哪种语言」的读数。为什么借译文而不问 locale 服务：宿主 locale 服务的窄镜像不暴露
 * 当前语言（受窄镜像形状约束，不做 `locale()` 探针），当前语言只能从 `t` 的输出里读出来。
 *
 * 为什么必须在**渲染时**现算、由调用方存进 props：宿主 `t` 读的是**当前** locale，若在
 * comparator 里现调，prev/next 那一拍都取到新值、恒等，换语言就漏了——只有渲染那一刻算好的
 * 那份才是换语言那一拍的读数。
 *
 * 为什么拿 `t` 的输出当读数、而不是拿 `t` 的身份：宿主 `t` 是 `bind` 出来的**稳定身份**
 * （`createTranslate` 一次客户端激活只造一个），换语言后同一个 `t` 吐另一套词——身份不变、
 * 词变了，所以判据必须是这个词（探针值）而不是身份本身。
 *
 * 「借哪句」的知识只住这里：调用方与测试一律传 `probe={localeProbe(t)}`，不各自记得借哪句。
 *
 * **失效模式**：借的那句若在两种语言下译成同一个字面，探针就分不出换语言——memo 恒等、旧语言滞留。
 * 这条由 `tests/client/markdown.test.tsx` 的换语言用例兜住；换借句或改那句译文时先看它红不红。
 */
export function localeProbe(t: Translate): string {
  return t('common.close')
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
 * 绝对时间那一句串。清单行的 `title`、确认框里的meta、详情的会话信息三处要的是同一个写法，
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

/** 「工作步骤 N 步」：英文 n=1 要单数、中文两条同形；选哪条键只住这里，调用方只报数。 */
export function stepsText(n: number, t: Translate): string {
  return t(n === 1 ? 'detail.process.step' : 'detail.process.steps', { n })
}

/** 「7分钟前」这类**不带谓语**的相对短语；`now` 桶不套模板——"刚刚前"不是话。 */
export function agoText(at: number, now: number, t: Translate): string {
  const { unit, n } = relativeTime(at, now)
  return unit === 'now' ? t('common.justNow') : t('common.ago', { n, unit: unitWord(unit, t) })
}
