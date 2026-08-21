import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import FrozenCapture from './FrozenCapture.tsx'

const CAPTURE_OVERLAY_LABEL = 'capture-overlay'

const currentWindowLabel = (): string => {
  const metadata = (
    window as Window & {
      __TAURI_INTERNALS__?: { metadata?: { currentWebview?: { label?: string }; currentWindow?: { label?: string } } }
    }
  ).__TAURI_INTERNALS__?.metadata
  const fromTauri = metadata?.currentWebview?.label ?? metadata?.currentWindow?.label
  // Browser preview of the overlay via ?overlay=1
  const fromQuery = new URLSearchParams(window.location.search).get('overlay') === '1' ? CAPTURE_OVERLAY_LABEL : null
  return fromTauri ?? fromQuery ?? 'main'
}

const isOverlay = currentWindowLabel() === CAPTURE_OVERLAY_LABEL

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isOverlay ? <FrozenCapture /> : <App />}</StrictMode>,
)
