import { Navigate, Route, Routes } from "react-router-dom";
import { VoiceInterface } from "./pages/VoiceInterface";
import { RobotConsolePage } from "./pages/RobotConsolePage";
import { HomePage } from "./pages/HomePage";
import { DialoguePage } from "./pages/DialoguePage";
import "./styles.css";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<RobotConsolePage />} />
      <Route path="/apps" element={<HomePage />} />
      <Route path="/apps/robot" element={<RobotConsolePage />} />
      <Route path="/apps/dialogue" element={<DialoguePage />} />
      <Route path="/voice" element={<VoiceInterface />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
