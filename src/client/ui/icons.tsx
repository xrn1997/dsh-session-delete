/**
 * 本插件 UI 层要用的六个图标（**逐条抄自** `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2`
 * 随包发布的明文产物 `lib/index.js`；出处与改写规则见 `ui.css` 头注）。
 *
 * 只留本插件用到的：垃圾桶（删除动作 / 回收站）、警示（失败面）、刷新、打开的项目文件夹、
 * 关闭叉（对话框）、圆圈对勾（撤销提示的 success 档）。**几何、`viewBox`、`strokeWidth` 逐字不动**
 * ——它们是官方图标集的形状，改了就不再与宿主同屏同形。
 *
 * 两条与官方实现的差异（都是减法，不是改写）：
 * - 只暴露 `size`（官方是 `{size, className, strokeWidth}` 三件套 + `Medium` 1.3px 那一档）：
 *   本插件六处调用只传 `size`，加别的等于摊开官方整个图标 API。
 * - 不做 `ICON_REGULAR_STROKE` / `ICON_MEDIUM_STROKE` 常量：只有一个档位，直接写 1。
 */
import type { ReactElement, ReactNode } from 'react'

/** 宿主图标组件的实际使用面：一个方形边长，色走 `currentColor`。 */
export interface IconProps {
  size?: number
}

/** 六个图标共用的外框（官方每个 artwork 函数里逐字重复的那一段）。 */
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

export function IconRefreshOutlineRegular({ size }: IconProps): ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1"
        stroke="currentColor"
      />
      <path d="M14.4999 1.5V5.1H10.8999" stroke="currentColor" />
    </IconFrame>
  )
}

export function IconFolderOpenOutlineRegular({ size }: IconProps): ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M12.3994 13.5986H2.04956C1.49728 13.5986 1.04956 13.1509 1.04956 12.5986V3.40137C1.04956 2.84908 1.49728 2.40137 2.04956 2.40137H4.76632C5.01016 2.40137 5.24561 2.49046 5.42836 2.6519L6.94088 3.98799C7.12364 4.14943 7.35908 4.23852 7.60293 4.23852H12.3994C12.9517 4.23852 13.3994 4.68624 13.3994 5.23852V7.16991"
        stroke="currentColor"
      />
      <path
        d="M2.55911 7.93683C2.67584 7.49906 3.07229 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55911 7.93683Z"
        stroke="currentColor"
      />
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
