/**
 * 多帧 zstd 流的帧边界。会话日志是 append 出来的帧序列，而 Node 的 `zstdDecompressSync` 与流式 API 都只给第一帧（实测），
 * 所以必须自己切帧：`magic(4) + 描述符(1) + [Window] + [DID] + [FCS] + 块 + [4B 校验]`。
 *
 * **位段必须照 RFC 8878 表 3 取**：取错位段会算错头长；在产的 descriptor 是 `0x04`（非单段 + 无 FCS + 校验位），
 * 换宿主或写帧版本就可能变。尾巴 4 字节按实测判据收：跳过去必须正好撞上下一帧 magic 或 EOF，猜错由末尾自证与块界护栏抛。
 * 块头可能被文件截断，护栏不可省：不抛的话块循环每圈只 +3 字节却永不 break，整个进程会卡死。
 */

export interface FrameRange {
  start: number
  end: number
}

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
/** magic(4) + Frame_Header_Descriptor(1) 之后第一个字节的偏移。 */
const AFTER_DESCRIPTOR = 5
const BLOCK_HEADER_BYTES = 3
const BLOCK_LAST = 1
const BLOCK_TYPE_SHIFT = 1
const BLOCK_SIZE_SHIFT = 3
const BLOCK_SIZE_MASK = 0x1f_ff_ff
const BLOCK_RAW = 0
const BLOCK_RLE = 1
const BLOCK_COMRESSED = 2
/** RFC 8878 表 3 的帧头描述符位段：1-0 字典 ID、2 校验和、5 单段、7-6 FCS 尺寸。 */
const DESC_DID_FLAG = 0x3
const DESC_SINGLE_SHIFT = 5
const DESC_FCS_SHIFT = 6
/** 规范（RFC 8878 表 4）里 3 是 **Reserved**，不是"未压缩块"：见到就抛，别照 Raw 吞块体。 */
const BLOCK_RESERVED = 3
/** descriptor 各字段的取值 → 字段字节数（zstd 帧头的两张尺寸表）。 */
const DID_SIZES = [0, 1, 2, 4]
const FCS_SIZES_SINGLE = [1, 2, 4, 8]
const FCS_SIZES_MULTI = [0, 2, 4, 8]
/** 实测的帧尾长度（规范里就是 descriptor 校验位声明的 XXH32；收不收由文件头注的自证判据决定）。 */
const FRAME_TAIL_BYTES = 4

function isMagicAt(raw: Buffer, at: number): boolean {
  return MAGIC.every((byte, i) => raw[at + i] === byte)
}

function readUint24LE(raw: Buffer, at: number): number | undefined {
  const b0 = raw[at]
  const b1 = raw[at + 1]
  const b2 = raw[at + 2]
  // 截断读回 miss，不折叠成 0：0 是合法读数（Reserved 块头就是它），冒充不得。
  if (b0 === undefined || b1 === undefined || b2 === undefined) return undefined
  return b0 | (b1 << 8) | (b2 << 16)
}

/** 块体之后有没有那 4 字节尾巴：只有"跳过它之后仍是帧头或到 EOF"才认。 */
function withFrameTail(raw: Buffer, at: number): number {
  const afterTail = at + FRAME_TAIL_BYTES
  if (afterTail <= raw.length && (afterTail === raw.length || isMagicAt(raw, afterTail))) return afterTail
  return at
}

/**
 * 把 `raw` 切成帧区间。
 * @throws 起始处不是 magic、或某帧算到的末位既不是下一帧帧头也不是 EOF——**一律抛**，绝不"尽力往下解"（半截压缩体解出的东西不可信）。
 * `tolerateTruncatedTail` 只给**前缀读**：尾巴切在帧中间不算损坏，返回已切出的完整帧；默认仍严格，读整本时截断必须抛。
 */
export function frameRanges(raw: Buffer, options: { readonly tolerateTruncatedTail?: boolean } = {}): FrameRange[] {
  const ranges: FrameRange[] = []
  let at = 0
  while (at < raw.length) {
    try {
      if (!isMagicAt(raw, at)) {
        throw new Error(`zstd 帧头缺席：偏移 ${at} 处不是 magic（前面第 ${ranges.length} 帧的边界算歪了？）`)
      }
      const descriptor = raw[at + 4]
      if (descriptor === undefined) throw new Error(`zstd 帧头不完整：偏移 ${at} 之后不足 ${AFTER_DESCRIPTOR} 字节`)
      const didFlag = descriptor & DESC_DID_FLAG
      const singleSegment = (descriptor >> DESC_SINGLE_SHIFT) & 0x1
      const fcsFlag = (descriptor >> DESC_FCS_SHIFT) & 0x3
      let cursor = at + AFTER_DESCRIPTOR
      // 单段 ⇒ 没有 Window 字节；FCS 的尺寸还要看单段位（表 4 的两列）
      if (!singleSegment) cursor += 1
      cursor += DID_SIZES[didFlag] as number
      cursor += (singleSegment ? FCS_SIZES_SINGLE : FCS_SIZES_MULTI)[fcsFlag] as number

      for (;;) {
        const blockHeader = readUint24LE(raw, cursor)
        cursor += BLOCK_HEADER_BYTES
        // 截断必须在这里响亮失败：少了这道护栏，块循环每圈只推进头长却永不 break，整个进程会卡死。
        if (blockHeader === undefined || cursor > raw.length) {
          throw new Error(`zstd 块头越界：帧起于 ${at}，读到偏移 ${cursor}（文件长 ${raw.length}）`)
        }
        const blockType = (blockHeader >> BLOCK_TYPE_SHIFT) & 0x3
        const blockSize = (blockHeader >> BLOCK_SIZE_SHIFT) & BLOCK_SIZE_MASK
        // 3 是规范的 Reserved：真产物里没出现过，Node 也当场拒解 ⇒ 直接抛，不照 Raw 那样吞块体。
        if (blockType === BLOCK_RESERVED) {
          throw new Error(`zstd 保留块类型：帧起于 ${at}，偏移 ${cursor - BLOCK_HEADER_BYTES} 的块头 type=3（规范 Reserved，对面解不开）`)
        }
        // Raw(0) 与 Compressed(2) 后面跟 blockSize 个字节；RLE(1) 只跟 **1 字节**（重复 blockSize 次）
        if (blockType === BLOCK_RAW || blockType === BLOCK_COMRESSED) {
          cursor += blockSize
        } else if (blockType === BLOCK_RLE) {
          cursor += 1
        }
        if (blockHeader & BLOCK_LAST) break
      }
      cursor = withFrameTail(raw, cursor)
      if (cursor !== raw.length && !isMagicAt(raw, cursor)) {
        throw new Error(`zstd 帧边界算歪了：帧起于 ${at}，算到 ${cursor}，那里既不是下一帧帧头也不是 EOF`)
      }
      ranges.push({ start: at, end: cursor })
      at = cursor
    } catch (error) {
      if (options.tolerateTruncatedTail === true) return ranges
      throw error
    }
  }
  return ranges
}
