/**
 * 插件设置页的「可调项」卡：三只数字输入 + 保存（ADR-0043；ADR-0037 留下的「自绘表单」那条路）。
 *
 * 为什么自绘而不是等宿主投影：`Config` 是手写 Standard Schema，宿主的字段投影只认 native
 * Schemastery（ADR-0037 的实测）；把宿主 schema 库值 import 进本插件会破「跨插件一律 import type」。
 * 所以这里画三个输入，保存走 `/config` 的写支（`configEditor.edit`）。写会让 **Node 半**
 * 这一行重启；浏览器半不随之卸载，卡片用保存回执回填，重开插件页 / 刷新页面才会重新读一次。
 * `config.saved` 只说明"这一轮已经交出去"，不是"页面完成了一次重新读取"。
 *
 * 表单只做本地校验（`CONFIG_LIMITS` 与 Node 半归一同一格）；服务端的 400 / io 原文在状态行上屏，
 * 不吞、不改写。读与写都只在用户动作或挂载时发生，没有定时器。
 */
import { useEffect, useId, useState } from 'react'
import type { ReactElement } from 'react'
import { CONFIG_LIMITS, type SessionDeleteConfigWire } from '../shared/wire.js'
import { zhTranslate, type CopyKey, type Translate } from './copy.js'
import type { ConfigDeps } from './remote.js'
import { settingsCardShell } from './settings-view.js'
import { Button } from './ui/Button.js'

/** 卡片外壳：与「维护」卡同款，只差本卡的内容节奏。 */
const CARD_SHELL = settingsCardShell(14)

type FieldKey = keyof SessionDeleteConfigWire
/** 三个字段的顺序、文案与单位：键名与线上契约同字，顺序就是表单从上到下的顺序。 */
const FIELDS: readonly { readonly key: FieldKey; readonly label: CopyKey; readonly unit: CopyKey }[] = [
  { key: 'orphanPreviewLimit', label: 'config.orphanPreviewLimit', unit: 'config.unit.items' },
  { key: 'maxAttachmentBytes', label: 'config.maxAttachmentBytes', unit: 'config.unit.bytes' },
  { key: 'maxJsonRefBytes', label: 'config.maxJsonRefBytes', unit: 'config.unit.bytes' },
]

type Draft = Record<FieldKey, string>
type Parsed = { readonly ok: true; readonly value: SessionDeleteConfigWire } | { readonly ok: false; readonly bad: FieldKey | null }

function draftOf(config: SessionDeleteConfigWire): Draft {
  return {
    orphanPreviewLimit: String(config.orphanPreviewLimit),
    maxAttachmentBytes: String(config.maxAttachmentBytes),
    maxJsonRefBytes: String(config.maxJsonRefBytes),
  }
}

/** 空串 / 小数 / 越界都是同一句「需为 min–max 的整数」；第一个不合格的字段决定报在哪一行。 */
function parseDraft(draft: Draft): Parsed {
  const value: SessionDeleteConfigWire = { orphanPreviewLimit: 0, maxAttachmentBytes: 0, maxJsonRefBytes: 0 }
  for (const { key } of FIELDS) {
    const raw = draft[key].trim()
    const parsed = raw === '' ? Number.NaN : Number(raw)
    const { min, max } = CONFIG_LIMITS[key]
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) return { ok: false, bad: key }
    value[key] = parsed
  }
  return { ok: true, value }
}

interface ConfigCardProps {
  readonly config: ConfigDeps['config']
  readonly saveConfig: ConfigDeps['saveConfig']
  readonly t: Translate
}

