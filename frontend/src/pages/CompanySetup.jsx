import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import Layout from '../components/Layout'
import BusinessSetup from '../components/BusinessSetup'
import { useConnection } from '../context/ConnectionContext'

export default function CompanySetup() {
  const connection = useConnection()
  const status = connection?.status
  const scope = [status?.realmId, status?.connectionId, connection?.environment, connection?.ready].join(':')
  return <Layout><div className="mx-auto max-w-[1080px]">
    <Link to="/company" className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--ink-2)] hover:text-[var(--ink)]"><ArrowLeft className="size-3.5" /> Company</Link>
    <h1 className="mt-2 text-[22px] font-semibold text-[var(--ink)]">Company preparation</h1>
    <p className="mt-1 text-[13.5px] text-[var(--ink-2)]">Review owner access, prepare the app for this company, and protect accounting periods before running business activity.</p>
    <BusinessSetup key={scope} enabled={connection?.ready === true} />
  </div></Layout>
}
