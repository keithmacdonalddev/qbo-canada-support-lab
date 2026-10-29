import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from './ui/button'

export default function CoverageDialog({ title, subtitle, children, onClose, focusKey }) {
  const dialogRef = useRef(null), headingRef = useRef(null)
  useEffect(() => {
    const dialog = dialogRef.current
    const opener = document.activeElement
    dialog.showModal()
    return () => {
      dialog.close()
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    dialogRef.current.scrollTop = 0
    headingRef.current?.focus({ preventScroll: true })
  }, [focusKey])
  return <dialog ref={dialogRef} className="coverage-dialog" aria-labelledby="coverage-detail-title" onCancel={event => { event.preventDefault(); onClose() }} onClick={event => {
    if (event.target !== event.currentTarget) return
    const box = event.currentTarget.getBoundingClientRect()
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose()
  }}>
    <header className="coverage-dialog-header"><div>{subtitle && <p className="coverage-eyebrow">{subtitle}</p>}<h2 ref={headingRef} tabIndex={-1} id="coverage-detail-title">{title}</h2></div><Button variant="ghost" size="icon" aria-label="Close details" onClick={onClose}><X /></Button></header>
    <div className="coverage-dialog-body">{children}</div>
  </dialog>
}
