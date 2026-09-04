import { Navigate, Route, Routes } from 'react-router-dom';
import { DialoguePage } from './pages/DialoguePage';
import { HomePage } from './pages/HomePage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/apps/dialogue" element={<DialoguePage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
