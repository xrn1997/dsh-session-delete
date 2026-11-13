/**
 * 附件原始字节（`GET /attachment`，全仓唯一的二进制响应段）。
 *
 * 四条硬口径：
 * ① **寻址只认 sha256 id**：`id` 必须 `sha256:<64 位小写 hex>`，路径不来自请求里的任何一截
 *    （`name` 只做下载名；媒体元数据只给宿主 `attachments` 服务做引用校验）。
 * ② **kind 只认 image / file**：分别对应宿主附件库的 `objects`（图片）与 `file-objects`（普通文件）；
 *    不认 v2、tmp、cache，也不给"读任意文件"留入口。
 * ③ **单文件 ≤ `maxAttachmentBytes`（默认 20 MiB，可配，ADR-0037）**：所有路径共用同一道
 *    `assertWithinLimit`；服务路径先按引用字节拦一道、再按实际字节复核，流式读在累计处停下。
 * ④ **直接 fs 路径**按**魔数**给图片类型（PNG / JPEG / GIF / WebP），认不出就按下载处理
 *    （`application/octet-stream` + `attachment`），不猜、也不拿请求里的名字当类型来源；服务路径用
 *    宿主归一化后的 `mediaType`（ADR-0035）。
 *
 * **读取优先走宿主 `attachments` 服务**（ADR-0035）：`readImage` / `readFileStream` 会按记录里的
 * 引用校验字节；`attachments` 缺席或请求里没有足够的引用元数据时，才退回直接 fs（旧宿主）。
 * 两种"接不了这次读"（服务缺席 / 元数据不够）在调用方看来是同一个 `undefined`，不各写一条 fallback。
 * 直接 fs 的路径仍只由 `attachmentPathOf(home, kind, id)` 推导。
 *
 * 请求本身不对（id/kind 形状）⇒ 400；对象不在 / 超限 / 读失败 ⇒ 200 + 信封（与其余段同一条错误面）。
 */
