// Display formatting shared by Records, History and Settings.

export function money(amount, currency = 'CAD') {
  if (amount === undefined || amount === null || amount === '') return '—'
  const value = Number(amount)
  if (!Number.isFinite(value)) return String(amount)
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'CAD', currencyDisplay: 'narrowSymbol' }).format(value)
  } catch {
    return value.toFixed(2)
  }
}

// QuickBooks dates are plain YYYY-MM-DD; read them as local days so they
// never shift by a day across time zones.
function toDate(value) {
  if (!value) return null
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function shortDate(value) {
  const date = toDate(value)
  if (!date) return '—'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function dateTime(value) {
  const date = toDate(value)
  if (!date) return '—'
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function timeOfDay(value) {
  const date = toDate(value)
  if (!date) return ''
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function startOfDay(value) {
  const date = toDate(value)
  if (!date) return null
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

// "Today", "Yesterday", or a date, for grouping a feed by day.
export function dayLabel(value) {
  const day = startOfDay(value)
  if (!day) return 'Unknown date'
  const today = startOfDay(new Date())
  const diff = Math.round((today - day) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return day.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', ...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  })
}

export function daysUntil(value) {
  const day = startOfDay(value)
  if (!day) return null
  return Math.round((day - startOfDay(new Date())) / 86400000)
}

export function isPastDue(value) {
  const days = daysUntil(value)
  return days !== null && days < 0
}
