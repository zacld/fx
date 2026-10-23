import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import MovesApp from "./MovesApp.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <MovesApp />
  </StrictMode>
);
