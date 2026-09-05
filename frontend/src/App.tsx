import { Navigate, Route, Routes } from "react-router-dom";
import { VoiceInterface } from "./pages/VoiceInterface";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<VoiceInterface />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
