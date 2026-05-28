# QBO Support Lab Frontend

This is the Vite/React frontend for the QBO Canada Support Lab.

## Purpose

The frontend provides the protected product surfaces for one connected QBO company:

- dashboard and company status
- onboarding and QBO connection flow
- entity explorer
- checkpoints and diffs
- issue pack catalog and run history
- AI command center
- settings and audit log

Failed loads and QBO/AI errors surface to the user through toast and inline-alert components rather than being swallowed; failed loads expose retry affordances, and AI plan approve/reject/execute failures are reported inline.

## Stack

- Vite
- React 19
- React Router
- Axios API client
- Tailwind CSS/shadcn-style local UI primitives, including `src/components/ui/toast.jsx` and `src/components/ui/alert.jsx` for error and retry surfaces
- Lucide icons

## Commands

Run from the repo root:

```powershell
npm run build --workspace=frontend
npm run lint --workspace=frontend
npm run dev --workspace=frontend
```

`dev` starts a long-running Vite server. Only run it when you intentionally want the local UI server.

## Current Verification

As of 2026-05-28:

- `npm run build --workspace=frontend` passes.
- `npm run lint --workspace=frontend` fails on current AI UI lint debt:
  - unused `sessionId` in `src/components/ai/ChatPanel.jsx`
  - unused `cn` imports in `src/components/ai/SupportNote.jsx` and `src/pages/AICommandCenter.jsx`
  - React hook dependency warnings in `src/pages/AICommandCenter.jsx`

## API Boundary

The frontend talks to the backend through `src/api/client.js`. Do not store permanent QBO tokens, Anthropic keys, OpenAI keys, or JWT secrets in frontend code.

QBO upstream failures arrive from the backend as HTTP `502` responses (QBO `429` rate limits pass through as `429`) with an `intuit_tid` trace id in the response body. The UI reads `err.response?.data?.error` and surfaces it through the toast/alert components.
