/**
 * 多帧 zstd 流的帧边界。
 *
 * 为什么要有这个文件：会话日志是一次次 append 出来的**帧序列**，而 Node 的 `zstdDecompressSync`
 * **与** `createZstdDecompress()` 流式**都只给第一帧**（实测：本机一个 3.8 MB 的文件，两个 API 都只回
 * 209 字节 = header 那一行）。要拿到全部记录就必须自己把帧切开。
 *
 * 帧 = `magic(4) + Frame_Header_Descriptor(1) + [Window 1B 若 !single] + [DID 0/1/2/4] + [FCS]
 *       + 若干块（3B 块头 + 块体）+ [4B 尾巴]`。
 *
 * **真实产物的形态是量出来的**（本机 125 个文件 / 36 904 帧）：descriptor **恒 `0x04`**（单段 ⇒ 无
 * Window，FCS 1 字节，无字典，校验位没置位），块类型只有 `Compressed`(36 630) 与 `Raw`(620)，
 * 每帧 **1～120 块**（多数 1 块）——所以多块循环与 Raw 两条路都在生产上跑着，不是纸面分支。
 * 类型 3 是规范的 Reserved 位（不是"未压缩块"）：产物里没出现过，Node 也当场拒解 ⇒ 遇到就抛。
 *
 * **尾巴那 4 字节按实测处理，不按 descriptor 的 bit5**：校验位从未置位，却每帧都带 4 字节；
 * 判"读不读这 4 字节"用的是「跳过去必须正好撞上下一帧的 magic 或到 EOF」——猜错不会静默切歪：
 * 末尾的自证与块界护栏会抛（护栏是必需的：块头越界时 `|` 读回 0，而 0 的 `Last_Block` 位没置位，
 * 少了它块循环每圈只 +3 字节却永不 break，整个进程会卡死；用例覆盖这一条）。
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
/** 规范（RFC 8878 表 4）里 3 是 **Reserved**，不是"未压缩块"：见到就抛，别照 Raw 吞块体。 */
const BLOCK_RESERVED = 3
/** descriptor 各字段的取值 → 字段字节数（zstd 帧头的两张尺寸表）。 */
const DID_SIZES = [0, 1, 2, 4]
const FCS_SIZES_SINGLE = [1, 2, 4, 8]
const FCS_SIZES_MULTI = [0, 2, 4, 8]
/** 实测的帧尾长度（校验和位置；bit5 没置位也照样带，见文件头注）。 */
const FRAME_TAIL_BYTES = 4

function isMagicAt(raw: Buffer, at: number): boolean {
  return MAGIC.every((byte, i) => raw[at + i] === byte)
}

function readUint24LE(raw: Buffer, at: number): number {
  return raw[at] | (raw[at + 1] << 8) | (raw[at + 2] << 16)
}

/** 块体之后有没有那 4 字节尾巴：只有"跳过它之后仍是帧头或到 EOF"才认。 */
function withFrameTail(raw: Buffer, at: number): number {
  const afterTail = at + FRAME_TAIL_BYTES
  if (afterTail <= raw.length && (afterTail === raw.length || isMagicAt(raw, afterTail))) return afterTail
  return at
}

/**
 * 把 `raw` 切成帧区间。
 * @throws 起始处不是 magic、或某帧算到的末位既不是下一帧帧头也不是 EOF——**一律抛**，
 *   绝不"尽力往下解"：切错帧的后果是把半截压缩体当解压输入，那时解出来的东西不可信。
 */
export function frameRanges(raw: Buffer): FrameRange[] {
  const ranges: FrameRange[] = []
  let at = 0
  while (at < raw.length) {
    if (!isMagicAt(raw, at)) {
      throw new Error(`zstd 帧头缺席：偏移 ${at} 处不是 magic（前面第 ${ranges.length} 帧的边界算歪了？）`)
    }
    const descriptor = raw[at + 4]
    if (descriptor === undefined) throw new Error(`zstd 帧头不完整：偏移 ${at} 之后不足 ${AFTER_DESCRIPTOR} 字节`)
    const fcsFlag = descriptor & 0x3
    const singleSegment = (descriptor >> 2) & 0x1
    const didFlag = (descriptor >> 6) & 0x3
    let cursor = at + AFTER_DESCRIPTOR
    if (!singleSegment) cursor += 1
    cursor += DID_SIZES[didFlag] as number
    cursor += (singleSegment ? FCS_SIZES_SINGLE : FCS_SIZES_MULTI)[fcsFlag] as number

    for (;;) {
      const blockHeader = readUint24LE(raw, cursor)
      cursor += BLOCK_HEADER_BYTES
      // 越界必须在这里响亮失败，不能继续走：`readUint24LE` 是 `|` 读，越界那三字节全是 `undefined`
      // ⇒ 恒 0，而 0 的 `Last_Block` 位没置位 ⇒ 少了这道护栏，块循环每圈只 `cursor += 3` 却永远
      // 不 break，整个进程会卡死。
      if (cursor > raw.length) {
        throw new Error(`zstd 块头越界：帧起于 ${at}，读到偏移 ${cursor}（文件长 ${raw.length}）`)
      }
      const blockType = (blockHeader >> BLOCK_TYPE_SHIFT) & 0x3
      const blockSize = (blockHeader >> BLOCK_SIZE_SHIFT) & BLOCK_SIZE_MASK
      // 3 是规范的 Reserved 位：真产物 36 904 帧里一次没出现过，而 Node 的解压端当场拒
      // （"Data corruption detected"）⇒ 不照 Raw 那样吞掉块体，直接抛。
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
  }
  return ranges
}
