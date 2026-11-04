/**
 * dsh-session-opentool — Client half.
 *
 * Adds two rows to a Session's "⋯" menu, after the shipped pin / rename / fork /
 * archive / session-id rows and after the community delete (500) and move (510)
 * rows:
 *
 *   "打开所在文件夹"      — the Session's working directory (`header.cwd`).
 *   "打开会话记录位置"    — the folder holding its stored log.
 *
 * The click itself only names a Session and which folder; the Host half resolves
 * the real path and hands it to the system file manager. A refusal is shown as a
 * short-lived toast, because the menu is already closed by then.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-opentool',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useRef } = React

    const SLOT = 'sidebar.workspaces.session.menu.item'
    const BASE = '/dsh-session-opentool'
    const STYLE_ID = 'dsh-session-opentool-style'
    const TOAST_ID = 'dsh-session-opentool-toast'

    // The shipped menu row, the same primitive the built-in pin / rename / fork /
    // archive rows use: it owns the row's pointer and keyboard semantics, so this
    // plugin never has to guess how the menu delivers a selection.
    let MenuItemButton = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      if (typeof primitives?.MenuItemButton === 'function') MenuItemButton = primitives.MenuItemButton
    } catch {
      // A build without that module keeps the fallback row drawn below.
    }

    // The rows match the shipped rows (`MenuItemButton` in ui-primitives) and the
    // community delete / move rows: 34px tall, 6px gap, 8px radius, 13px/20px
    // text, the icon inheriting the row colour, and hover drawn as a background
    // rather than an outline. Only the toast below is drawn from scratch.
    const CSS = `
.dso-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;color:inherit;font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.dso-item:hover,.dso-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));outline:none}
.dso-itemIcon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center}
.dso-itemLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dso-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:10000;box-sizing:border-box;max-width:min(560px,calc(100vw - 40px));padding:9px 14px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,#1b1d21);color:var(--dsw-alias-label-primary,#e6e8eb);box-shadow:0 12px 32px rgba(0,0,0,.4);font-size:13px;line-height:18px;word-break:break-word;pointer-events:none}
.dso-toast[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#e5484d)}
`

    /** One 17px folder glyph in the menu icon's colour. */
    function folderIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 17,
          height: 17,
          fill: 'none',
          shapeRendering: 'geometricPrecision',
          'aria-hidden': true,
        },
        h('path', {
          d: 'M2.2 5.2a.9.9 0 0 1 .9-.9h3.6l1.2 1.6h5a.9.9 0 0 1 .9.9v5.7a.9.9 0 0 1-.9.9H3.1a.9.9 0 0 1-.9-.9Z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
      )
    }

    /** One 17px "stored record" glyph: a page with a folded corner. */
    function logIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 17,
          height: 17,
          fill: 'none',
          shapeRendering: 'geometricPrecision',
          'aria-hidden': true,
        },
        h('path', {
          d: 'M4.2 2.6h4.4l3.2 3.2v7.6a.9.9 0 0 1-.9.9H4.2a.9.9 0 0 1-.9-.9V3.5a.9.9 0 0 1 .9-.9Z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M8.6 2.6v3.2h3.2',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M5.6 9.1h4.8M5.6 11.1h3',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
        }),
      )
    }

    // The stylesheet has to exist before the row renders, not on first use: as a
    // lazy side effect the menu row was a bare `<button>` with the browser's
    // default chrome until something else populated the sheet.
    /** Mount the stylesheet once per page. */
    function mountStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** Show one short-lived message at the bottom of the page. */
    function toast(message, tone) {
      mountStyle()
      const previous = document.getElementById(TOAST_ID)
      if (previous !== null) previous.remove()
      const node = document.createElement('div')
      node.id = TOAST_ID
      node.className = 'dso-toast'
      if (tone !== undefined) node.setAttribute('data-tone', tone)
      node.setAttribute('role', 'status')
      node.textContent = message
      document.body.appendChild(node)
      window.setTimeout(() => {
        if (node.isConnected) node.remove()
      }, 3200)
    }

    /** POST JSON, turning a refusal payload into a readable error. */
    async function callHost(path, init) {
      const response = await fetch(path, { cache: 'no-store', ...init })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`Host 返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (payload?.ok !== true) {
        throw new Error(
          typeof payload?.message === 'string' && payload.message !== ''
            ? payload.message
            : `请求失败（HTTP ${response.status}）`,
        )
      }
      return payload
    }

    /**
     * Build one menu row.
     * @param {{ id: string, order: number, label: string, icon: () => unknown, target: 'cwd' | 'session' }} spec - the row.
     */
    function createItem(spec) {
      /** The row: ask the Host to open one of this Session's folders. */
      function Item(props) {
        const { sessionId } = props
        const menuOpenState = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : null
        const setMenuOpen = Array.isArray(menuOpenState) ? menuOpenState[1] : null
        const firedRef = useRef(false)
        const fire = useCallback(() => {
          // A row can see both a pointer-down and a click; the request must leave
          // exactly once.
          if (firedRef.current) return
          firedRef.current = true
          // Close first: the file manager takes focus, and a menu left open over
          // the window would stay there with nothing to click.
          if (typeof setMenuOpen === 'function') setMenuOpen(false)
          void (async () => {
            try {
              console.debug('[dsh-session-opentool] click', { sessionId, target: spec.target })
              const payload = await callHost(`${BASE}/open`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId, target: spec.target }),
              })
              toast(`已打开：${typeof payload.path === 'string' ? payload.path : ''}`)
            } catch (error) {
              console.warn('[dsh-session-opentool] open failed', error)
              toast(error instanceof Error ? error.message : String(error), 'error')
            }
          })()
        }, [sessionId, setMenuOpen])
        if (MenuItemButton !== null) {
          return h(MenuItemButton, { icon: spec.icon(), onSelect: fire, children: spec.label })
        }
        return h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: 'dso-item',
            onPointerDown: fire,
            onClick: fire,
            children: [
              h('span', { className: 'dso-itemIcon', key: 'icon', children: spec.icon() }),
              h('span', { className: 'dso-itemLabel', key: 'label', children: spec.label }),
            ],
          },
        )
      }
      return { id: spec.id, order: spec.order, Component: Item }
    }

    const ITEMS = [
      createItem({ id: 'dsh-session-opentool-cwd', order: 520, label: '打开所在文件夹', icon: folderIcon, target: 'cwd' }),
      createItem({ id: 'dsh-session-opentool-session', order: 530, label: '打开会话记录位置', icon: logIcon, target: 'session' }),
    ]

    return {
      inject: ['slots'],
      apply(ctx) {
        mountStyle()
        for (const item of ITEMS) {
          ctx.slots.inject(SLOT, () =>
            ctx.slots.register({ name: SLOT, id: item.id, order: item.order }, item.Component),
          )
        }
      },
    }
  },
})
