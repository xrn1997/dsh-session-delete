/**
 * 一小段本地值形状 DSL：只服务 `shared/` 的线上成功值。
 * schema 同时给出运行期 `check` 与 `Infer` 类型，字段清单只写一次；不 import 宿主包。
 */

declare const SCHEMA_TYPE: unique symbol

/** 一枚形状：运行期判形与 TypeScript 类型都从它派生。 */
export interface ValueSchema<T> {
  readonly check: (value: unknown) => value is T
  /** 类型标记（运行期不存在）：`Infer` 从这里取 T。 */
  readonly [SCHEMA_TYPE]?: T
  /** 对象字段用：缺席也合法（`object` 的逐格检查据此跳过）。 */
  readonly optional?: boolean
}

export type Infer<S> = S extends ValueSchema<infer T> ? T : never

export interface OptionalSchema<T> extends ValueSchema<T | undefined> {
  readonly optional: true
}

export type SchemaShape = Readonly<Record<string, ValueSchema<unknown>>>

type RequiredKeys<S extends SchemaShape> = {
  [K in keyof S]-?: S[K] extends OptionalSchema<unknown> ? never : K
}[keyof S]

type OptionalKeys<S extends SchemaShape> = {
  [K in keyof S]-?: S[K] extends OptionalSchema<unknown> ? K : never
}[keyof S]

type InferOptional<S> = S extends OptionalSchema<infer T> ? T : never

/** 对象：必需键逐格校；可选键缺席跳过、在场仍校；未知键不拒（这一层只管已知格）。 */
export type ObjectOf<S extends SchemaShape> = {
  [K in RequiredKeys<S>]: Infer<S[K]>
} & {
  [K in OptionalKeys<S>]?: InferOptional<S[K]>
}

/** 只取几格：回执读落地 id 这类窄读从同一份字段表派生，不另抄一遍形状。 */
export type PickOf<S extends SchemaShape, K extends keyof S> = {
  [P in K as S[P] extends OptionalSchema<unknown> ? never : P]: Infer<S[P]>
} & {
  [P in K as S[P] extends OptionalSchema<unknown> ? P : never]?: InferOptional<S[P]>
}

/** 带字段表的对象 schema：`pick` 用它派生窄读，字段清单仍只住 {@link object} 的那一次声明。 */
export interface ObjectSchema<S extends SchemaShape> extends ValueSchema<ObjectOf<S>> {
  readonly shape: S
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function string(): ValueSchema<string> {
  return { check: (value): value is string => typeof value === 'string' }
}

/** 有限数字：`NaN` / `Infinity` 不是读数（与线上判形同一口径）。 */
export function finiteNumber(): ValueSchema<number> {
  return { check: (value): value is number => typeof value === 'number' && Number.isFinite(value) }
}

export function boolean(): ValueSchema<boolean> {
  return { check: (value): value is boolean => typeof value === 'boolean' }
}

export function optional<const T>(item: ValueSchema<T>): OptionalSchema<T> {
  return {
    optional: true,
    check: (value): value is T | undefined => value === undefined || item.check(value),
  }
}

export function literal<const T extends readonly (string | number | boolean | null)[]>(
  ...values: T
): ValueSchema<T[number]> {
  return { check: (value): value is T[number] => values.some((candidate) => Object.is(candidate, value)) }
}

export function union<const S extends readonly ValueSchema<unknown>[]>(
  ...schemas: S
): ValueSchema<Infer<S[number]>> {
  return { check: (value): value is Infer<S[number]> => schemas.some((schema) => schema.check(value)) }
}

export function nullable<const T>(schema: ValueSchema<T>): ValueSchema<T | null> {
  return union(schema, literal(null))
}

export function object<const S extends SchemaShape>(shape: S): ObjectSchema<S> {
  const fields: readonly (readonly [string, ValueSchema<unknown>])[] = Object.entries(shape)
  return {
    shape,
    check: (value): value is ObjectOf<S> => {
      if (!isRecord(value)) return false
      for (const [key, schema] of fields) {
        if (schema.optional === true && !(key in value)) continue
        if (!schema.check(value[key])) return false
      }
      return true
    },
  }
}

/** 从对象 schema 里只取几格：运行期只校那几格，类型也按那几格收窄。可选格缺席时把 `undefined`
 *  交回该格自己的 check（与 `object` 的「缺席跳过」等价，前提是缺席合法的格都用 {@link optional} 建）。 */
export function pick<const S extends SchemaShape, const K extends readonly (keyof S & string)[]>(
  schema: ObjectSchema<S>,
  ...keys: K
): ValueSchema<PickOf<S, K[number]>> {
  const fields: (readonly [string, ValueSchema<unknown>])[] = []
  for (const key of keys) {
    const field = schema.shape[key]
    if (field !== undefined) fields.push([key, field])
  }
  return {
    check: (value): value is PickOf<S, K[number]> => {
      if (!isRecord(value)) return false
      for (const [key, field] of fields) {
        if (!field.check(value[key])) return false
      }
      return true
    },
  }
}
