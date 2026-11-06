# ADR-0044 — 第三方许可声明与 README 截图随包发布

Status: accepted

本包的图标形状、控件与 Markdown 样式逐字派生自宿主 MIT 许可的客户端包，`lib/client.js` 又内联了 `react-markdown` / `remark-gfm` 闭包；MIT 要求版权与许可声明随副本走。npm 包因此在代码之外再带两样非代码资产：`THIRD_PARTY_NOTICES.md` 与 `docs/screenshots/`。这一条翻掉了 0.6.1 发版时「移除随包第三方声明」的取舍。

## 背景

0.6.1 的发布校验改成「按 `files` 推导包内树」，同一批把 `THIRD_PARTY_NOTICES.md` 连同它的 `files` 行、README 段与骨架测试一起删了，理由是产物里的出处已经在各复制文件的头注里写死。头注确实说了「从哪来」，但它住在 `src/`，装进包的是 `lib/`：npm 上拿到副本的人看不见头注，MIT 那句「shall be included in all copies」就没有落实。README 的图片是另一件事：插件详情页把 README 当详情文档渲染，相对路径从**包内**读，截图不进包就是三张破图。

## 决定

1. **`THIRD_PARTY_NOTICES.md` 进 `files`**：它说清来源包、上游产物、本包落点与有意差异，再给 MIT / ISC 许可全文；README「许可」只指路，不复述内容。
2. **`docs/screenshots/` 进 `files`**：README 那几张真机图随包走，页面离线与私有 registry 下都不破图。
3. **`files` 仍是唯一精确清单**：随包每多一个非代码资产就在这里加一行；发布工作流从 `files` 推导包内树，不抄第二份名单（判据见 `docs/development.md` 的发版流程）。

## 边界

- 不改许可证本身：本包整体仍是 Apache-2.0，抄本继续受 MIT 约束这件事由声明说明，不由 `LICENSE` 改写。
- 不在源码头注之外另立出处清单：各副本的**有意差异**仍以文件头注为准，声明只汇总「从哪来、落到哪」。
- 不引第三方声明生成工具：名单是人手按 lockfile 核对的，读数来源见 `docs/development.md`。

## 后果

- `tests/skeleton.test.ts` 钉住声明进包、并核对它点名了来源、落点与两种许可（标题 + 版权行）；文件缺失或不入库就是测试红（不是构建红）。
- `docs/screenshots/*.png` 与这份声明进入发布产物，包体积随它们变大一点。
- 下一个版本的 `CHANGELOG.md` 要把「随包发布第三方声明」写进变更，因为这是对 0.6.1 那次移除的翻案。

## 被否掉的替代

- **只在源码头注留出处、不随包**：0.6.1 就是这么做的，也是它错的地方——头注不在产物里，拿到副本的人拿不到声明。
- **截图放外链或图床**：README 与详情页要跨网络取图，离线 `dsh web` 与私有 registry 下照样破图，还把用户的访问发给第三方。
- **只发声明不发截图**：那三张图是安装决策的一部分，破图比没图更糟。

锚点：`package.json` 的 `files`；`THIRD_PARTY_NOTICES.md`；`README.md`「许可」；`tests/skeleton.test.ts`；`docs/development.md` 的「发版流程」；ADR-0025。
