/**
 * VentoDocs UI Kit（M5 去 antd）：按钮/输入/弹窗/标签页/开关等，全部走 .vd-* CSS 类。
 */
import { useEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

/* ---------- 按钮 ---------- */

type BtnVariant = 'default' | 'primary' | 'danger' | 'ghost'
type BtnSize = 'md' | 'sm' | 'xs'

const BTN_CLASS: Record<BtnVariant, string> = {
  default: 'vd-btn',
  primary: 'vd-btn vd-btn-primary',
  danger: 'vd-btn vd-btn-danger',
  ghost: 'vd-btn vd-btn-ghost',
}

export function Btn({
  variant = 'default',
  size = 'md',
  className = '',
  loading = false,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: BtnSize; loading?: boolean }) {
  const sizeCls = size === 'sm' ? ' vd-btn-sm' : size === 'xs' ? ' vd-btn-xs' : ''
  return (
    <button
      type="button"
      className={`${BTN_CLASS[variant]}${sizeCls} ${className}`.trim()}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {loading ? (
        <span
          className="vd-spin"
          style={{ width: 12, height: 12, display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }}
        />
      ) : null}
      {children}
    </button>
  )
}

export function IconBtn({
  className = '',
  danger = false,
  small = false,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean; small?: boolean }) {
  const cls = ['vd-icon-btn', danger ? 'danger' : '', small ? 'sm' : '', className].filter(Boolean).join(' ')
  return <button type="button" className={cls} {...rest} />
}

/* ---------- 输入 ---------- */

export function Input({ className = '', size, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & { size?: 'sm' }) {
  return <input className={`vd-input ${size === 'sm' ? 'sm' : ''} ${className}`} {...rest} />
}

export function TextArea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`vd-input ${className}`} {...rest} />
}

export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`vd-input ${className}`} {...rest}>
      {children}
    </select>
  )
}

export function Field({ label, required = false, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <div className="vd-field">
      <span className="vd-field-label">
        {required ? <b>*</b> : null}
        {label}
      </span>
      {children}
    </div>
  )
}

/* ---------- 标签页 / 分段 ---------- */

export function Tabs({
  items,
  active,
  onChange,
}: {
  items: { key: string; label: string }[]
  active: string
  onChange: (key: string) => void
}) {
  return (
    <div className="vd-tabs" role="tablist">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="tab"
          aria-selected={active === it.key}
          className={`vd-tab ${active === it.key ? 'on' : ''}`}
          onClick={() => onChange(it.key)}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

export function Seg({
  options,
  value,
  onChange,
}: {
  options: { key: string; label: string }[]
  value: string
  onChange: (key: string) => void
}) {
  return (
    <div className="vd-seg" role="group">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`vd-seg-item ${value === o.key ? 'on' : ''}`}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ---------- 开关 / 标签 / 空态 / 加载 ---------- */

export function Switch({ checked, onChange, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`vd-switch ${checked ? 'on' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span className="vd-switch-knob" />
    </button>
  )
}

export function Tag({ color, children }: { color?: 'blue' | 'green' | 'red' | 'gray'; children: ReactNode }) {
  const cls = color ? `vd-tag vd-tag-${color}` : 'vd-tag'
  return <span className={cls}>{children}</span>
}

export function Empty({ icon, text, sub }: { icon?: ReactNode; text: string; sub?: string }) {
  return (
    <div className="vd-empty">
      {icon}
      <div>{text}</div>
      {sub ? <div className="vd-faint" style={{ fontSize: 12 }}>{sub}</div> : null}
    </div>
  )
}

export function Spin({ large = false, text }: { large?: boolean; text?: string }) {
  return (
    <div className="vd-flex-center" style={{ padding: '40px 16px' }}>
      <div className={`vd-spin ${large ? 'lg' : ''}`} />
      {text ? <span className="vd-faint" style={{ marginLeft: 10, fontSize: 12.5 }}>{text}</span> : null}
    </div>
  )
}

/* ---------- 弹窗 ---------- */

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 420,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="vd-modal-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panelRef} className="vd-modal" style={{ width }}>
        <div className="vd-modal-head">
          <span className="vd-modal-title">{title}</span>
          <IconBtn small aria-label="关闭" onClick={onClose}>
            ✕
          </IconBtn>
        </div>
        <div className="vd-modal-body">{children}</div>
        {footer ? <div className="vd-modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

/* ---------- 下拉菜单（顶栏/行内） ---------- */

export interface DropItem {
  key: string
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
  divider?: boolean
}

export function Dropdown({
  button,
  items,
  align = 'right',
  width = 180,
  label,
}: {
  button?: ReactNode
  items: DropItem[]
  align?: 'left' | 'right'
  width?: number
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLDivElement>(null)

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      const left = align === 'right' ? Math.max(4, r.right - width) : r.left
      setPos({ top: r.bottom + 6, left })
    }
    setOpen((v) => !v)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (btnRef.current && !btnRef.current.contains(e.target as Node) && !pos) setOpen(false)
      if (btnRef.current && btnRef.current.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, pos])

  const pick = (it: DropItem) => {
    if (it.disabled || 'divider' in it) return
    setOpen(false)
    it.onClick?.()
  }

  return (
    <div ref={btnRef} style={{ position: 'relative' }}>
      <span onClick={toggle} style={{ display: 'inline-flex', cursor: 'pointer' }}>
        {button ?? <span className="vd-tb-btn" style={{ width: 'auto' }}>{label ?? '⋮'}</span>}
      </span>
      {open && pos ? (
        <div className="vd-tb-menu" style={{ top: pos.top, left: pos.left, minWidth: width }}>
          {items.map((it, i) =>
            'divider' in it ? (
              <div key={i} className="vd-tb-menu-div" />
            ) : (
              <button
                key={it.key}
                type="button"
                className={`vd-tb-menu-item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}`}
                onClick={() => pick(it)}
              >
                {it.icon}
                <span>{it.label}</span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  )
}

/* ---------- 抽屉 ---------- */

export function Drawer({
  open,
  title,
  onClose,
  children,
  width = 560,
}: {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  width?: number
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="vd-drawer-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="vd-drawer" style={{ width }}>
        <div className="vd-drawer-head">
          <span className="vd-drawer-title">{title}</span>
          <IconBtn small aria-label="关闭" onClick={onClose}>
            ✕
          </IconBtn>
        </div>
        <div className="vd-drawer-body">{children}</div>
      </div>
    </div>
  )
}
