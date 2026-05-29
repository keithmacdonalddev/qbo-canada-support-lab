import { Routes, Route } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { ToastProvider } from './components/ui/toast'
import ProtectedRoute from './components/ProtectedRoute'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
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
      <ToastProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
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
    </AuthProvider>
  )
}
