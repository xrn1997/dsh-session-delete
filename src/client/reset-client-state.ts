/**
 * 浏览器半**默认场景**的一枚复位口：测试的 beforeEach / afterEach 只调这一条。
 *
 * 现场已经收进可实例化的场景（`scene.ts` 的 `ClientScene`）：九份（回收站修订台/首帧快照/多选/行登记/
 * 撤销台/删除请求/批量确认/主视图/归档修订）的复位实现住 `createClientScene().reset()`，这里只复位
 * **默认场景**——没有 Provider 的旧测试与生产激活前的那一份都落到它。新增一份现场只改 `scene.ts`。
 *
 * 只给测试用（生产没有调用点）：不引入新的运行期状态，只把默认场景已有的复位串起来。
 */
import { resetDefaultClientScene } from './scene.js'

export function resetClientState(): void {
  resetDefaultClientScene()
}
