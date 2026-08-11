// Import React's development-time safety wrapper; it intentionally double-runs
// some lifecycle paths so accidental side effects are easier to detect.
import { StrictMode } from 'react'
// Import the React 18+ root API used by Vite React apps.
import { createRoot } from 'react-dom/client'
// Load the global CSS baseline and Tailwind utility generator before rendering
// any component that uses utility class names.
import './index.css'
// AuthGate owns the app's one auth check and renders the Login screen or
// App accordingly (see src/auth/AuthGate.jsx) — App itself no longer
// mounts directly here, so every render of this app goes through auth
// first, matching the Research Database System's own "the app now begins
// with a Login screen" requirement.
import AuthGate from './auth/AuthGate.jsx'

// Find the DOM node supplied by index.html and attach the React tree to it.
createRoot(document.getElementById('root')).render(
  // Keep StrictMode at the root so every child benefits from React checks.
  <StrictMode>
    <AuthGate />
  </StrictMode>,
)
