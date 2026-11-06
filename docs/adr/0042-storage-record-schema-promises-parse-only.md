# 清册记录 schema 只承诺 `valueSchema.parse`

Status: accepted

宿主 `@deepseek-ai/dsh-storage-domain` 的配方要求记录 schema 是 zod，但本仓不新增生产依赖；`src/trash/storage-manifest.ts` 用一个只实现 `parse` 的本地校验器传给 `storageDomain.open`。这不是本地风格选择：契约的另一半在宿主实现里，宿主换代可能让它失效，所以要有可复核的记录。

## 决定

1. 清册记录 schema 只提供 `parse`，字段表仍由 `REQUIRED_ENTRY_FIELDS` 生成，不手抄第二份。
2. `tests/assembly.test.ts` 钉住 `valueSchema` 的 own enumerable keys 恰好是 `['parse']`，并钉住 adapter 原样透传记录；这只证明本仓提供的面，不证明宿主换用 `safeParse` / `_def` / JSON Schema 投影时仍成立。
3. 宿主换代先跑真实 `storageDomain.open` 冒烟；复核项住 `docs/development.md` 的「宿主换代复核」。

## 边界

- 不把 zod 加进 `dependencies` 或 `devDependencies`；运行期行为不会因为换 zod 而改变，换来的只是更贴官方配方。
- 不改清册的记录形状、存储域名或 `invalid-records: backup-and-skip` 的语义（ADR-0012）。
- 不声称假存储域能证明宿主的调用面；那只能由真实宿主 smoke 回答。

## 后果

- 宿主若只认 zod 的其他面，清册域会在 `open` 时响亮失败；这是显式的升级门，不是静默降级。
- 记录 schema 的契约测试与真实宿主冒烟各管一段：前者防本仓自己加面，后者防宿主换代。

## 被否掉的替代

- **加 zod 作为 devDependency 并构建期内联**：运行期行为不变，新增依赖、构建期内联验证与骨架测试同步，收益只是更贴官方配方；本仓生产依赖必须为空，代价不成比例。
- **改用宿主 Schemastery**：值 import 宿主包，破「跨插件一律 `import type`」的硬约束。
- **只留代码注释与测试、不落 ADR**：注释与测试只能钉当前面，后来者仍要自己拼出「为什么不用 zod」和「宿主换代先验什么」。

锚点：`src/trash/storage-manifest.ts`；`tests/assembly.test.ts`；`docs/development.md`；`ADR-0012`。
