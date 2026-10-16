import { Link } from 'react-router-dom'
import Layout from '../components/Layout'
import PeriodClose from '../components/PeriodClose'
import { useAuth } from '../context/AuthContext'
import { useConnection } from '../context/ConnectionContext'
export default function Reconciliation() {
  const { user } = useAuth(), connection = useConnection(), status = connection?.status
  const scope = [user?.id || user?._id, connection?.environment, status?.realmId, status?.connectionId, connection?.ready].join(':')
  return <Layout><div className="mx-auto max-w-[1160px]"><Link to="/reports" className="text-[13px] text-[var(--link)] underline">Reports</Link><h1 className="mt-2 text-[22px] font-semibold">Reconciliation and close</h1><p className="mt-1 mb-5 max-w-[90ch] text-[13.5px] text-[var(--ink-2)]">Keep dated manual evidence, protect accepted accounting periods, and review any reopening without losing the original decisions.</p><PeriodClose key={scope} enabled={connection?.ready === true} actorId={user?.id || user?._id} realmId={status?.realmId} environment={connection?.environment} connectionId={status?.connectionId} /></div></Layout>
}
