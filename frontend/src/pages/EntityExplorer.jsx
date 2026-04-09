import { useState } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'

const ENTITY_TYPES = [
  'Customer', 'Invoice', 'Payment', 'CreditMemo',
  'Bill', 'BillPayment', 'VendorCredit', 'Vendor',
  'Item', 'Account', 'JournalEntry', 'Estimate', 'Deposit',
]

function getDisplayColumns(type) {
  switch (type) {
    case 'Customer':
    case 'Vendor':
      return ['Id', 'DisplayName', 'Balance', 'Active']
    case 'Invoice':
    case 'Bill':
      return ['Id', 'DocNumber', 'TotalAmt', 'Balance', 'TxnDate']
    case 'Payment':
    case 'BillPayment':
      return ['Id', 'TotalAmt', 'TxnDate']
    case 'CreditMemo':
    case 'VendorCredit':
      return ['Id', 'DocNumber', 'TotalAmt', 'TxnDate']
    case 'Item':
      return ['Id', 'Name', 'Type', 'UnitPrice', 'Active']
    case 'Account':
      return ['Id', 'Name', 'AccountType', 'CurrentBalance']
    case 'JournalEntry':
    case 'Estimate':
    case 'Deposit':
      return ['Id', 'DocNumber', 'TotalAmt', 'TxnDate']
    default:
      return ['Id']
  }
}

function getCellValue(record, col) {
  const val = record[col]
  if (val === undefined || val === null) return '-'
  if (typeof val === 'boolean') return val ? 'Yes' : 'No'
  return String(val)
}

export default function EntityExplorer() {
  const [entityType, setEntityType] = useState('Customer')
  const [searchQuery, setSearchQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectedRecord, setSelectedRecord] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [chain, setChain] = useState(null)
  const [chainLoading, setChainLoading] = useState(false)

  const handleSearch = async () => {
    setLoading(true)
    setSelectedRecord(null)
    setChain(null)
    try {
      const params = { type: entityType }
      if (searchQuery.trim()) params.q = searchQuery.trim()
      const res = await client.get('/explore/search', { params })
      setResults(res.data.records || [])
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  const handleSelectRecord = async (record) => {
    setDetailLoading(true)
    setChain(null)
    try {
      const res = await client.get(`/explore/${entityType.toLowerCase()}/${record.Id}`)
      setSelectedRecord(res.data.record)
    } catch {
      setSelectedRecord(record)
    } finally {
      setDetailLoading(false)
    }
  }

  const handleTraceChain = async () => {
    if (!selectedRecord) return
    setChainLoading(true)
    try {
      const res = await client.get(`/explore/${entityType.toLowerCase()}/${selectedRecord.Id}/chain`)
      setChain(res.data)
    } catch {
      setChain(null)
    } finally {
      setChainLoading(false)
    }
  }

  const columns = getDisplayColumns(entityType)

  return (
    <Layout>
      <div>
        <h1 className="text-[22px] font-semibold text-[var(--text-heading)] mb-2">Entity Explorer</h1>
        <p className="text-sm text-[#6B7280] mb-6">
          An entity is any record in QuickBooks — a customer, an invoice, a payment, a bill, a vendor, an item, an account, etc. This page lets you search and inspect those records live from your connected QBO company. Pick a type (e.g., Invoice), search, and click a result to see every field QBO stores on it. Use "Trace Chain" to follow the links between related records — for example, starting from an invoice you can see the payment that paid it and the credit memo that adjusted it. In QBO, these linked records form chains: an AR chain (invoice → payment → credit memo) tracks money a customer owes you, and an AP chain (bill → bill payment → vendor credit) tracks money you owe a vendor. This is how you investigate problems: when an issue pack creates a mismatched payment, you come here to find it, read the details, and trace what's connected to what.
        </p>

        <Card className="shadow-sm mb-6">
          <CardContent className="pt-5">
            <div className="flex items-end gap-3">
              <div>
                <label className="text-xs font-medium text-[#6B7280] uppercase tracking-wide mb-1 block">Entity Type</label>
                <select
                  value={entityType}
                  onChange={(e) => setEntityType(e.target.value)}
                  className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                >
                  {ENTITY_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <label className="text-xs font-medium text-[#6B7280] uppercase tracking-wide mb-1 block">Search</label>
                <Input
                  placeholder="Search by name or doc number..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                />
              </div>
              <Button onClick={handleSearch} disabled={loading}>
                {loading ? 'Searching...' : 'Search'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-[1fr_400px] gap-6">
          <div>
            {results.length > 0 ? (
              <Card className="shadow-sm">
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {columns.map((col) => (
                          <TableHead key={col}>{col}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {results.map((record) => (
                        <TableRow
                          key={record.Id}
                          className={`cursor-pointer ${selectedRecord?.Id === record.Id ? 'bg-muted' : ''}`}
                          onClick={() => handleSelectRecord(record)}
                        >
                          {columns.map((col) => (
                            <TableCell key={col}>{getCellValue(record, col)}</TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ) : !loading ? (
              <p className="text-[#6B7280] text-sm">Search for entities to explore.</p>
            ) : null}
          </div>

          <div>
            {detailLoading ? (
              <p className="text-[#6B7280] text-sm">Loading detail...</p>
            ) : selectedRecord ? (
              <Card className="shadow-sm">
                <CardContent className="pt-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-[var(--text-heading)]">
                      {entityType} #{selectedRecord.Id}
                    </h3>
                    <Button size="sm" variant="outline" onClick={handleTraceChain} disabled={chainLoading}>
                      {chainLoading ? 'Tracing...' : 'Trace Chain'}
                    </Button>
                  </div>
                  <div className="space-y-1.5 max-h-[400px] overflow-y-auto text-sm">
                    {Object.entries(selectedRecord)
                      .filter(([key]) => key !== 'MetaData')
                      .map(([key, val]) => (
                        <div key={key} className="flex gap-2">
                          <span className="font-medium text-[#6B7280] min-w-[140px] shrink-0">{key}:</span>
                          <span className="text-[var(--text-heading)] break-all">
                            {typeof val === 'object' ? JSON.stringify(val) : String(val ?? '-')}
                          </span>
                        </div>
                      ))}
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {chain && (
              <Card className="shadow-sm mt-4">
                <CardContent className="pt-5">
                  <h3 className="font-semibold text-[var(--text-heading)] mb-3">Transaction Chain</h3>
                  <div className="space-y-2">
                    {chain.nodes.map((node, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Badge variant={node.error ? 'destructive' : 'secondary'}>
                          {node.entity}
                        </Badge>
                        <span className="text-sm text-[var(--text-heading)]">
                          #{node.id}
                          {node.data?.TotalAmt != null && ` — $${node.data.TotalAmt}`}
                          {node.data?.TxnDate && ` (${node.data.TxnDate})`}
                        </span>
                        {node.error && (
                          <span className="text-xs text-[var(--danger)]">{node.error}</span>
                        )}
                      </div>
                    ))}
                    {chain.edges.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-[var(--border)]">
                        <p className="text-xs text-[#6B7280] mb-1">Links:</p>
                        {chain.edges.map((edge, i) => (
                          <p key={i} className="text-xs text-[#6B7280]">
                            {edge.from} → {edge.to}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </Layout>
  )
}