import type { FsAttachmentPort } from '../ports/fs-port.js'
import type { SessionDeleteConfig } from '../config.js'
import type {
  AttachmentsPort,
  FileAttachmentRefLike,
  ImageAttachmentRefLike,
  ImageMediaTypeLike,
  StoredImageAttachmentLike,
} from '../ports/attachments-port.js'
import { AttachmentsUnavailableError } from '../ports/attachments-port.js'
import { PARAMS } from '../shared/wire.js'
import { attachmentPathOf, isAttachmentId } from '../trash/attachments.js'
import { routeError, verbError } from '../errors.js'
import type { BinaryResponse } from './route-table.js'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const IMAGE_MEDIA_TYPES: readonly ImageMediaTypeLike[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

function isImageMediaType(value: string | null): value is ImageMediaTypeLike {
  return value !== null && (IMAGE_MEDIA_TYPES as readonly string[]).includes(value)
}

/** 引用里的正整数字段（bytes / width / height）；缺、空、非整数、非正数都当"元数据不够"，退回直接 fs。 */
function positiveInt(value: string | null): number | undefined {
  if (value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

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
function safeFilename(name: string | null | undefined, fallback: string): string {
  const raw = name === null || name === undefined || name === '' ? fallback : name
  // `Array.from(string)` 与 `[...string]` 同为按码点切分；换成它只是避开 no-misused-spread 的
  // 语法误报，码点安全语义不变（注释下一行说明了截断不劈代理对）。
  const base = Array.from(raw)
    .slice(0, 120)
    .join('')
    // eslint-disable-next-line no-control-regex -- 下载名消毒：控制字符正是被匹配、被替换成 `_` 的对象；去掉它们会让 HEAD 文件名带控制字符。
    .replace(/[\\/:*?"<>|\u0000-\u001f\uD800-\uDFFF]/gu, '_')
    .replace(/\.\./gu, '_')
  return base === '' ? fallback : base
}

/** 读附件只需要 stat + read、宿主 `attachments` 读面与响应上限；执行面（removeDir/removeFile）不给。 */
export interface AttachmentReadPorts {
  fs: FsAttachmentPort
  home: string
  attachments: AttachmentsPort
  config: Pick<SessionDeleteConfig, 'maxAttachmentBytes'>
}

/** 引用里的短 id：错误文案与下载名兜底共用，别让 `sha256:` 前缀的切片散在各处。 */
function shortId(id: string): string {
  return id.slice('sha256:'.length, 'sha256:'.length + 12)
}

/** 普通文件的下载响应；图片认不出类型时也走这一支。 */
function downloadResponse(body: Buffer, filename: string): BinaryResponse {
  return { body, contentType: 'application/octet-stream', disposition: 'attachment', filename }
}

/** 服务读取/校验失败按 io 上屏，不 fallback 直接 fs：宿主读 `files/.../<name>` 别名并做摘要/元数据
 *  校验，直接 fs 读 `file-objects/...` 对象；绕过会跳过宿主的校验（ADR-0035 边界）。 */
function attachmentsIoError(id: string, error: unknown): never {
  throw verbError('io', `读取附件失败：${id}（${String(error)}）`, error)
}

/** 同一道上限：声明字节、磁盘字节、服务返回字节都从这里过。 */
function assertWithinLimit(id: string, observed: number, maxBytes: number): void {
  if (observed > maxBytes) throw verbError('io', `附件超过 ${maxBytes} 字节上限：${id}（${observed} 字节）`)
}

/** 流式读超过上限：没有"实际总字节"，原文用 `>上限`。 */
function streamOverflow(id: string, maxBytes: number): never {
  throw verbError('io', `附件超过 ${maxBytes} 字节上限：${id}（>${maxBytes} 字节）`)
}

/** 服务路径要的引用元数据；任一字段不够就回 `undefined`（调用方退回直接 fs，不拿半截 ref 去猜）。 */
function imageServiceRef(id: string, query: URLSearchParams): ImageAttachmentRefLike | undefined {
  const mediaType = query.get(PARAMS.attachmentMediaType)
  const bytes = positiveInt(query.get(PARAMS.attachmentBytes))
  const width = positiveInt(query.get(PARAMS.attachmentWidth))
  const height = positiveInt(query.get(PARAMS.attachmentHeight))
  if (!isImageMediaType(mediaType) || bytes === undefined || width === undefined || height === undefined) return undefined
  const name = query.get(PARAMS.attachmentName)
  return {
    attachmentId: id,
    mediaType,
    bytes,
    width,
    height,
    ...(name === null || name === '' ? {} : { name }),
  }
}

function fileServiceRef(id: string, query: URLSearchParams): FileAttachmentRefLike | undefined {
  const bytes = positiveInt(query.get(PARAMS.attachmentBytes))
  const name = query.get(PARAMS.attachmentName)
  // 宿主 `readFileStream` 要求 `name` 是规范叶名；空/缺名不是"空名字"而是无效引用
  // （宿主把 '' 归一成 'file'），这场读取会落成 io 而不是 fallback。按"元数据不够"退回直接 fs。
  if (bytes === undefined || name === null || name === '') return undefined
  return { attachmentId: id, name, bytes }
}

interface ImageServiceRef {
  readonly kind: 'image'
  readonly ref: ImageAttachmentRefLike
}

interface FileServiceRef {
  readonly kind: 'file'
  readonly ref: FileAttachmentRefLike
}

type ServiceRef = ImageServiceRef | FileServiceRef

/** 一次附件读取的归一请求：`id` / `kind` 决定寻址；`name` 只做下载名；`serviceRef` 缺席只是一种 miss。 */
interface AttachmentRequest {
  readonly id: string
  readonly kind: 'image' | 'file'
  readonly name: string | undefined
  readonly serviceRef: ServiceRef | undefined
}

function parseServiceRef(id: string, kind: 'image' | 'file', query: URLSearchParams): ServiceRef | undefined {
  if (kind === 'image') {
    const ref = imageServiceRef(id, query)
    return ref === undefined ? undefined : { kind: 'image', ref }
  }
  const ref = fileServiceRef(id, query)
  return ref === undefined ? undefined : { kind: 'file', ref }
}

/** query 只解析一次：id/kind 的 400 闸与两套引用元数据都在这里收口。 */
function parseAttachmentRequest(query: URLSearchParams): AttachmentRequest {
  const id = query.get(PARAMS.attachmentId)
  const kind = query.get(PARAMS.attachmentKind)
  if (!isAttachmentId(id)) {
    throw routeError('bad-request', 400, `附件 id 需为 sha256:<64 位小写 hex>：${String(id)}`)
  }
  if (kind !== 'image' && kind !== 'file') {
    throw routeError('bad-request', 400, `附件 kind 只认 image / file：${String(kind)}`)
  }
  const name = query.get(PARAMS.attachmentName)
  return {
    id,
    kind,
    name: name === null || name === '' ? undefined : name,
    serviceRef: parseServiceRef(id, kind, query),
  }
}

async function readImageViaAttachments(
  deps: AttachmentReadPorts,
  ref: ImageAttachmentRefLike,
  maxBytes: number,
): Promise<BinaryResponse | undefined> {
  // 引用里的字节数先过一道闸：别为一张已知超限的图先让宿主整份读出来（读后仍按实际字节再判）。
  assertWithinLimit(ref.attachmentId, ref.bytes, maxBytes)
  let stored: StoredImageAttachmentLike
  try {
    stored = await deps.attachments.readImage(ref)
  } catch (error) {
    if (error instanceof AttachmentsUnavailableError) return undefined
    attachmentsIoError(ref.attachmentId, error)
  }
  const body = Buffer.from(stored.data)
  assertWithinLimit(ref.attachmentId, body.length, maxBytes)
  return { body, contentType: stored.ref.mediaType, disposition: 'inline' }
}

/** 普通文件走宿主服务的分块读；超限在累计处停下，不把整份字节读进内存。 */
async function readFileViaAttachments(
  deps: AttachmentReadPorts,
  ref: FileAttachmentRefLike,
  maxBytes: number,
): Promise<BinaryResponse | undefined> {
  assertWithinLimit(ref.attachmentId, ref.bytes, maxBytes)
  const chunks: Buffer[] = []
  let total = 0
  let tooLarge = false
  try {
    for await (const chunk of deps.attachments.readFileStream(ref)) {
      const buffer = Buffer.from(chunk)
      total += buffer.length
      if (total > maxBytes) {
        tooLarge = true
        break
      }
      chunks.push(buffer)
    }
  } catch (error) {
    if (error instanceof AttachmentsUnavailableError) return undefined
    attachmentsIoError(ref.attachmentId, error)
  }
  if (tooLarge) streamOverflow(ref.attachmentId, maxBytes)
  return downloadResponse(Buffer.concat(chunks), safeFilename(ref.name, shortId(ref.attachmentId)))
}

/** 服务优先的唯一入口；`undefined` = 服务缺席 / 元数据不够 / 服务中途消失，调用方退回直接 fs。 */
async function readViaAttachments(
  deps: AttachmentReadPorts,
  request: AttachmentRequest,
  maxBytes: number,
): Promise<BinaryResponse | undefined> {
  if (request.serviceRef === undefined) return undefined
  if (!deps.attachments.available()) return undefined
  const serviceRef = request.serviceRef
  return serviceRef.kind === 'image'
    ? readImageViaAttachments(deps, serviceRef.ref, maxBytes)
    : readFileViaAttachments(deps, serviceRef.ref, maxBytes)
}

/** 旧宿主 / 元数据不够：退回直接 fs（路径仍只由 id 与 kind 推导）。 */
async function readViaFs(
  deps: AttachmentReadPorts,
  request: AttachmentRequest,
  maxBytes: number,
): Promise<BinaryResponse> {
  const path = attachmentPathOf(deps.home, request.kind, request.id)
  let size: number
  try {
    size = (await deps.fs.statFile(path)).size
  } catch (error) {
    // 操作失败 ⇒ 200 + 信封：图片的 onError 拿它当"这张图没了"，不是请求不合法。
    throw verbError('io', `附件不在：${request.id}（${String(error)}）`, error)
  }
  assertWithinLimit(request.id, size, maxBytes)

  const bytes = await deps.fs.readFile(path)
  // stat 与 read 之间文件可能长大：同一道上限，读后按实际字节再判一次。
  assertWithinLimit(request.id, bytes.length, maxBytes)

  if (request.kind === 'file') {
    return downloadResponse(bytes, safeFilename(request.name, shortId(request.id)))
  }
  const contentType = sniffImage(bytes)
  if (contentType === undefined) {
    return downloadResponse(bytes, safeFilename(request.name, `${shortId(request.id)}.bin`))
  }
  return { body: bytes, contentType, disposition: 'inline' }
}

export async function readAttachmentResponse(deps: AttachmentReadPorts, query: URLSearchParams): Promise<BinaryResponse> {
  const request = parseAttachmentRequest(query)
  const maxBytes = deps.config.maxAttachmentBytes
  const served = await readViaAttachments(deps, request, maxBytes)
  if (served !== undefined) return served
  return readViaFs(deps, request, maxBytes)
}
