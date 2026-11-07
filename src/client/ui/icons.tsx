/**
 * 本插件 UI 层要用的图标。除**恢复箭头**外逐条抄自 `@deepseek-ai/dsh-client-ui-primitives`
 * 的明文产物（出处与改写规则见 `ui.css` 头注）。
 *
 * 只留本插件用到的：垃圾桶、警示、文件夹（开盖填充 / 闭盒描边）、**实心三角**（分组头悬停时的
 * 折叠指示）、关闭叉、圆圈对勾、对勾、下折/右折 chevron、恢复（本插件自绘的回退箭头）、
 * 子会话分支（branch）。
 * **官方字形几何、`viewBox`、`strokeWidth` 逐字不动**——改了就不再与宿主同屏同形。
 *
 * **唯一的自绘字形是 `IconRestoreOutlineRegular`**：官方集里 `unarchive-outline`（箱子）与归档动作太像、
 * `refresh-outline`（顺时针圆箭头）读起来是"刷新"，都没有"把这条会话放回去"的意思。自绘的 ↩ 沿用宿主
 * 16×16 / 1px 描边的一族几何，不伪装成官方图标。
 *
 * 两条与官方实现的差异（都是减法，不是改写）：
 * - 只暴露 `size`：调用处只传 `size`，不摊开官方整个图标 API。
 * - 不做 stroke 常量：只有一个档位，直接写 1。
 */
import type { ReactElement, ReactNode } from 'react'

/** 宿主图标组件的实际使用面：一个方形边长，色走 `currentColor`。 */
export interface IconProps {
  // JSX 侧 `size={可能为 undefined 的表达式}` 是既定写法：可选即接受显式 undefined。
  size?: number | undefined
}

/** 各图标共用的外框（官方每个 artwork 函数里逐字重复的那一段）。 */
function IconFrame({ size = 16, children }: IconProps & { children: ReactNode }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth={1}
    >
      {children}
    </svg>
  )
}

export function IconTrashOutlineRegular({ size }: IconProps): ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M1.28149 3.88831H14.7187" stroke="currentColor" />
      <path
        d="M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833"
        stroke="currentColor"
      />
      <path
        d="M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831"
        stroke="currentColor"
      />
      <path d="M6.44946 6.98926V11.1238" stroke="currentColor" />
      <path d="M9.55054 6.98926V11.1238" stroke="currentColor" />
    </IconFrame>
  )
}

export function IconWarningOutlineRegular({ size }: IconProps): ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z"
        stroke="currentColor"
      />
      <path d="M8 4.29199V9.79199" stroke="currentColor" />
      <path d="M8 10.708V11.708" stroke="currentColor" />
    </IconFrame>
  )
}

export function IconCloseOutlineRegular({ size }: IconProps): ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M2.5 2.5L13.5 13.5" stroke="currentColor" />
      <path d="M13.5 2.5L2.5 13.5" stroke="currentColor" />
    </IconFrame>
  )
}

/** 撤销提示 success 档的前导 glyph（官方 `Toast` 在 `tone="success"` 时自带的那一枚）。 */
export function IconCheckCircleOutlineRegular({ size }: IconProps): ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M12.5303 6.53027L8.80273 10.2578C8.54967 10.5109 8.31796 10.7439 8.10645 10.9141C7.88375 11.0932 7.616 11.2602 7.27344 11.3145C7.09229 11.3431 6.90771 11.3431 6.72656 11.3145C6.384 11.2602 6.11625 11.0932 5.89355 10.9141C5.68204 10.7439 5.45033 10.5109 5.19727 10.2578L3.46973 8.53027L4.53027 7.46973L6.25781 9.19727C6.53457 9.47402 6.70036 9.63859 6.83398 9.74609C6.95637 9.84453 6.98241 9.83644 6.96094 9.83301C6.98679 9.83709 7.01321 9.83709 7.03906 9.83301C7.01759 9.83644 7.04363 9.84453 7.16602 9.74609C7.29964 9.63859 7.46543 9.47402 7.74219 9.19727L11.4697 5.46973L12.5303 6.53027Z"
        fill="currentColor"
      />
      <path
        d="M14.5996 8C14.5996 4.35492 11.6451 1.40039 8 1.40039C4.35492 1.40039 1.40039 4.35492 1.40039 8C1.40039 11.6451 4.35492 14.5996 8 14.5996C11.6451 14.5996 14.5996 11.6451 14.5996 8ZM15.9004 8C15.9004 12.363 12.363 15.9004 8 15.9004C3.63695 15.9004 0.0996094 12.363 0.0996094 8C0.0996094 3.63695 3.63695 0.0996094 8 0.0996094C12.363 0.0996094 15.9004 3.63695 15.9004 8Z"
        fill="currentColor"
      />
    </IconFrame>
  )
}

