import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import Layout from '../components/Layout'
import BookEvidence from '../components/BookEvidence'
import { useConnection } from '../context/ConnectionContext'

// A focused report workflow does not load Company activity/counts/coverage.
// The report collector runs only after the operator chooses dates and checks.
export default function BookChecks() {
  const connection = useConnection()
  const status = connection?.status
  const scope = [status?.realmId, status?.connectionId, connection?.environment, connection?.ready].join(':')
  return <Layout><div className="mx-auto max-w-[1080px]">
    <Link to="/company" className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--ink-2)] hover:text-[var(--ink)]"><ArrowLeft className="size-3.5" /> Company</Link>
    <h1 className="mt-2 text-[22px] font-semibold text-[var(--ink)]">Book checks</h1>
    <p className="mt-1 text-[13.5px] text-[var(--ink-2)]">Choose a period and inspect the saved accounting story in the connected company.</p>
    <BookEvidence key={scope} realmId={status?.realmId} environment={connection?.environment} connectionId={status?.connectionId} enabled={connection?.ready === true} standalone />
  </div></Layout>
}
