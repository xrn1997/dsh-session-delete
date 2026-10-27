/**
 * 附件原始字节（`GET /attachment`，全仓唯一的二进制响应段）。
 *
 * 四条硬口径：
 * ① **寻址只认 sha256 id**：`id` 必须 `sha256:<64 位小写 hex>`，路径由 `attachmentPathOf(home, kind, id)`
 *    自己推导——请求里的任何一截都不参与路径拼接（`name` 只做下载名）。
 * ② **kind 只认 image / file**：分别对应宿主附件库的 `objects`（图片）与 `file-objects`（普通文件）；
 *    不认 v2、tmp、cache，也不给"读任意文件"留入口。
 * ③ **单文件 ≤ 20 MiB**：超过不读进内存，回 200 + JSON 失败信封。图片的 `onError` 会换成占位；
 *    普通文件走 `<a download>`，没有页面内失败面——浏览器可能把这份错误响应存成文件。
 * ④ 图片按**魔数**给类型（PNG / JPEG / GIF / WebP）；认不出就按下载处理（`application/octet-stream` +
 *    `attachment`），不猜、也不拿请求里的名字当类型来源。
 *
 * 请求本身不对（id/kind 形状）⇒ 400；对象不在 / 超限 / 读失败 ⇒ 200 + 信封（与其余段同一条错误面）。
 */
import type { FsPort } from '../ports/fs-port.js'
import { PARAMS } from '../shared/wire.js'
import { attachmentPathOf, isAttachmentId } from '../trash/attachments.js'
import { routeError, verbError } from '../verbs/errors.js'
import type { BinaryResponse } from './route-table.js'

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 按魔数认图片类型；认不出回 `undefined`（调用方按未知字节处理，不猜）。 */
function sniffImage(bytes: Buffer): string | undefined {
  if (bytes.length >= PNG_MAGIC.length && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const head6 = bytes.subarray(0, 6).toString('ascii')
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif'
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp'
  return undefined
}

/**
 * 下载名过闸：只当头部里的一个串用，**不参与寻址**。
 * 路径分隔符、控制字符、`..` 与不成对的代理项一律换 `_`；按码点截到 120 个字符（不劈开代理对，
 * 否则 `encodeURIComponent` 会在写头时抛）。
 */
function safeFilename(name: string | null, fallback: string): string {
  const raw = name === null || name === '' ? fallback : name
  const base = [...raw]
    .slice(0, 120)
    .join('')
    .replace(/[\\/:*?"<>|\u0000-\u001f\uD800-\uDFFF]/gu, '_')
    .replace(/\.\./gu, '_')
  return base === '' ? fallback : base
}

/** 读附件只需要 stat + read：与 `AttachmentRemovalDeps` 同一条收窄纪律，执行面不给。 */
export interface AttachmentReadPorts {
  fs: Pick<FsPort, 'statFile' | 'readFile'>
  home: string
}

export async function readAttachmentResponse(deps: AttachmentReadPorts, query: URLSearchParams): Promise<BinaryResponse> {
  const id = query.get(PARAMS.attachmentId)
  const kind = query.get(PARAMS.attachmentKind)
  if (!isAttachmentId(id)) {
    throw routeError('bad-request', 400, `附件 id 需为 sha256:<64 位小写 hex>：${String(id)}`)
  }
  if (kind !== 'image' && kind !== 'file') {
    throw routeError('bad-request', 400, `附件 kind 只认 image / file：${String(kind)}`)
  }

  const path = attachmentPathOf(deps.home, kind, id)
  let size: number
  try {
    size = (await deps.fs.statFile(path)).size
  } catch (error) {
    // 操作失败 ⇒ 200 + 信封：图片的 onError 拿它当"这张图没了"，不是请求不合法。
    throw verbError('io', `附件不在：${id}（${String(error)}）`, error)
  }
  if (size > MAX_ATTACHMENT_BYTES) {
    throw verbError('io', `附件超过 ${MAX_ATTACHMENT_BYTES} 字节上限：${id}（${size} 字节）`)
  }

  const bytes = await deps.fs.readFile(path)
  // stat 与 read 之间文件可能长大：同一道上限，读后按实际字节再判一次。
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw verbError('io', `附件超过 ${MAX_ATTACHMENT_BYTES} 字节上限：${id}（${bytes.length} 字节）`)
  }

  if (kind === 'file') {
    return {
      body: bytes,
      contentType: 'application/octet-stream',
      disposition: 'attachment',
      filename: safeFilename(query.get(PARAMS.attachmentName), id.slice('sha256:'.length, 'sha256:'.length + 12)),
    }
  }

  const contentType = sniffImage(bytes)
  if (contentType === undefined) {
    return {
      body: bytes,
      contentType: 'application/octet-stream',
      disposition: 'attachment',
      filename: safeFilename(
        query.get(PARAMS.attachmentName),
        `${id.slice('sha256:'.length, 'sha256:'.length + 12)}.bin`,
      ),
    }
  }
  return { body: bytes, contentType, disposition: 'inline' }
}