function ConfigCard({ config, saveConfig, t }: ConfigCardProps): ReactElement {
  const idPrefix = useId()
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [current, setCurrent] = useState<SessionDeleteConfigWire | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    setPhase('loading')
    setFailure(null)
    setSaved(false)
    void config()
      .then((value) => {
        if (!alive) return
        setCurrent(value)
        setDraft(draftOf(value))
        setPhase('ready')
      })
      .catch((error: unknown) => {
        if (!alive) return
        setPhase('failed')
        setFailure(error instanceof Error ? error.message : String(error))
      })
    return () => {
      alive = false
    }
  }, [config, reload])

  const parsed: Parsed = draft === null ? { ok: false, bad: null } : parseDraft(draft)
  const dirty = current !== null && parsed.ok && FIELDS.some(({ key }) => parsed.value[key] !== current[key])

  const submit = (): void => {
    // 表单回车绕得过禁用按钮：在飞时再提交一次是同一组值写两遍，没改动时提交也会白重启
    // 这一行；两种都先挡住。
    if (saving || !parsed.ok || !dirty) return
    setSaving(true)
    setFailure(null)
    setSaved(false)
    void saveConfig(parsed.value)
      .then((value) => {
        setCurrent(value)
        setDraft(draftOf(value))
        setSaved(true)
      })
      .catch((error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        setSaving(false)
      })
  }

  if (phase === 'loading') {
    return <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)' }}>{t('config.loading')}</div>
  }
  if (phase === 'failed') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div role="alert" style={{ fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-state-error-primary)' }}>
          {t('config.loadFailed', { message: failure ?? '' })}
        </div>
        <div>
          <Button variant="outline" size="sm" onClick={() => { setReload((n) => n + 1) }}>
            {t('config.retry')}
          </Button>
        </div>
      </div>
    )
  }

  const status = failure !== null
    ? t('config.saveFailed', { message: failure })
    : saved
      ? t('config.saved')
      : !parsed.ok || dirty ? '' : t('config.unchanged')

  return (
    <form
      aria-busy={saving}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      {FIELDS.map(({ key, label, unit }) => {
        const { min, max } = CONFIG_LIMITS[key]
        const id = `${idPrefix}-${key}`
        const bad = !parsed.ok && parsed.bad === key
        return (
          <div key={key} data-dsh-session-delete={`config-${key}`} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <label htmlFor={id} style={{ flex: '1 1 220px', fontSize: 13, lineHeight: '19px' }}>{t(label)}</label>
              <input
                id={id}
                className="sd-config-input"
                type="number"
                inputMode="numeric"
                step={1}
                min={min}
                max={max}
                disabled={saving}
                value={draft?.[key] ?? ''}
                aria-invalid={bad || undefined}
                onChange={(event) => {
                  const next = event.target.value
                  setDraft((old) => old === null ? old : { ...old, [key]: next })
                  setSaved(false)
                  setFailure(null)
                }}
              />
              <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)' }}>{t(unit)}</span>
            </div>
            {bad ? (
              <div role="alert" style={{ fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-state-error-primary)' }}>
                {t('config.invalid', { min, max })}
              </div>
            ) : null}
          </div>
        )
      })}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Button variant="primary" size="sm" type="submit" disabled={!parsed.ok || !dirty || saving}>
          {saving ? t('config.saving') : t('config.save')}
        </Button>
        <span role="status" style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)' }}>{status}</span>
      </div>
    </form>
  )
}

export interface ConfigSettingsProps {
  /** 整套 remote 的切片；测试可以只给维护那四件（缺这两件时本卡不渲染）。 */
  readonly deps: Partial<ConfigDeps>
  readonly t?: Translate
}

/**
 * 卡片入口：两个方法都在才渲染。`useMaintenance` 与 `MaintenanceSettings` 的测试替身只造维护四件，
 * 所以在那些用例里本卡整体缺席——不让"没给配置 deps"变成一次假渲染。
 */
export function ConfigSettings({ deps, t = zhTranslate }: ConfigSettingsProps): ReactElement | null {
  const config = deps.config
  const saveConfig = deps.saveConfig
  if (config === undefined || saveConfig === undefined) return null
  return (
    <div data-dsh-session-delete="config-card" style={CARD_SHELL}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ fontSize: 16, fontWeight: 600, lineHeight: '24px' }}>{t('config.title')}</div>
        <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)' }}>{t('config.hint')}</div>
      </div>
      <ConfigCard config={config} saveConfig={saveConfig} t={t} />
    </div>
  )
}
