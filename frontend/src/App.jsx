import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { ConnectionProvider } from './context/ConnectionContext'
import { ToastProvider } from './components/ui/toast'
import ProtectedRoute from './components/ProtectedRoute'
import Login from './pages/Login'
import Reproduce from './pages/Reproduce'
import Case from './pages/Case'
import Company from './pages/Company'
import Onboarding from './pages/Onboarding'
import Settings from './pages/Settings'
import AuditLog from './pages/AuditLog'
import EntityExplorer from './pages/EntityExplorer'
import Checkpoints from './pages/Checkpoints'
import IssuePacks from './pages/IssuePacks'
import LabTools from './pages/LabTools'
import AICommandCenter from './pages/AICommandCenter'

export default function App() {
  return (
    <AuthProvider>
      <ConnectionProvider>
      <ToastProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<ProtectedRoute><Reproduce /></ProtectedRoute>} />
        <Route path="/cases/:id" element={<ProtectedRoute><Case /></ProtectedRoute>} />
        <Route path="/company" element={<ProtectedRoute><Company /></ProtectedRoute>} />
        <Route path="/dashboard" element={<Navigate to="/company" replace />} />
        <Route
          path="/onboarding"
          element={
            <ProtectedRoute>
              <Onboarding />
            </ProtectedRoute>
          }
        />
        <Route
          path="/explorer"
          element={
            <ProtectedRoute>
              <EntityExplorer />
            </ProtectedRoute>
          }
        />
        <Route
          path="/checkpoints"
          element={
            <ProtectedRoute>
              <Checkpoints />
            </ProtectedRoute>
          }
        />
        <Route
          path="/issuepacks"
          element={
            <ProtectedRoute>
              <IssuePacks />
            </ProtectedRoute>
          }
        />
        <Route
          path="/lab"
          element={
            <ProtectedRoute>
              <LabTools />
            </ProtectedRoute>
          }
        />
        <Route
          path="/ai"
          element={
            <ProtectedRoute>
              <AICommandCenter />
            </ProtectedRoute>
          }
        />
        <Route
          path="/ai/session/:id"
          element={
            <ProtectedRoute>
              <AICommandCenter />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <Settings />
            </ProtectedRoute>
          }
        />
        <Route
          path="/audit"
          element={
            <ProtectedRoute>
              <AuditLog />
            </ProtectedRoute>
          }
        />
      </Routes>
      </ToastProvider>
      </ConnectionProvider>
    </AuthProvider>
  )
}
