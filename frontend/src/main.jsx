import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { getCurrentWindow } from '@tauri-apps/api/window'
import './index.css'
import App from './App.jsx'
import Home from './Home.jsx'

// Both windows load this entry. Only the assistant overlay may run the voice
// pipeline; a second copy in the main window fights it for the microphone.
const isOverlay = getCurrentWindow().label === 'assistant'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isOverlay ? <App /> : <Home />}
  </StrictMode>,
)
