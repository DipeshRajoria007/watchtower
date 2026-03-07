import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from 'sonner';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Toaster
      closeButton
      expand
      position="top-right"
      toastOptions={{
        classNames: {
          closeButton: 'watchtower-toast-close',
          description: 'watchtower-toast-description',
          title: 'watchtower-toast-title',
          toast: 'watchtower-toast',
        },
        duration: 6000,
      }}
      visibleToasts={4}
    />
    <App />
  </React.StrictMode>,
);
