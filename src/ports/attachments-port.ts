/**
 * 宿主 `attachments` 服务的窄镜像（ADR-0035）：只声明本插件读取附件用到的两条。
 *
 * - 服务是**可选**的：`ctx.get('attachments')` 每次调用现查（服务可能晚于插件激活），
 *   `available()` 为假时调用方退回旧的直接 fs 路径。
 * - `readImage` 会按记录里的引用**校验字节**；`readFileStream` 校验并分块读出。
 *   两者都不在本文件里重写校验逻辑。
 * - 不 import 宿主 `attachments` 服务的类型包：形状按该服务的运行期契约抄成窄镜像。
 */
import type { Context } from '@deepseek-ai/cordis'

export type ImageMediaTypeLike = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export interface ImageAttachmentRefLike {
  readonly attachmentId: string
  readonly mediaType: ImageMediaTypeLike
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

export interface FileAttachmentRefLike {
  readonly attachmentId: string
  readonly name: string
  readonly bytes: number
}

export interface StoredImageAttachmentLike {
  readonly ref: ImageAttachmentRefLike
  readonly data: Uint8Array
}

export interface AttachmentsPort {
  /** 服务在场且成员形状可用；调用方用它决定走服务还是直接 fs。 */
  available(): boolean
  readImage(ref: ImageAttachmentRefLike): Promise<StoredImageAttachmentLike>
  readFileStream(ref: FileAttachmentRefLike): AsyncIterable<Uint8Array>
}

/** 服务在 `available()` 之后消失/形状变了：调用方可以退回直接 fs，而不是把这次读取判成 io。 */
export class AttachmentsUnavailableError extends Error {
  constructor(message = 'attachments service absent') {
    super(message)
    this.name = 'AttachmentsUnavailableError'
  }
}

interface AttachmentsServiceLike {
  readImage(ref: ImageAttachmentRefLike): Promise<StoredImageAttachmentLike>
  readFileStream(ref: FileAttachmentRefLike): AsyncIterable<Uint8Array>
}

/** 每次调用惰性解析服务：插件与 `attachments` 的激活顺序没有承诺。 */
export function createAttachmentsPort(ctx: Context): AttachmentsPort {
  const serviceOf = (): AttachmentsServiceLike | undefined => {
    try {
      const service = ctx.get('attachments') as AttachmentsServiceLike | null | undefined
      if (service === undefined || service === null) return undefined
      if (typeof service.readImage !== 'function' || typeof service.readFileStream !== 'function') return undefined
      return service
    } catch {
      return undefined
    }
  }
  return {
    available: () => serviceOf() !== undefined,
    async readImage(ref) {
      const service = serviceOf()
      if (service === undefined) throw new AttachmentsUnavailableError()
      return await service.readImage(ref)
    },
    async *readFileStream(ref) {
      const service = serviceOf()
      if (service === undefined) throw new AttachmentsUnavailableError()
      yield* service.readFileStream(ref)
    },
  }
}
