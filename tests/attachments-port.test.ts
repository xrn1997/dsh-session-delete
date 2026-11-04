// 宿主 `attachments` 服务的窄镜像（ADR-0035）：惰性解析、形状闸与"不可用"的唯一错误形状。
//
// 这里只钉端口自己的契约；`GET /attachment` 在服务可用/不可用时怎么选路住 `tests/api.test.ts`。
// `available()` 为真但服务中途消失的那一拍由端口抛 `AttachmentsUnavailableError`，读段据此退回直接 fs。
import { describe, expect, it, vi } from 'vitest'
import {
  AttachmentsUnavailableError,
  createAttachmentsPort,
  type FileAttachmentRefLike,
  type ImageAttachmentRefLike,
  type StoredImageAttachmentLike,
} from '../src/ports/attachments-port.js'

const IMAGE_REF: ImageAttachmentRefLike = {
  attachmentId: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
}
const FILE_REF: FileAttachmentRefLike = {
  attachmentId: `sha256:${'b'.repeat(64)}`,
  name: 'a.bin',
  bytes: 3,
}
const STORED: StoredImageAttachmentLike = { ref: IMAGE_REF, data: new Uint8Array([1, 2, 3]) }

interface ServiceLike {
  readImage(ref: ImageAttachmentRefLike): Promise<StoredImageAttachmentLike>
  readFileStream(ref: FileAttachmentRefLike): AsyncIterable<Uint8Array>
}

/** 端口构造函数的 ctx 面（不在测试里装宿主类型包）。 */
type PortCtx = Parameters<typeof createAttachmentsPort>[0]

/** 只实现端口用到的 `ctx.get`：`value` 是函数时每次调用现取，用来模拟"服务晚到"。 */
function ctxWith(value: ServiceLike | undefined | (() => ServiceLike | undefined)): PortCtx {
  return {
    get: (name: string) => (name === 'attachments' ? (typeof value === 'function' ? value() : value) : undefined),
  } as unknown as PortCtx
}

function service(over: Partial<ServiceLike> = {}): ServiceLike {
  return {
    readImage: async () => STORED,
    readFileStream: async function* () { yield new Uint8Array([1, 2, 3]) },
    ...over,
  }
}

describe('createAttachmentsPort', () => {
  it('服务缺席：available() 为假，两条读面都抛「不可用」而不是 io 式错误', async () => {
    const port = createAttachmentsPort(ctxWith(undefined))
    expect(port.available()).toBe(false)
    await expect(port.readImage(IMAGE_REF)).rejects.toBeInstanceOf(AttachmentsUnavailableError)
    const read = async (): Promise<void> => {
      for await (const chunk of port.readFileStream(FILE_REF)) void chunk
    }
    await expect(read()).rejects.toBeInstanceOf(AttachmentsUnavailableError)
  })

  it('ctx.get 抛错 / 成员形状不符：都按服务缺席处理，不把一次读变成故障', () => {
    const throwing = { get: () => { throw new Error('service not ready') } } as unknown as PortCtx
    expect(createAttachmentsPort(throwing).available()).toBe(false)
    expect(createAttachmentsPort(ctxWith({ readImage: async () => STORED } as unknown as ServiceLike)).available()).toBe(false)
  })

  it('每次调用现查：服务晚于端口创建挂上时，后一次 available() 就为真', async () => {
    const late: { mounted?: ServiceLike } = {}
    const port = createAttachmentsPort(ctxWith(() => late.mounted))
    expect(port.available()).toBe(false)
    late.mounted = service()
    expect(port.available()).toBe(true)
    await expect(port.readImage(IMAGE_REF)).resolves.toBe(STORED)
  })

  it('服务在场：readImage 原样交回、readFileStream 按块转发', async () => {
    const readImage = vi.fn(async () => STORED)
    const chunks = [new Uint8Array([1]), new Uint8Array([2, 3])]
    const port = createAttachmentsPort(ctxWith(service({
      readImage,
      readFileStream: async function* () { for (const chunk of chunks) yield chunk },
    })))

    await expect(port.readImage(IMAGE_REF)).resolves.toBe(STORED)
    expect(readImage).toHaveBeenCalledWith(IMAGE_REF)
    const received: Uint8Array[] = []
    for await (const chunk of port.readFileStream(FILE_REF)) received.push(chunk)
    expect(received).toEqual(chunks)
  })
})
