# GET /attachment — 附件原始字节读取

<cite>
**Referenced Files in This Document **
- [attachment.ts](file://src/api/attachment.ts)
- [route-table.ts](file://src/api/route-table.ts)
- [dispatch.ts](file://src/api/dispatch.ts)
- [wire.ts](file://src/shared/wire.ts)
- [attachments.ts](file://src/trash/attachments.ts)
- [detail.ts](file://src/trash/detail.ts)
- [attachment-view.tsx](file://src/client/attachment-view.tsx)
- [remote.ts](file://src/client/remote.ts)
</cite>

## Table of Contents
1. [简介](#简介)
2. [端点概览](#端点概览)
3. [核心架构](#核心架构)
4. [详细组件分析](#详细组件分析)
   - [路由注册与分发](#路由注册与分发)
   - [请求处理流程](#请求处理流程)
   - [附件路径推导与安全闸](#附件路径推导与安全闸)
   - [图片类型识别](#图片类型识别)
   - [文件大小限制](#文件大小限制)
   - [客户端集成](#客户端集成)
5. [数据流图](#数据流图)
6. [错误处理](#错误处理)
7. [性能考虑](#性能考虑)
8. [故障排除指南](#故障排除指南)
9. [结论](#结论)

## 简介

`GET /attachment` 是回收站插件中唯一的二进制响应端点，专门用于在回收站详情页面中渲染图片和下载文件附件。该端点采用严格的安全设计，通过 SHA-256 ID 进行内容寻址，确保无法访问任意文件系统路径。端点支持两种附件类型：图片（`image`）和普通文件（`file`），单文件大小限制为 20 MiB。对于图片类型，系统通过魔数识别实际的文件格式（PNG、JPEG、GIF、WebP），而非依赖请求参数或文件扩展名。

本端点的设计遵循以下核心原则：
- **内容寻址**：只接受 SHA-256 哈希 ID，路径完全由服务端推导
- **类型隔离**：kind 参数严格限制为 `image` 或 `file`，对应不同的存储目录
- **安全响应**：图片以内联方式展示，文件以附件方式下载
- **容错机制**：失败时返回 JSON 信封而非二进制错误，避免浏览器误存错误响应

**Section sources**
- [attachment.ts:1-40](file://src/api/attachment.ts#L1-L40)
- [wire.ts:30-35](file://src/shared/wire.ts#L30-L35)

## 端点概览

### 路由定义

该端点在路由表中定义为 `GET` 方法，使用纯读模式（pure），不读取清册，响应类型为二进制。

| 属性 | 值 |
|------|-----|
| HTTP 方法 | GET |
| 完整路径 | `/dsh-session-delete-api/attachment` |
| 请求体 | 无（使用查询参数） |
| 纯度 | pure（不进入串行链） |
| 响应类型 | binary |
| 清册读取 | none |

### 查询参数

端点通过 URL 查询参数接收请求，主要参数包括：

| 参数名 | 必需性 | 说明 | 示例 |
|--------|--------|------|------|
| id | 必需 | SHA-256 附件 ID，格式为 `sha256:<64位小写十六进制>` | `sha256:a1b2c3...` |
| kind | 必需 | 附件类型，仅接受 `image` 或 `file` | `image` |
| name | 可选 | 下载文件名建议（仅对 file 类型有效） | `document.pdf` |

**Diagram sources **
- [route-table.ts:125-132](file://src/api/route-table.ts#L125-L132)
- [wire.ts:217-222](file://src/shared/wire.ts#L217-L222)

## 核心架构

```mermaid
graph TB
    Client["客户端<br/>attachment-view.tsx"] --> Request["构建请求 URL<br/>attachmentUrl()"]
    Request --> Gateway["宿主 Web Server<br/>前缀路由分发"]
    Gateway --> Trust["请求栅栏<br/>judgeRequest()"]
    Trust --> RouteTable["路由表查找<br/>routeOf()"]
    RouteTable --> Handler["处理函数<br/>readAttachmentResponse()"]
    
    subgraph "安全验证层"
        Handler --> ValidateID["验证 ID 格式<br/>isAttachmentId()"]
        ValidateID --> ValidateKind["验证 kind 类型"]
        ValidateKind --> DerivePath["推导文件路径<br/>attachmentPathOf()"]
    end
    
    subgraph "文件读取层"
        DerivePath --> StatFile["获取文件大小<br/>statFile()"]
        StatFile --> CheckSize["检查大小限制<br/>≤ 20 MiB"]
        CheckSize --> ReadFile["读取文件内容<br/>readFile()"]
        ReadFile --> VerifySize["再次验证大小"]
    end
    
    subgraph "响应构建层"
        VerifySize --> TypeCheck{"kind 类型?"}
        TypeCheck -->|"file"| FileResponse["文件响应<br/>octet-stream + attachment"]
        TypeCheck -->|"image"| SniffImage["魔数识别<br/>sniffImage()"]
        SniffImage --> ImageType{"识别成功?"}
        ImageType -->|"是"| InlineImage["内联图片<br/>正确 MIME + inline"]
        ImageType -->|"否"| FallbackImage["降级处理<br/>octet-stream + attachment"]
    end
    
    FileResponse --> WriteBinary["写入二进制响应<br/>writeBinary()"]
    InlineImage --> WriteBinary
    FallbackImage --> WriteBinary
    WriteBinary --> Client
    
    Handler -.->|"失败"| ErrorEnvelope["JSON 错误信封<br/>writeFailure()"]
    ErrorEnvelope --> Client
    
    style Client fill:#e1f5ff
    style Gateway fill:#fff4e1
    style Handler fill:#e8f5e9
    style WriteBinary fill:#fce4ec
```

**Diagram sources **
- [attachment.ts:58-111](file://src/api/attachment.ts#L58-L111)
- [dispatch.ts:115-160](file://src/api/dispatch.ts#L115-L160)
- [route-table.ts:125-132](file://src/api/route-table.ts#L125-L132)

**Section sources**
- [attachment.ts:1-111](file://src/api/attachment.ts#L1-L111)
- [route-table.ts:125-132](file://src/api/route-table.ts#L125-L132)
- [dispatch.ts:115-160](file://src/api/dispatch.ts#L115-L160)

## 详细组件分析

### 路由注册与分发

端点通过插件的 `apply` 函数注册到宿主 Web Server，使用前缀路由机制。路由表定义了九个段名，其中 `/attachment` 是唯一使用二进制响应的端点。

```mermaid
sequenceDiagram
    participant Plugin as "插件装配<br/>index.ts"
    participant WebServer as "宿主 Web Server"
    participant Dispatch as "请求分发器<br/>dispatch.ts"
    participant RouteTable as "路由表<br/>route-table.ts"
    
    Plugin->>WebServer: register({kind:'prefix', path:'/dsh-session-delete-api'})
    WebServer-->>Plugin: disposer
    
    Note over Plugin,WebServer: 插件激活时注册前缀路由
    
    Client->>Dispatch: GET /dsh-session-delete-api/attachment?id=...&kind=...
    Dispatch->>Dispatch: judgeRequest() 请求栅栏
    Dispatch->>RouteTable: routeOf('/attachment')
    RouteTable-->>Dispatch: RouteSpec {method:'GET', response:'binary'}
    Dispatch->>Dispatch: readAttachmentResponse(deps, query)
    Dispatch->>Client: writeBinary(response) 或 writeFailure(error)
```

**Diagram sources **
- [index.ts:75-88](file://src/index.ts#L75-L88)
- [dispatch.ts:130-160](file://src/api/dispatch.ts#L130-L160)
- [route-table.ts:125-132](file://src/api/route-table.ts#L125-L132)

路由表配置的关键特性：
- **方法限制**：仅接受 GET 请求，其他方法返回 405
- **纯度声明**：标记为 `pure`，不进入串行执行链，可并发处理
- **响应类型**：声明为 `binary`，触发特殊的二进制响应写入逻辑
- **无清册读取**：`read: 'none'`，不访问回收站清册数据

**Section sources**
- [index.ts:75-88](file://src/index.ts#L75-L88)
- [route-table.ts:125-132](file://src/api/route-table.ts#L125-L132)
- [dispatch.ts:35-55](file://src/api/dispatch.ts#L35-L55)

### 请求处理流程

处理函数 `readAttachmentResponse` 执行严格的四步验证和处理流程：

1. **参数验证**：检查 `id` 和 `kind` 参数的合法性
2. **路径推导**：基于 ID 和 kind 自动推导文件路径
3. **大小检查**：stat 阶段和读取后双重验证文件大小
4. **类型识别**：对图片进行魔数识别，确定正确的 Content-Type

```mermaid
flowchart TD
    Start([请求进入]) --> GetParams["获取查询参数<br/>id, kind, name"]
    GetParams --> ValidateID{"ID 格式合法?<br/>sha256:hex{64}"}
    ValidateID -->|"否"| BadRequest400["抛出 400 错误<br/>bad-request"]
    ValidateID -->|"是"| ValidateKind{"kind 合法?<br/>image 或 file"}
    ValidateKind -->|"否"| BadRequest400
    ValidateKind -->|"是"| DerivePath["推导文件路径<br/>attachmentPathOf()"]
    
    DerivePath --> StatFile["statFile 获取大小"]
    StatFile --> StatError{"stat 成功?"}
    StatError -->|"否"| NotFoundIO["抛出 io 错误<br/>附件不在"]
    StatError -->|"是"| CheckStatSize{"大小 ≤ 20 MiB?"}
    
    CheckStatSize -->|"否"| TooLargeIO["抛出 io 错误<br/>超过上限"]
    CheckStatSize -->|"是"| ReadFile["readFile 读取内容"]
    ReadFile --> ReadError{"读取成功?"}
    ReadError -->|"否"| NotFoundIO
    ReadError -->|"是"| CheckReadSize{"实际大小 ≤ 20 MiB?"}
    
    CheckReadSize -->|"否"| TooLargeIO
    CheckReadSize -->|"是"| KindCheck{"kind 类型?"}
    
    KindCheck -->|"file"| BuildFileResp["构建文件响应<br/>octet-stream<br/>disposition: attachment<br/>filename: safeFilename()"]
    KindCheck -->|"image"| SniffMagic["魔数识别<br/>sniffImage()"]
    
    SniffMagic --> Recognized{"识别成功?"}
    Recognized -->|"是"| BuildInlineImg["构建内联图片响应<br/>正确 MIME type<br/>disposition: inline"]
    Recognized -->|"否"| BuildFallbackImg["构建降级响应<br/>octet-stream<br/>disposition: attachment<br/>filename: hash.bin"]
    
    BuildFileResp --> Return[返回 BinaryResponse]
    BuildInlineImg --> Return
    BuildFallbackImg --> Return
    
    BadRequest400 -.-> Catch["catch 块捕获"]
    NotFoundIO -.-> Catch
    TooLargeIO -.-> Catch
    Catch --> WriteJSON["writeFailure<br/>JSON 错误信封"]
    WriteJSON --> End([结束])
    Return --> WriteBin["writeBinary<br/>二进制响应"]
    WriteBin --> End
    
    style Start fill:#e1f5ff
    style End fill:#e1f5ff
    style BadRequest400 fill:#ffcdd2
    style NotFoundIO fill:#ffcdd2
    style TooLargeIO fill:#ffcdd2
    style WriteJSON fill:#fff9c4
    style WriteBin fill:#c8e6c9
```

**Diagram sources **
- [attachment.ts:58-111](file://src/api/attachment.ts#L58-L111)
- [dispatch.ts:35-55](file://src/api/dispatch.ts#L35-L55)

关键设计决策：
- **双重大小检查**：在 stat 阶段和读取后都进行检查，防止文件在两次操作之间被修改导致内存溢出
- **错误统一处理**：所有错误最终都通过 `writeFailure` 返回 JSON 信封，保持错误处理的一致性
- **参数验证前置**：在进入文件系统操作前先验证参数，快速拒绝非法请求

**Section sources**
- [attachment.ts:58-111](file://src/api/attachment.ts#L58-L111)

### 附件路径推导与安全闸

路径推导函数 `attachmentPathOf` 实现了多层安全防护，确保无法通过构造恶意 ID 访问任意文件。

```mermaid
flowchart TD
    Start([输入: home, kind, id]) --> CheckFormat{"ID 格式检查<br/>isAttachmentId()"}
    CheckFormat -->|"失败"| ThrowID["抛出错误<br/>附件 id 形状不对"]
    CheckFormat -->|"通过"| ExtractHex["提取 hex 部分<br/>id.slice('sha256:'.length)"]
    
    ExtractHex --> SelectRoot{"kind 类型?"}
    SelectRoot -->|"image"| SetObjects["root = 'objects'"]
    SelectRoot -->|"file"| SetFileObjects["root = 'file-objects'"]
    
    SetObjects --> BuildBase["构建基础路径<br/>home/attachments/v1/{root}"]
    SetFileObjects --> BuildBase
    
    BuildBase --> SplitPrefix["取前两位作为子目录<br/>hex.slice(0, 2)"]
    SplitPrefix --> BuildFullPath["拼接完整路径<br/>base/prefix/hex"]
    
    BuildFullPath --> ResolvePaths["解析绝对路径<br/>path.resolve()"]
    ResolvePaths --> ComputeRelative["计算相对路径<br/>path.relative(base, file)"]
    
    ComputeRelative --> CheckEscape{"路径是否越界?<br/>rel === '' 或 '..' 或以 '../' 开头"}
    CheckEscape -->|"是"| ThrowPath["抛出错误<br/>附件路径越界"]
    CheckEscape -->|"否"| ReturnPath[返回安全路径]
    
    ThrowID --> End([结束])
    ThrowPath --> End
    ReturnPath --> End
    
    style Start fill:#e1f5ff
    style End fill:#e1f5ff
    style ThrowID fill:#ffcdd2
    style ThrowPath fill:#ffcdd2
    style ReturnPath fill:#c8e6c9
```

**Diagram sources **
- [attachments.ts:45-65](file://src/trash/attachments.ts#L45-L65)

安全机制详解：

1. **正则表达式验证**：ID 必须符合 `^sha256:[0-9a-f]{64}$` 格式，只允许小写十六进制字符
2. **目录结构固定**：根据 kind 选择 `objects` 或 `file-objects` 目录，不允许访问其他目录
3. **路径穿越防护**：使用 `path.relative()` 和 `path.resolve()` 进行纵深防御，检测 `..`、符号链接等穿越尝试
4. **绝对路径检查**：确保推导出的路径不是绝对路径，防止绕过基础目录限制

路径推导示例：
- 输入：`home='/data/dsh'`, `kind='image'`, `id='sha256:a1b2c3...'`
- 输出：`/data/dsh/attachments/v1/objects/a1/a1b2c3...`

**Section sources**
- [attachments.ts:30-65](file://src/trash/attachments.ts#L30-L65)

### 图片类型识别

`sniffImage` 函数通过检查文件开头的魔数（magic bytes）来识别图片格式，而非依赖文件扩展名或请求参数。

```mermaid
flowchart TD
    Start([输入: Buffer bytes]) --> CheckPNG{"前 8 字节 = PNG 魔数?<br/>89 50 4E 47 0D 0A 1A 0A"}
    CheckPNG -->|"是"| ReturnPNG["返回 'image/png'"]
    CheckPNG -->|"否"| CheckJPEG{"前 3 字节 = JPEG 魔数?<br/>FF D8 FF"}
    
    CheckJPEG -->|"是"| ReturnJPEG["返回 'image/jpeg'"]
    CheckJPEG -->|"否"| CheckGIF{"前 6 字节 ASCII = GIF87a 或 GIF89a?"}
    
    CheckGIF -->|"是"| ReturnGIF["返回 'image/gif'"]
    CheckGIF -->|"否"| CheckWebP{"前 4 字节 = 'RIFF'<br/>且第 8-11 字节 = 'WEBP'?"}
    
    CheckWebP -->|"是"| ReturnWebP["返回 'image/webp'"]
    CheckWebP -->|"否"| ReturnUndefined["返回 undefined"]
    
    ReturnPNG --> End([结束])
    ReturnJPEG --> End
    ReturnGIF --> End
    ReturnWebP --> End
    ReturnUndefined --> End
    
    style Start fill:#e1f5ff
    style End fill:#e1f5ff
    style ReturnPNG fill:#c8e6c9
    style ReturnJPEG fill:#c8e6c9
    style ReturnGIF fill:#c8e6c9
    style ReturnWebP fill:#c8e6c9
    style ReturnUndefined fill:#fff9c4
```

**Diagram sources **
- [attachment.ts:22-32](file://src/api/attachment.ts#L22-L32)

支持的图片格式及魔数：

| 格式 | 魔数（十六进制） | 魔数（ASCII） | MIME 类型 |
|------|------------------|---------------|-----------|
| PNG | 89 50 4E 47 0D 0A 1A 0A | - | image/png |
| JPEG | FF D8 FF | - | image/jpeg |
| GIF | 47 49 46 38 37 61 或 47 49 46 38 39 61 | GIF87a 或 GIF89a | image/gif |
| WebP | 52 49 46 46 ... 57 45 42 50 | RIFF...WEBP | image/webp |

识别失败的处理：
- 返回 `undefined`，调用方将其视为未知二进制文件
- 使用 `application/octet-stream` 作为 Content-Type
- 设置 `disposition: 'attachment'` 强制下载而非内联显示
- 生成安全的下载文件名（基于 SHA-256 哈希的前 12 位 + `.bin` 扩展名）

**Section sources**
- [attachment.ts:22-32](file://src/api/attachment.ts#L22-L32)
- [attachment.ts:90-105](file://src/api/attachment.ts#L90-L105)

### 文件大小限制

系统实施严格的大小限制以防止内存耗尽攻击，采用双重检查机制。

**限制参数**：
- 最大文件大小：20 MiB（20 × 1024 × 1024 = 20,971,520 字节）

**双重检查机制**：

1. **stat 阶段检查**：在读取文件前通过 `statFile` 获取文件大小
   - 优点：快速拒绝大文件，无需读取内容
   - 局限：文件可能在 stat 和 read 之间被修改

2. **读取后检查**：读取文件内容后再次检查实际字节数
   - 优点：确保实际加载到内存的内容不超过限制
   - 必要性：弥补 stat 阶段的时序窗口

```mermaid
sequenceDiagram
    participant Handler as "处理函数"
    participant FS as "文件系统端口"
    participant Memory as "内存缓冲区"
    
    Handler->>FS: statFile(path)
    FS-->>Handler: {size: fileSize}
    
    alt size > 20 MiB
        Handler->>Handler: 抛出 io 错误
        Note over Handler: 快速拒绝，不读取文件
    else size ≤ 20 MiB
        Handler->>FS: readFile(path)
        FS-->>Memory: Buffer(bytes)
        Memory->>Handler: 返回 Buffer
        
        alt bytes.length > 20 MiB
            Handler->>Handler: 抛出 io 错误
            Note over Handler: 文件在 stat 后被修改增大
        else bytes.length ≤ 20 MiB
            Handler->>Handler: 继续处理
            Note over Handler: 双重验证通过
        end
    end
```

**Diagram sources **
- [attachment.ts:75-88](file://src/api/attachment.ts#L75-L88)

超限错误的处理：
- 错误码：`sessiondelete/io`
- 错误消息包含实际大小和上限值，便于调试
- 返回 200 + JSON 信封，而非 HTTP 错误状态码
- 客户端可根据错误类型决定是否显示占位符

**Section sources**
- [attachment.ts:18](file://src/api/attachment.ts#L18)
- [attachment.ts:75-88](file://src/api/attachment.ts#L75-L88)

### 客户端集成

客户端通过 `attachment-view.tsx` 组件集成附件显示功能，支持图片预览和文件下载。

```mermaid
classDiagram
    class AttachmentStrip {
        +attachments: TrashDetailAttachmentWire[]
        +t: Translate
        +align: 'start' | 'end'
        -preview: TrashDetailAttachmentWire | null
        -failed: ReadonlySet~string~
        -saving: boolean
        -saveError: string | null
        +markFailed(id): void
        +openPreview(attachment): void
        +closePreview(): void
        +savePreview(attachment): Promise~void~
    }
    
    class TrashDetailAttachmentWire {
        +attachmentId: string
        +kind: 'image' | 'file'
        +name?: string
        +mediaType?: string
        +bytes: number
        +width?: number
        +height?: number
    }
    
    class Modal {
        +isOpen: boolean
        +onClose(): void
        +children: ReactNode
    }
    
    class Button {
        +variant: 'primary' | 'secondary'
        +onClick(): void
        +children: ReactNode
    }
    
    AttachmentStrip --> TrashDetailAttachmentWire : "使用"
    AttachmentStrip --> Modal : "放大预览"
    AttachmentStrip --> Button : "保存按钮"
    
    note for AttachmentStrip "failed 集合按 attachmentId 记录\n裂图的图片不再重复尝试加载"
    note for TrashDetailAttachmentWire "attachmentId 是 SHA-256 哈希\n也是 /attachment 端点的唯一寻址依据"
```

**Diagram sources **
- [attachment-view.tsx:85-293](file://src/client/attachment-view.tsx#L85-L293)
- [wire.ts:125-135](file://src/shared/wire.ts#L125-L135)

URL 构建逻辑：

```mermaid
flowchart TD
    Start([attachmentUrl 调用]) --> CreateParams["创建 URLSearchParams"]
    CreateParams --> AddID["添加 id 参数<br/>PARAMS.attachmentId"]
    AddID --> AddKind["添加 kind 参数<br/>PARAMS.attachmentKind"]
    
    AddKind --> IsFile{"kind === 'file' ?"}
    IsFile -->|"是"| HasName{"name 存在且非空?"}
    IsFile -->|"否"| BuildURL["构建完整 URL"]
    
    HasName -->|"是"| AddName["添加 name 参数<br/>PARAMS.attachmentName"]
    HasName -->|"否"| BuildURL
    AddName --> BuildURL
    
    BuildURL --> ConcatPath["拼接路径<br/>SESSION_DELETE_API_PREFIX + ROUTES.attachment"]
    ConcatPath --> AppendQuery["附加查询字符串"]
    AppendQuery --> ReturnURL[返回完整 URL]
    
    style Start fill:#e1f5ff
    style ReturnURL fill:#c8e6c9
```

**Diagram sources **
- [attachment-view.tsx:25-38](file://src/client/attachment-view.tsx#L25-L38)

图片加载失败处理：
- 使用 `failed` Set 记录失败的 `attachmentId`
- 失败后显示占位符，包含附件名称、大小和"附件不可用"提示
- 同一个内容哈希在会话中多次引用时，一次失败即全部标记
- 放大框中也检查 `failed` 集合，避免在模态框中显示破图

文件下载处理：
- 直接使用 `<a download>` 标签，href 指向附件端点
- 对于 file 类型，如果提供了 name 参数，会添加到查询串中作为下载名建议
- 没有页面内失败面，因为服务端失败返回的是 JSON 信封，浏览器可能将其保存为文件

**Section sources**
- [attachment-view.tsx:25-38](file://src/client/attachment-view.tsx#L25-L38)
- [attachment-view.tsx:85-293](file://src/client/attachment-view.tsx#L85-L293)
- [wire.ts:125-135](file://src/shared/wire.ts#L125-L135)

## 数据流图

### 完整请求-响应流程

```mermaid
sequenceDiagram
    participant Browser as "浏览器<br/>attachment-view.tsx"
    participant Gateway as "宿主 Web Server"
    participant Dispatcher as "请求分发器<br/>dispatch.ts"
    participant Trust as "请求栅栏<br/>request-trust.ts"
    participant Handler as "附件处理器<br/>attachment.ts"
    participant Attachments as "附件模块<br/>attachments.ts"
    participant FS as "文件系统端口<br/>fs-port.ts"
    
    Browser->>Browser: 渲染附件列表
    Browser->>Browser: 构建附件 URL<br/>attachmentUrl(attachment)
    Browser->>Gateway: GET /dsh-session-delete-api/attachment?id=...&kind=...
    
    Gateway->>Dispatcher: 转发请求
    Dispatcher->>Trust: judgeRequest(req, trust)
    Trust-->>Dispatcher: verdict ('allowed' 或拒绝原因)
    
    alt 请求被拒绝
        Dispatcher->>Browser: 403 Forbidden + JSON 信封
    else 请求允许
        Dispatcher->>Dispatcher: 解析 URL，提取段名
        Dispatcher->>Dispatcher: routeOf(rest)
        Dispatcher->>Dispatcher: requireMethod('GET')
        
        Dispatcher->>Handler: readAttachmentResponse(deps, query)
        
        Handler->>Handler: 获取查询参数 id, kind, name
        Handler->>Handler: isAttachmentId(id)
        
        alt ID 格式无效
            Handler->>Dispatcher: 抛出 routeError('bad-request', 400)
            Dispatcher->>Browser: 400 Bad Request + JSON 信封
        else ID 格式有效
            Handler->>Handler: 验证 kind ∈ {'image', 'file'}
            
            alt kind 无效
                Handler->>Dispatcher: 抛出 routeError('bad-request', 400)
                Dispatcher->>Browser: 400 Bad Request + JSON 信封
            else kind 有效
                Handler->>Attachments: attachmentPathOf(home, kind, id)
                Attachments-->>Handler: 安全路径
                
                Handler->>FS: statFile(path)
                
                alt stat 失败
                    FS-->>Handler: 抛出错误
                    Handler->>Dispatcher: 抛出 verbError('io')
                    Dispatcher->>Browser: 200 OK + JSON 错误信封
                else stat 成功
                    FS-->>Handler: {size: fileSize}
                    
                    alt size > 20 MiB
                        Handler->>Dispatcher: 抛出 verbError('io', '超过上限')
                        Dispatcher->>Browser: 200 OK + JSON 错误信封
                    else size ≤ 20 MiB
                        Handler->>FS: readFile(path)
                        
                        alt 读取失败
                            FS-->>Handler: 抛出错误
                            Handler->>Dispatcher: 抛出 verbError('io')
                            Dispatcher->>Browser: 200 OK + JSON 错误信封
                        else 读取成功
                            FS-->>Handler: Buffer(bytes)
                            
                            alt bytes.length > 20 MiB
                                Handler->>Dispatcher: 抛出 verbError('io')
                                Dispatcher->>Browser: 200 OK + JSON 错误信封
                            else bytes.length ≤ 20 MiB
                                alt kind === 'file'
                                    Handler->>Handler: 构建文件响应<br/>octet-stream + attachment
                                else kind === 'image'
                                    Handler->>Handler: sniffImage(bytes)
                                    
                                    alt 识别成功
                                        Handler->>Handler: 构建内联图片响应<br/>正确 MIME + inline
                                    else 识别失败
                                        Handler->>Handler: 构建降级响应<br/>octet-stream + attachment
                                    end
                                end
                                
                                Handler-->>Dispatcher: BinaryResponse
                                Dispatcher->>Dispatcher: writeBinary(res, response)
                                Dispatcher->>Browser: 200 OK + 二进制数据 + 安全头
                            end
                        end
                    end
                end
            end
        end
    end
    
    Note over Browser,Gateway: 安全头包括:<br/>cache-control: private, no-store<br/>x-content-type-options: nosniff<br/>content-disposition
```

**Diagram sources **
- [dispatch.ts:115-160](file://src/api/dispatch.ts#L115-L160)
- [attachment.ts:58-111](file://src/api/attachment.ts#L58-L111)
- [attachments.ts:45-65](file://src/trash/attachments.ts#L45-L65)

### 二进制响应写入流程

```mermaid
flowchart TD
    Start([writeBinary 调用]) --> ExtractFields["从 BinaryResponse 提取字段<br/>body, contentType, disposition, filename"]
    
    ExtractFields --> InitHeaders["初始化 headers 对象"]
    InitHeaders --> SetContentType["设置 content-type"]
    SetContentType --> SetContentLength["设置 content-length<br/>String(body.length)"]
    SetContentLength --> SetCacheControl["设置 cache-control<br/>private, no-store"]
    SetCacheControl --> SetNoSniff["设置 x-content-type-options<br/>nosniff"]
    
    SetNoSniff --> HasFilename{"filename 存在?"}
    HasFilename -->|"是"| SetDispositionWithName["设置 content-disposition<br/>attachment; filename*=UTF-8''encodedName"]
    HasFilename -->|"否"| IsAttachment{"disposition === 'attachment'?"}
    
    IsAttachment -->|"是"| SetPlainAttachment["设置 content-disposition<br/>attachment"]
    IsAttachment -->|"否"| SkipDisposition["跳过（inline 无需额外头）"]
    
    SetDispositionWithName --> WriteHead["res.writeHead(200, headers)"]
    SetPlainAttachment --> WriteHead
    SkipDisposition --> WriteHead
    
    WriteHead --> WriteBody["res.end(body)"]
    WriteBody --> End([响应发送完成])
    
    style Start fill:#e1f5ff
    style End fill:#e1f5ff
    style WriteHead fill:#c8e6c9
    style WriteBody fill:#c8e6c9
```

**Diagram sources **
- [dispatch.ts:35-55](file://src/api/dispatch.ts#L35-L55)

安全响应头说明：

| 响应头 | 值 | 作用 |
|--------|-----|------|
| content-type | 动态（见类型识别） | 告知浏览器内容类型 |
| content-length | 实际字节数 | 与 body.length 同源，防止篡改 |
| cache-control | private, no-store | 禁止任何中间层缓存，附件可能来自已删除会话 |
| x-content-type-options | nosniff | 禁止浏览器 MIME 类型嗅探，防止类型混淆攻击 |
| content-disposition | inline 或 attachment | 控制浏览器是内联显示还是下载 |

**Section sources**
- [dispatch.ts:35-55](file://src/api/dispatch.ts#L35-L55)
- [attachment.ts:58-111](file://src/api/attachment.ts#L58-L111)

## 错误处理

端点采用分层错误处理策略，区分请求级错误和操作级错误。

### 错误分类

```mermaid
graph TD
    Errors["错误类型"] --> RequestErrors["请求级错误<br/>HTTP 4xx"]
    Errors --> OperationErrors["操作级错误<br/>200 + JSON 信封"]
    
    RequestErrors --> BadRequest["400 Bad Request<br/>参数验证失败"]
    RequestErrors --> MethodNotAllowed["405 Method Not Allowed<br/>方法不正确"]
    RequestErrors --> Forbidden["403 Forbidden<br/>请求栅栏拒绝"]
    
    OperationErrors --> NotFound["io: 附件不在<br/>文件或目录不存在"]
    OperationErrors --> TooLarge["io: 超过大小上限<br/>文件 > 20 MiB"]
    OperationErrors --> ReadError["io: 读取失败<br/>权限、I/O 错误等"]
    
    BadRequest -.-> Code1["sessiondelete/bad-request"]
    MethodNotAllowed -.-> Code2["sessiondelete/bad-method"]
    Forbidden -.-> Code3["非受信来源 或 需要宿主身份"]
    
    NotFound -.-> Code4["sessiondelete/io"]
    TooLarge -.-> Code4
    ReadError -.-> Code4
    
    style RequestErrors fill:#ffcdd2
    style OperationErrors fill:#fff9c4
    style Code4 fill:#e1f5ff
```

**Diagram sources **
- [dispatch.ts:57-70](file://src/api/dispatch.ts#L57-L70)
- [errors.ts:1-50](file://src/verbs/errors.ts#L1-L50)

### 错误处理策略对比

| 错误类型 | HTTP 状态码 | 响应格式 | 客户端行为 | 示例场景 |
|----------|-------------|----------|------------|----------|
| 参数验证失败 | 400 | JSON 信封 | 显示错误消息 | ID 格式错误、kind 无效 |
| 方法不允许 | 405 | JSON 信封 | 记录日志 | 使用 POST 访问 GET 端点 |
| 请求栅栏拒绝 | 403 | JSON 信封 | 引导用户重新认证 | 跨源请求、缺少宿主身份 |
| 附件不存在 | 200 | JSON 信封 | 显示占位符 | 文件已被删除 |
| 文件过大 | 200 | JSON 信封 | 显示错误提示 | 文件超过 20 MiB |
| 读取失败 | 200 | JSON 信封 | 显示占位符 | 权限不足、磁盘错误 |

### 图片加载失败的特殊处理

对于图片类型的附件，客户端实现了额外的容错机制：

```mermaid
sequenceDiagram
    participant Img as "<img> 元素"
    participant Component as "AttachmentStrip 组件"
    participant State as "failed Set 状态"
    
    Img->>Img: 尝试加载图片 src
    Img->>Component: onError 事件触发
    Component->>State: markFailed(attachmentId)
    State->>State: 将 attachmentId 加入 Set
    State->>Component: 触发重新渲染
    Component->>Component: 检查 failed.has(attachmentId)
    Component->>Component: 渲染 Unavailable 占位符
    
    Note over Img,Component: 同一 attachmentId 在会话中<br/>多次引用时，一次失败即全部标记
```

**Diagram sources **
- [attachment-view.tsx:104-110](file://src/client/attachment-view.tsx#L104-L110)
- [attachment-view.tsx:193-230](file://src/client/attachment-view.tsx#L193-L230)

占位符显示内容：
- 警告图标
- 附件名称（如果有）或默认文案（"附件图片" / "文件"）
- 文件大小（格式化显示）
- "附件不可用"提示文本

**Section sources**
- [dispatch.ts:57-70](file://src/api/dispatch.ts#L57-L70)
- [attachment-view.tsx:70-90](file://src/client/attachment-view.tsx#L70-L90)
- [attachment-view.tsx:104-110](file://src/client/attachment-view.tsx#L104-L110)

## 性能考虑

### 内存管理

端点采用全量读取策略，将文件内容一次性加载到内存中：

**优势**：
- 实现简单，无需流式处理的复杂性
- 适合小文件场景（≤ 20 MiB）
- 可以准确计算 content-length

**局限**：
- 大文件（接近 20 MiB）会占用较多内存
- 不支持断点续传
- 无法在读取过程中提前响应

**优化建议**：
- 当前限制下，单个请求最多占用 20 MiB 内存
- 并发请求数受 Node.js 进程内存限制
- 对于频繁访问的大文件，可考虑 CDN 缓存（但需注意 cache-control: no-store 的限制）

### 并发处理

由于端点标记为 `pure`，不进入串行执行链，可以并发处理多个请求：

```mermaid
graph LR
    subgraph "串行链（chained）"
        List["GET /list"]
        Apply["POST /apply"]
        Empty["POST /empty"]
    end
    
    subgraph "并行处理（pure）"
        Ping["GET /ping"]
        Detail["POST /detail"]
        Attachment["GET /attachment"]
        Orphans["GET /attachment-orphans"]
    end
    
    style Serial fill:#fff4e1
    style Parallel fill:#e8f5e9
```

**Diagram sources **
- [route-table.ts:95-160](file://src/api/route-table.ts#L95-L160)

并发优势：
- 附件读取不会阻塞清册对账、删除等操作
- 适合详情页同时加载多张图片的场景
- 减少用户等待时间

### I/O 优化

文件系统操作优化：

1. **stat 前置检查**：先获取文件大小，快速拒绝超限文件，避免不必要的读取
2. **路径推导缓存**：虽然每次请求都重新推导路径，但推导过程是纯计算，开销极小
3. **无额外索引**：直接通过 SHA-256 哈希定位文件，无需查询数据库或索引

潜在瓶颈：
- 每个附件都需要两次文件系统调用（stat + read）
- 对于机械硬盘，随机读取大量小文件可能较慢
- 网络文件系统（NFS）的延迟可能影响响应时间

**Section sources**
- [route-table.ts:95-160](file://src/api/route-table.ts#L95-L160)
- [attachment.ts:75-88](file://src/api/attachment.ts#L75-L88)

## 故障排除指南

### 常见问题及解决方案

#### 1. 图片显示为"附件不可用"

**症状**：回收站详情中图片显示占位符，提示"附件不可用"

**可能原因**：
- 文件已被永久删除
- 文件路径推导错误（极少见，通常表示代码 bug）
- 文件系统权限问题
- 文件损坏导致魔数识别失败

**排查步骤**：
1. 检查浏览器控制台的网络请求，查看响应状态和错误消息
2. 确认附件 ID 格式是否正确（应为 `sha256:` + 64 位小写十六进制）
3. 检查服务器日志中的 `verbError('io')` 记录
4. 验证文件是否存在于预期路径：`$DSH_HOME/attachments/v1/objects/{前2位}/{完整hash}`

**Section sources**
- [attachment.ts:75-82](file://src/api/attachment.ts#L75-L82)
- [attachment-view.tsx:202-230](file://src/client/attachment-view.tsx#L202-L230)

#### 2. 文件下载得到错误响应

**症状**：点击文件附件下载，得到的文件内容是 JSON 错误信封而非实际文件

**原因**：服务端返回 200 + JSON 信封（如文件不存在），浏览器将其保存为文件

**解决方案**：
- 这是预期行为，因为操作级错误返回 200 状态码
- 客户端应在使用 `<a download>` 前检查文件是否存在
- 或者在下载后验证文件内容是否为 JSON

**改进建议**：
- 对于 file 类型，可以考虑在客户端先发起 HEAD 请求检查文件存在性
- 或在下载后检查文件扩展名和内容类型

**Section sources**
- [attachment-view.tsx:135-140](file://src/client/attachment-view.tsx#L135-L140)
- [dispatch.ts:57-70](file://src/api/dispatch.ts#L57-L70)

#### 3. 请求返回 403 Forbidden

**症状**：所有附件请求都被拒绝，返回 403 状态码

**可能原因**：
- 请求来源不被信任（跨源请求）
- 缺少宿主的 Web 身份标识
- 请求栅栏配置错误

**解决方案**：
1. 确认使用 dsh web 打印的 URL 打开页面
2. 检查浏览器控制台的网络请求头
3. 验证宿主 Web Server 的请求栅栏配置
4. 确认 LAN 或反代客户端正确继承宿主身份

**Section sources**
- [dispatch.ts:115-125](file://src/api/dispatch.ts#L115-L125)
- [request-trust.ts:1-50](file://src/api/request-trust.ts#L1-L50)

#### 4. 请求返回 400 Bad Request

**症状**：附件请求被拒绝，返回 400 状态码

**可能原因**：
- ID 参数格式错误（不是 sha256:hex64 格式）
- kind 参数不是 'image' 或 'file'
- 查询参数缺失

**解决方案**：
1. 检查 URL 中的查询参数是否完整
2. 确认 attachmentId 符合正则表达式 `^sha256:[0-9a-f]{64}$`
3. 确认 kind 参数值为小写的 'image' 或 'file'
4. 检查客户端代码中 `attachmentUrl` 函数的调用

**Section sources**
- [attachment.ts:63-68](file://src/api/attachment.ts#L63-L68)
- [attachments.ts:30-35](file://src/trash/attachments.ts#L30-L35)

#### 5. 图片类型识别失败

**症状**：图片文件被当作普通文件下载，而非内联显示

**可能原因**：
- 文件格式不受支持（仅支持 PNG、JPEG、GIF、WebP）
- 文件头部损坏，魔数不匹配
- 文件实际上是其他格式但扩展名为图片

**解决方案**：
1. 检查文件实际格式是否在支持列表中
2. 使用十六进制编辑器检查文件开头的魔数
3. 确认文件未损坏
4. 如果是其他图片格式（如 BMP、TIFF），目前不支持内联显示

**注意**：这是预期行为，系统故意不依赖文件扩展名或请求参数，而是通过魔数识别，以确保安全性。

**Section sources**
- [attachment.ts:22-32](file://src/api/attachment.ts#L22-L32)
- [attachment.ts:90-105](file://src/api/attachment.ts#L90-L105)

### 调试技巧

#### 启用详细日志

在开发环境中，可以通过以下方式获取更多信息：

1. **服务器端日志**：检查 Node.js 进程的 stdout/stderr，寻找 `verbError` 和 `routeError` 的记录
2. **浏览器开发者工具**：
   - Network 面板：查看请求 URL、响应头、响应体
   - Console 面板：查看 JavaScript 错误和警告
3. **文件系统检查**：直接访问 `$DSH_HOME/attachments/v1/objects/` 目录，验证文件存在性和权限

#### 测试用例参考

项目包含全面的测试用例，可作为调试参考：

- `tests/attachments.test.ts`：附件模块的单元测试
- `tests/api.test.ts`：API 端点的集成测试
- `tests/client/attachment-view.test.tsx`：客户端组件的测试

这些测试用例展示了各种边界情况和错误场景的处理方式。

**Section sources**
- [tests/attachments.test.ts:1-691](file://tests/attachments.test.ts#L1-L691)

## 结论

`GET /attachment` 端点是回收站插件中关键的二进制响应组件，专为安全地提供附件内容而设计。通过严格的内容寻址机制、多重安全验证和智能的类型识别，该端点在保障系统安全的同时提供了良好的用户体验。

### 核心特性总结

1. **安全寻址**：仅接受 SHA-256 ID，路径完全由服务端推导，杜绝路径遍历攻击
2. **类型隔离**：kind 参数严格限制为 image 或 file，对应不同的存储目录
3. **智能识别**：通过魔数识别图片格式，不依赖不可信的外部信息
4. **大小限制**：双重检查机制确保单文件不超过 20 MiB，防止内存耗尽
5. **容错设计**：失败时返回 JSON 信封，图片加载失败显示友好占位符
6. **并发处理**：标记为 pure 模式，不阻塞其他操作，提升响应速度

### 设计哲学

该端点体现了以下设计原则：

- **Fail-safe**：宁可拒绝可疑请求，也不冒险允许潜在危险操作
- **Defense in depth**：多层验证机制，即使某一层失效仍有其他保护
- **Explicit over implicit**：明确声明类型和意图，不依赖隐式推断
- **User-friendly errors**：错误消息清晰明了，帮助用户理解问题和采取下一步行动

### 未来改进方向

虽然当前实现已经相当完善，但仍有一些潜在的改进空间：

1. **流式响应**：对于接近上限的大文件，可考虑使用流式传输减少内存占用
2. **缓存策略**：在确保安全的前提下，为频繁访问的附件添加短期缓存
3. **批量预取**：支持一次性获取多个附件的元数据，减少往返次数
4. **更多图片格式**：扩展魔数识别支持更多图片格式（如 AVIF、HEIC）
5. **缩略图生成**：服务端生成缩略图，减少客户端带宽消耗

该端点的设计和实施为类似的文件服务场景提供了良好的参考范例，特别是在安全性和用户体验之间取得平衡方面。

[No sources needed since this section summarizes without analyzing specific files]