/** 行尾兜底勾选开关那枚对勾（状态点/归档行；官方几何逐字）。 */
export function IconCheckOutlineRegular({ size }: IconProps): ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4"
        stroke="currentColor"
      />
    </IconFrame>
  )
}

/** 分组头：展开时（官方 `IconFolderOpenRegular`，16×16；开盖那一片带 0.16 透明度）。 */
export function IconFolderOpenRegular({ size }: IconProps): ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z"
        fill="currentColor"
        opacity="0.16"
      />
      <path
        d="M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z"
        fill="currentColor"
      />
      <path
        d="M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z"
        fill="currentColor"
      />
    </IconFrame>
  )
}

/** 分组头：收起时（官方 `IconFolderCloseRegular`，16×16）。 */
export function IconFolderCloseRegular({ size }: IconProps): ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z"
        stroke="currentColor"
      />
      <path d="M3.63501 7.66614H12.3647" stroke="currentColor" />
    </IconFrame>
  )
}

/** 分组头悬停时替换文件夹的折叠指示（官方 `IconTriangleRightFillRegular`）；展开时旋转 90°。 */
export function IconTriangleRightFillRegular({ size }: IconProps): ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M5.5 4.5C5.5 4.40714 5.52586 4.31612 5.57467 4.23713C5.62349 4.15815 5.69334 4.09431 5.77639 4.05279C5.85945 4.01126 5.95242 3.99368 6.0449 4.00202C6.13738 4.01036 6.22572 4.04429 6.3 4.1L10.967 7.6C11.0291 7.64657 11.0795 7.70697 11.1142 7.77639C11.1489 7.84582 11.167 7.92238 11.167 8C11.167 8.07762 11.1489 8.15418 11.1142 8.22361C11.0795 8.29303 11.0291 8.35343 10.967 8.4L6.3 11.9C6.22572 11.9557 6.13738 11.9896 6.0449 11.998C5.95242 12.0063 5.85945 11.9887 5.77639 11.9472C5.69334 11.9057 5.62349 11.8419 5.57467 11.7629C5.52586 11.6839 5.5 11.5929 5.5 11.5V4.5Z"
        fill="currentColor"
      />
    </IconFrame>
  )
}

/** 折叠头与标准档「工作步骤」组「展开中」那一枚（官方 `IconChevronDownOutlineRegular`，`viewBox`/`d` 逐字）。 */
export function IconChevronDownOutlineRegular({ size }: IconProps): ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6"
        stroke="currentColor"
      />
    </IconFrame>
  )
}

/** 折叠头与子会话导航行「已折叠 / 前进」那一枚（官方 `IconChevronRightOutlineRegular`）。 */
export function IconChevronRightOutlineRegular({ size }: IconProps): ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4"
        stroke="currentColor"
      />
    </IconFrame>
  )
}

/** 行内「恢复」：**本插件自绘**的回退箭头（↩，16×16 / 1px，与宿主图标同一族几何）。
 *  官方集里的 `unarchive` 与归档动作的"箱子"轮廓太近、`refresh` 读作"刷新"，都不合适。 */
export function IconRestoreOutlineRegular({ size }: IconProps): ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M4.4 2.7L1.5 5.6L4.4 8.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M1.5 5.6H9.9A4.1 4.1 0 0 1 9.9 13.8H4.7"
        stroke="currentColor"
        strokeLinecap="round"
      />
    </IconFrame>
  )
}

/** 子会话行的前导：官方 `IconBranchOutlineRegular`（16×16）。 */
export function IconBranchOutlineRegular({ size }: IconProps): ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M1.01503 8.0001L5.6964 8.0001C6.41913 8.0001 6.78049 8.0001 7.12115 7.91951C7.4232 7.84804 7.71233 7.73014 7.97821 7.57C8.27809 7.38939 8.5364 7.13669 9.05303 6.63129L11.3281 4.40564"
        stroke="currentColor"
      />
      <path
        d="M1.01221 7.9999L5.6964 7.9999C6.41913 7.9999 6.78049 7.9999 7.12115 8.08049C7.4232 8.15196 7.71233 8.26986 7.97821 8.43C8.27809 8.61061 8.5364 8.86331 9.05303 9.36871L11.3281 11.5944"
        stroke="currentColor"
      />
      <circle cx="12.4502" cy="3.3079" r="1.56962" stroke="currentColor" />
      <circle cx="12.4502" cy="12.6921" r="1.56962" stroke="currentColor" />
    </IconFrame>
  )
}
