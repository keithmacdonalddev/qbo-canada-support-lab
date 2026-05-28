---
paths:
  - "frontend/**"
---

# Frontend Rules

- Use React 19, Vite, ESM imports, and JSX.
- Keep routing in `frontend/src/App.jsx` and protected views behind `ProtectedRoute`.
- Use the existing API client in `frontend/src/api/client.js`.
- Do not store permanent QBO tokens, Anthropic keys, OpenAI keys, or JWT secrets in frontend code.
- Preserve the app's support-lab workflow posture: dashboard, onboarding, explorer, checkpoints, issue packs, audit, and AI command center are product surfaces, not marketing pages.
- Use existing UI primitives in `frontend/src/components/ui/` and lucide icons when appropriate.
- For verification, run `npm run build --workspace=frontend` and `npm run lint --workspace=frontend` when practical.
